"""
Model-choice endpoint for the UCC Configuration page's model dropdowns.

The Configuration → AI Provider tab used free-text fields for the three model settings, so
a typo was only discovered when a call failed. UCC's `singleSelect` can populate itself from
a REST endpoint (`options.endpointUrl`), but it expects a Splunk EAI collection:

    { "entry": [ { "name": "<model id>", "content": { "label": "<display name>" } } ] }

...whereas /api/ai/models speaks the SPA's shape. This handler adapts the same cached
catalog (builder_llm.list_models) into EAI entries. `createSearchChoice: true` on the field
keeps arbitrary model IDs typeable, so a model missing from the catalog is never a blocker.

Runs on python 3.13: it reaches builder_llm, whose solnlib/requests stack uses 3.10+ union
syntax that TypeErrors on Splunk's default 3.9 persistent-handler python.
"""
import json
import os
import sys

from splunk.persistconn.application import PersistentServerConnectionApplication

_BIN = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_BIN), "lib")
for _p in (_LIB, _BIN):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Shown when the live catalog is unreachable (no key yet, offline, provider down) so the
# dropdown is never empty. Kept deliberately short - the catalog is the real source.
_FALLBACK = [
    ("anthropic/claude-sonnet-4.6", "Claude Sonnet 4.6 (recommended for chat/agent)"),
    ("anthropic/claude-haiku-4.5", "Claude Haiku 4.5 (fast/cheap - inline completion)"),
    ("openai/gpt-4o", "GPT-4o"),
    ("openai/gpt-4o-mini", "GPT-4o mini"),
    ("google/gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("moonshotai/kimi-k2.6", "Kimi K2.6"),
    ("deepseek/deepseek-chat", "DeepSeek Chat"),
]


def _entries(models):
    out = []
    for m in models:
        mid = m.get("id")
        if not mid:
            continue
        label = m.get("label") or mid
        ctx = m.get("contextLength") or 0
        if ctx:
            label = "%s (%dk ctx)" % (label, round(ctx / 1000))
        out.append({"name": mid, "content": {"label": label, "id": mid}})
    return out


class ModelChoicesHandler(PersistentServerConnectionApplication):
    """GET -> the EAI-shaped model catalog for a singleSelect `endpointUrl`."""

    def __init__(self, command_line=None, command_arg=None):
        super(ModelChoicesHandler, self).__init__()

    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            import builder_common
            session_key = builder_common.get_session_key(req)
            if not session_key:
                return self._reply({"entry": self._fallback_entries()}, 200)
            import builder_llm
            res = builder_llm.list_models(session_key)
            models = res.get("models") or []
            entries = _entries(models) or self._fallback_entries()
            return self._reply({"entry": entries}, 200)
        except BaseException:  # noqa: BLE001 - a dropdown must never 500 the config page
            return self._reply({"entry": self._fallback_entries()}, 200)

    @staticmethod
    def _fallback_entries():
        return [{"name": mid, "content": {"label": label, "id": mid}}
                for mid, label in _FALLBACK]

    @staticmethod
    def _reply(payload, status):
        return {"status": status, "payload": json.dumps(payload),
                "headers": {"Content-Type": "application/json"}}
