"""
Native LLM + AI-config helper for the in-Splunk builder.

This replaces the Node engine's /api/ai/chat + /api/ai/config + /api/ai/models routes
with pure-Python implementations that read the UCC Configuration page's "AI Provider"
tab ([ai_provider] stanza, api_key decrypted via solnlib) and talk to the provider's
OpenAI-compatible Chat Completions API directly. Used by:
  * /api/ai/chat        - Expert-Expansion ("Review first") + inline completion
  * /api/ai/config      - the SPA's server-managed config (serverManaged / configuredModels)
  * /api/ai/models      - the Settings model picker
  * the native build-loop fixer (builder_build) for AppInspect auto-fixes

No Node sidecar; no streaming (a persistent REST handler buffers anyway, and the only
in-Splunk callers - expansion + completion - want a single completion).
"""
import json
import os
import ssl
import time
import urllib.error
import urllib.request

APP = "ucc_app_builder"
SETTINGS_CONF = APP + "_settings"
_UCC_REALM = "__REST_CREDENTIAL__#%s#configs/conf-%s" % (APP, SETTINGS_CONF)

DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4.6"
DEFAULT_COMPLETION_MODEL = "anthropic/claude-haiku-4.5"
_PROVIDER_BASE = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
}

# Model-picker shaping, mirroring server/services/openrouterModels.ts so the in-Splunk
# and Node backends hand the SPA the SAME entry shape.
_PROVIDER_ORDER = ["moonshotai", "anthropic", "openai", "google", "deepseek",
                   "mistralai", "meta-llama", "qwen", "x-ai"]
_MIN_CONTEXT = 32000
_MAX_MODELS = 60
# {provider: (fetched_at, models)} - the catalog moves slowly and a persistent REST
# handler is a long-lived process, so an in-process TTL cache is enough.
_MODELS_CACHE = {}
_MODELS_TTL = 3600.0


def _ca_bundle():
    ca = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "lib", "certifi", "cacert.pem")
    return ca if os.path.isfile(ca) else None


def _ssl_ctx():
    ca = _ca_bundle()
    return ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()


def read_ai_provider(session_key):
    """The UCC Configuration page [ai_provider] stanza (api_key decrypted). Returns {}
    on failure so callers degrade gracefully."""
    try:
        from solnlib import conf_manager
        cfm = conf_manager.ConfManager(session_key, APP, realm=_UCC_REALM)
        conf = cfm.get_conf(SETTINGS_CONF)
        return dict(conf.get("ai_provider") or {})
    except Exception:
        return {}


