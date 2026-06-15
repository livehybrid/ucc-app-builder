"""
UCC App Builder — MCP tool REST handlers (the EXPOSE side for Splunk 10.4).

Each MCP tool in default/tools.conf maps to a restmap.conf endpoint that lands
here. The Splunk AI Assistant calls these to build a UCC add-on:
  ucc_create_addon -> ucc_write_file globalConfig.json -> ucc_build_and_inspect
  (repeat on findings) -> ucc_package.

Project files live in the KV collection `ucc_builder_files`, scoped to the caller's
session, so the Monaco UI and the agent see the same files. build/package proxy to
the Node build engine (ucc-gen + AppInspect) whose URL is an app config setting.

SECURITY: file paths are confined to the add-on project subtree — absolute paths,
'..'/'.'/empty segments, backslashes and NUL bytes are rejected, so the agent can
never read or write anything else on the Splunk host.
"""
import importlib.util
import json
import os

import splunk.rest as rest
from splunk.persistconn.application import PersistentServerConnectionApplication

PROVIDERS = ("openrouter", "openai", "anthropic", "google")
ADVISOR_KEYS = ("ai_provider", "ai_base_url", "ai_model", "temperature", "max_steps")

_bin_dir = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("builder_common", os.path.join(_bin_dir, "builder_common.py"))
builder_common = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(builder_common)
json_response = builder_common.json_response
get_session_key = builder_common.get_session_key
to_safe_project_path = builder_common.to_safe_project_path
derive_app_id = builder_common.derive_app_id
KV = builder_common.KVProjectStore
sidecar_call = builder_common.sidecar_call

APP = 'ucc_app_builder'


class BuilderHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line=None, command_arg=None):
        super(BuilderHandler, self).__init__()

    # --- dispatch -----------------------------------------------------------
    def handle(self, in_string):
        try:
            req = json.loads(in_string) if in_string else {}
            session_key = get_session_key(req)
            if not session_key:
                return json_response({'error': 'Missing session key'}, status=401)

            tool = self._tool_from_path(req)
            args = self._args(req)
            sess = req.get('session', {}) if isinstance(req, dict) else {}
            user = sess.get('user') if isinstance(sess, dict) else None
            store = KV(session_key, app=APP, user=user)

            handler = getattr(self, f'_t_{tool}', None)
            if handler is None:
                return json_response({'error': f'Unknown tool: {tool}'}, status=404)
            return handler(store, args, session_key)
        except Exception as e:  # noqa: BLE001 — surface any error as JSON, never 500-with-stack
            return json_response({'error': str(e)}, status=500)

    @staticmethod
    def _tool_from_path(req):
        # restmap match path trailing segment, e.g. /ucc_app_builder/write_file
        path = ''
        for key in ('path_info', 'rest_path', 'path'):
            v = req.get(key)
            if isinstance(v, str) and v:
                path = v
                break
        return (path.rstrip('/').rsplit('/', 1)[-1] or 'ping')

    @staticmethod
    def _args(req):
        # Accept arguments however the caller sends them: a JSON body, a
        # form-encoded body, or query params (the Splunk MCP Server form-encodes
        # API-tool bodies unless a JSON Content-Type is set, so support both).
        from urllib.parse import parse_qsl
        args = {}
        payload = req.get('payload')
        if isinstance(payload, str) and payload.strip():
            txt = payload.strip()
            parsed = False
            try:
                body = json.loads(txt)
                if isinstance(body, dict):
                    args.update(body)
                    parsed = True
            except ValueError:
                pass
            if not parsed:
                # form-encoded body, e.g. name=demo&version=
                for k, v in parse_qsl(txt, keep_blank_values=True):
                    args.setdefault(k, v)
        for k, v in (req.get('query') or []):
            args.setdefault(k, v)
        return args

    # --- tools --------------------------------------------------------------
    def _t_ping(self, store, args, _sk):
        return json_response({'ok': True, 'app': APP, 'appId': store.app_id(), 'files': store.count()})

    def _t_create_addon(self, store, args, _sk):
        name = str(args.get('name') or '').strip()
        if not name:
            return json_response({'error': 'name is required'}, status=400)
        app_id = derive_app_id(name)
        store.reset(app_id, str(args.get('version') or '1.0.0'))
        return json_response({'ok': True, 'appId': app_id,
                              'text': f'Created project {app_id}. Next: ucc_write_file globalConfig.json, then ucc_build_and_inspect.'})

    def _t_write_file(self, store, args, _sk):
        app_id = store.app_id()
        if not app_id:
            return json_response({'error': 'call ucc_create_addon first'}, status=400)
        path = str(args.get('path') or '')
        safe = to_safe_project_path(app_id, path)
        if safe is None:
            return json_response({'error': f'path "{path}" rejected (no absolute paths or ".." traversal)'}, status=400)
        store.write(safe, str(args.get('content') or ''))
        return json_response({'ok': True, 'path': safe, 'text': f'Wrote {path}.'})

    def _t_read_file(self, store, args, _sk):
        app_id = store.app_id()
        path = str(args.get('path') or '')
        safe = to_safe_project_path(app_id, path)
        if safe is None:
            return json_response({'error': f'path "{path}" rejected'}, status=400)
        content = store.read(safe)
        if content is None:
            return json_response({'ok': True, 'path': safe, 'found': False, 'text': f'({path} not found)'})
        return json_response({'ok': True, 'path': safe, 'found': True, 'content': content})

    def _t_list_project(self, store, args, _sk):
        files = store.list_paths()
        return json_response({'ok': True, 'appId': store.app_id(), 'files': files})

    # --- AI provider settings (TrackMe-style) ------------------------------
    def _t_ai_config(self, store, args, session_key):
        """get current AI settings, or save them (action=save). API keys go to
        storage/passwords (per provider); other settings to the advisor conf."""
        if str(args.get('action') or 'get') == 'save':
            settings = {}
            for k in ADVISOR_KEYS:
                if args.get(k) is not None:
                    settings[k] = str(args.get(k))
            if settings:
                rest.simpleRequest(
                    f'/servicesNS/nobody/{APP}/configs/conf-ucc_app_builder_settings/advisor',
                    sessionKey=session_key, method='POST', postargs=settings, raiseAllErrors=False)
            api_key = args.get('api_key')
            provider = str(args.get('ai_provider') or 'openrouter').lower()
            if api_key:
                self._store_secret(session_key, f'{provider}_api_key', str(api_key))
            return json_response({'ok': True, **self._read_ai_config(session_key)})
        return json_response({'ok': True, **self._read_ai_config(session_key)})

    def _read_ai_config(self, session_key):
        conf = {}
        try:
            _, body = rest.simpleRequest(
                f'/servicesNS/nobody/{APP}/configs/conf-ucc_app_builder_settings/advisor?output_mode=json',
                sessionKey=session_key, method='GET', raiseAllErrors=False)
            entry = json.loads(body).get('entry', [])
            if entry:
                c = entry[0].get('content', {})
                conf = {k: c.get(k, '') for k in ADVISOR_KEYS}
        except Exception:
            pass
        keys_set = {}
        for p in PROVIDERS:
            keys_set[p] = self._secret_exists(session_key, f'{p}_api_key')
        conf.setdefault('ai_provider', 'openrouter')
        return {'providers': list(PROVIDERS), 'settings': conf, 'keySet': keys_set}

    def _secret_exists(self, session_key, user, realm=APP):
        try:
            _, body = rest.simpleRequest(
                f'/servicesNS/nobody/{APP}/storage/passwords/{realm}%3A{user}%3A?output_mode=json',
                sessionKey=session_key, method='GET', raiseAllErrors=False)
            return bool(json.loads(body).get('entry', []))
        except Exception:
            return False

    def _store_secret(self, session_key, user, password, realm=APP):
        base = f'/servicesNS/nobody/{APP}/storage/passwords'
        if self._secret_exists(session_key, user, realm):
            rest.simpleRequest(f'{base}/{realm}%3A{user}%3A', sessionKey=session_key, method='POST',
                               postargs={'password': password}, raiseAllErrors=False)
        else:
            rest.simpleRequest(base, sessionKey=session_key, method='POST',
                               postargs={'name': user, 'realm': realm, 'password': password},
                               raiseAllErrors=False)

    def _t_ai_models(self, store, args, session_key):
        """List the calling provider's tool-enabled (agentic) models. For OpenRouter,
        query its /models API and keep only models whose supported_parameters has 'tools'."""
        provider = str(args.get('provider') or 'openrouter').lower()
        if provider not in ('openrouter', 'openai'):
            return json_response({'ok': True, 'provider': provider, 'models': [], 'dynamic': False})
        api_key = (self._get_secret(session_key, f'{provider}_api_key')
                   or self._get_secret(session_key, 'openrouter_api_key'))
        base = 'https://openrouter.ai/api/v1' if provider == 'openrouter' else 'https://api.openai.com/v1'
        try:
            import ssl
            import urllib.request
            ca = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lib', 'certifi', 'cacert.pem')
            ctx = ssl.create_default_context(cafile=ca) if os.path.isfile(ca) else ssl.create_default_context()
            req = urllib.request.Request(base + '/models', method='GET')
            if api_key:
                req.add_header('Authorization', 'Bearer ' + api_key)
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception as e:  # noqa: BLE001
            return json_response({'ok': False, 'error': f'model list unavailable: {e}', 'models': []})
        models = []
        for m in (data.get('data') or []):
            mid = m.get('id')
            if not mid:
                continue
            sp = m.get('supported_parameters') or []
            if provider == 'openrouter' and 'tools' not in sp:
                continue  # keep only agentic / tool-enabled models
            models.append({'id': mid, 'name': m.get('name') or mid})
        models.sort(key=lambda x: x['id'])
        return json_response({'ok': True, 'provider': provider, 'models': models, 'dynamic': True})

    def _get_secret(self, session_key, user, realm=APP):
        try:
            _, body = rest.simpleRequest(
                f'/servicesNS/nobody/{APP}/storage/passwords/{realm}%3A{user}%3A?output_mode=json',
                sessionKey=session_key, method='GET', raiseAllErrors=False)
            entry = json.loads(body).get('entry', [])
            if entry:
                return entry[0].get('content', {}).get('clear_password')
        except Exception:
            pass
        return None

    def _t_build_and_inspect(self, store, args, session_key):
        return self._build(store, args, session_key, package=False)

    def _t_package(self, store, args, session_key):
        return self._build(store, args, session_key, package=True)

    def _build(self, store, args, session_key, package):
        app_id = store.app_id()
        if not app_id:
            return json_response({'error': 'call ucc_create_addon first'}, status=400)
        files = store.dump()
        if not files:
            return json_response({'error': 'project is empty — author globalConfig.json first'}, status=400)
        # Proxy to the Node build engine (ucc-gen + AppInspect). URL from app config.
        payload = {
            'appId': app_id,
            'version': store.version(),
            'files': files,
            'maxIterations': int(args.get('maxIterations') or 4),
            'includeWarnings': args.get('includeWarnings', True),
            'package': package,
        }
        result, err = sidecar_call('/api/mcp/build_engine', payload, session_key)
        if err:
            return json_response({'error': f'build engine unavailable: {err}',
                                  'hint': 'Set the sidecar URL in the app configuration.'}, status=502)
        # Write any corrected files back into the project so Monaco reflects them.
        for f in (result.get('files') or []):
            safe = to_safe_project_path(app_id, f.get('path', ''))
            if safe is not None:
                store.write(safe, f.get('content', ''))
        return json_response({'ok': True, **result})