def provider_and_key(session_key, cfg=None):
    """Resolve (provider, base_url, api_key) from the AI Provider config (+ env fallback)."""
    cfg = read_ai_provider(session_key) if cfg is None else cfg
    provider = str(cfg.get("provider") or "openrouter").lower()
    base = (cfg.get("base_url") or "").strip().rstrip("/") or _PROVIDER_BASE.get(provider, _PROVIDER_BASE["openrouter"])
    key = (cfg.get("api_key") or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_APIKEY") or "").strip()
    return provider, base, key


def float_or_none(value):
    """Parse a conf string into a float, or None when unset/invalid (so the caller can
    fall back to its own default rather than sending a bogus temperature)."""
    try:
        s = str(value if value is not None else "").strip()
        return float(s) if s else None
    except (TypeError, ValueError):
        return None


def ai_config_response(session_key):
    """Reproduce the Node engine's GET /api/ai/config payload from the in-Splunk
    [ai_provider] config. serverManaged is true when a key is configured; configuredModels
    carries the per-function model choices the SPA reads (chat/build/completion)."""
    cfg = read_ai_provider(session_key)
    _provider, _base, key = provider_and_key(session_key, cfg)
    chat = (cfg.get("model") or "").strip() or None
    default_model = chat or DEFAULT_CHAT_MODEL
    try:
        max_iter = int(cfg.get("max_iterations") or 30)
    except (TypeError, ValueError):
        max_iter = 30
    max_iter = max(1, min(100, max_iter))
    return {
        "serverManaged": bool(key),
        "profile": "splunk-native",
        "models": {"executor": default_model, "planner": default_model},
        "configuredModels": {
            "chat": chat,
            "build": (cfg.get("build_model") or "").strip() or None,
            "completion": (cfg.get("completion_model") or "").strip() or None,
        },
        # Sampling temperatures from the same Configuration tab. Without these the
        # per-function temperature fields were dead config - the SPA hardcoded its own.
        "configuredTemperatures": {
            "chat": float_or_none(cfg.get("temperature")),
            "build": float_or_none(cfg.get("build_temperature")),
            "completion": float_or_none(cfg.get("completion_temperature")),
        },
        "defaultModel": default_model,
        "notes": "AI provider, key and models come from Configuration → AI Provider.",
        "capabilities": {
            "dockerToolsEnabled": False,
            "browserCheckEnabled": False,
            "localDocsIndexEnabled": False,
            "mcpGroundingEnabled": False,
        },
        "agent": {
            "maxIterations": max_iter,
            "maxIterationsMin": 1,
            "maxIterationsMax": 100,
            "inspectMaxIterations": 4,
            "noProgressLimit": 3,
        },
        "toolPolicy": {"policy": {}, "askTools": [], "mcpGroundingAuto": False},
    }


def select_tool_calling_models(raw, provider="openrouter"):
    """Shape a provider's /models payload into picker entries.

    MUST mirror server/services/openrouterModels.ts `selectToolCallingModels` - the SPA
    reads `label` / `provider` / `contextLength` / `pricing` off each entry, so returning
    the provider's raw `{id, name}` renders every option as "undefined (undefined)".
    Pure function so it is unit-testable without the network.
    """
    out = []
    for m in (raw or []):
        mid = str(m.get("id") or "")
        if not mid:
            continue
        if provider == "openrouter":
            # Only models that can actually drive a tool-calling agent, with a workable
            # context window (same gate as the Node engine).
            if "tools" not in (m.get("supported_parameters") or []):
                continue
            try:
                if int(m.get("context_length") or 0) < _MIN_CONTEXT:
                    continue
            except (TypeError, ValueError):
                continue
        try:
            ctx = int(m.get("context_length") or 0)
        except (TypeError, ValueError):
            ctx = 0
        info = {
            "id": mid,
            "label": str(m.get("name") or mid),
            "provider": mid.split("/")[0] if "/" in mid else provider,
            "contextLength": ctx,
        }
        pricing = m.get("pricing") or {}
        try:
            prompt = float(pricing.get("prompt") or 0)
            completion = float(pricing.get("completion") or 0)
        except (TypeError, ValueError):
            prompt = completion = 0.0
        # Only attach pricing when known and non-zero (free models report "0").
        if prompt > 0 or completion > 0:
            info["pricing"] = {"prompt": prompt, "completion": completion}
        out.append(info)

    def _sort_key(info):
        try:
            rank = _PROVIDER_ORDER.index(info["provider"])
        except ValueError:
            rank = 99
        return (rank, info["label"].lower())

    out.sort(key=_sort_key)
    return out[:_MAX_MODELS]


def list_models(session_key, provider=None):
    """List the provider's tool-enabled models for the Settings picker (OpenRouter/OpenAI).

    Cached in-process for an hour: the catalog moves slowly and a persistent REST handler
    is long-lived, so without this every panel mount made a live 20s-timeout call.
    """
    cfg = read_ai_provider(session_key)
    prov = str(provider or cfg.get("provider") or "openrouter").lower()
    if prov not in ("openrouter", "openai"):
        return {"ok": True, "provider": prov, "models": [], "dynamic": False}
    cached = _MODELS_CACHE.get(prov)
    if cached and (time.time() - cached[0]) < _MODELS_TTL:
        return {"ok": True, "provider": prov, "models": cached[1], "dynamic": True,
                "cached": True}
    _p, base, key = provider_and_key(session_key, cfg)
    base = _PROVIDER_BASE.get(prov, base)
    try:
        req = urllib.request.Request(base + "/models", method="GET")
        if key:
            req.add_header("Authorization", "Bearer " + key)
        with urllib.request.urlopen(req, timeout=20, context=_ssl_ctx()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "model list unavailable: %s" % e, "models": []}
    models = select_tool_calling_models(data.get("data") or [], prov)
    if models:
        _MODELS_CACHE[prov] = (time.time(), models)
    return {"ok": True, "provider": prov, "models": models, "dynamic": True, "cached": False}


def chat_passthrough(session_key, body):
    """POST an OpenAI-style chat body to the configured provider, injecting the key (and a
    default model when the caller didn't pin one). Returns (status, payload_dict). Used by
    /api/ai/chat for Expert-Expansion + inline completion."""
    provider, base, key = provider_and_key(session_key, None)
    if not key:
        return 403, {"error": "No AI key configured. Set one in Configuration → AI Provider."}
    payload = dict(body or {})
    payload.pop("stream", None)  # persistent handler can't stream; force a single completion
    if not payload.get("model"):
        payload["model"] = (read_ai_provider(session_key).get("model") or "").strip() or DEFAULT_CHAT_MODEL
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "HTTP-Referer": "https://splunk.engineer",
        "X-Title": "UCCBuilder",
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180, context=_ssl_ctx()) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"error": "provider error %s" % e.code}
    except Exception as e:  # noqa: BLE001
        return 502, {"error": "AI request failed: %s" % e}


def complete_text(session_key, messages, model=None, temperature=None, max_tokens=None):
    """Convenience wrapper: run a chat completion and return the assistant text (or '').
    Used by the native build-loop fixer."""
    body = {"messages": messages, "stream": False}
    if model:
        body["model"] = model
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    status, payload = chat_passthrough(session_key, body)
    if status >= 400:
        return "", payload.get("error") or ("HTTP %s" % status)
    try:
        return (payload["choices"][0]["message"]["content"] or ""), None
    except (KeyError, IndexError, TypeError):
        return "", "no content in completion"
