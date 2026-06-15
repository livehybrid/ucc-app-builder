"""
UCC App Builder - MCP tool REST handlers (the EXPOSE side for Splunk 10.4).

Each MCP tool in default/tools.conf maps to a restmap.conf endpoint that lands
here. The Splunk AI Assistant calls these to build a UCC add-on:
  ucc_create_addon -> ucc_write_file globalConfig.json -> ucc_build_and_inspect
  (repeat on findings) -> ucc_package.

Project files live in the KV collection `ucc_builder_files`, scoped to the caller's
session, so the Monaco UI and the agent see the same files. build/package proxy to
the Node build engine (ucc-gen + AppInspect) whose URL is an app config setting.

SECURITY: file paths are confined to the add-on project subtree - absolute paths,
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


def _load_sibling(mod):
    s = importlib.util.spec_from_file_location(mod, os.path.join(_bin_dir, mod + '.py'))
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


# Native, in-Splunk implementations (no Node sidecar): deterministic artifact generators
# and the ucc-gen + AppInspect build engine. builder_build is loaded lazily inside _build
# (it pulls in subprocess/build-only deps that the lightweight tool handlers don't need).
builder_generators = _load_sibling('builder_generators')

APP = 'ucc_app_builder'


def _coerce_array(v):
    """The Splunk AI Assistant MCP may pass nested args as JSON strings; accept both."""
    if isinstance(v, list):
        return v
    if isinstance(v, str) and v.strip().startswith('['):
        try:
            p = json.loads(v)
            return p if isinstance(p, list) else []
        except ValueError:
            return []
    return []


def _coerce_object(v):
    if isinstance(v, str) and v.strip().startswith('{'):
        try:
            return json.loads(v)
        except ValueError:
            return None
    return v

# Seed-from-installed: read an installed add-on's authoring source from $SPLUNK_HOME/etc/apps.
_SPLUNK_HOME = os.environ.get('SPLUNK_HOME') or os.path.normpath(
    os.path.join(_bin_dir, '..', '..', '..', '..'))
_APPS_DIR = os.path.join(_SPLUNK_HOME, 'etc', 'apps')
_SEED_MAX_FILE = 256 * 1024          # 256 KB per file (skip larger)
_SEED_MAX_TOTAL = 4 * 1024 * 1024    # 4 MB total response cap
# Never descend into these (vendored deps, bytecode, instance-local config/secrets, VCS).
_SEED_PRUNE_DIRS = ('__pycache__', 'lib', 'local', '.git', 'node_modules')
_SEED_BIN_EXT = ('.pyc', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.gz', '.tgz',
                 '.zip', '.so', '.dll', '.dylib', '.whl', '.ttf', '.woff', '.woff2', '.eot',
                 '.pdf', '.jar', '.class', '.bin', '.dat', '.db')


def _safe_app_id(raw):
    """An app id is a single etc/apps directory name; reject anything that could escape it."""
    import re
    s = str(raw or '').strip()
    return s if (re.match(r'^[A-Za-z0-9._-]{1,128}$', s) and '..' not in s) else None


def _find_globalconfig(app_dir):
    # Source layouts keep it at the root or package/; a BUILT add-on ships it under the
    # appserver UI bundle (appserver/static/js/build/globalConfig.json) - the canonical
    # location ucc-gen emits, present in every installed UCC add-on.
    for cand in ('globalConfig.json',
                 os.path.join('package', 'globalConfig.json'),
                 os.path.join('appserver', 'static', 'js', 'build', 'globalConfig.json')):
        p = os.path.join(app_dir, cand)
        if os.path.isfile(p):
            return p
    return None


def _is_ucc_app(app_dir):
    """Recognise a UCC add-on. globalConfig.json is a BUILD INPUT that ucc-gen consumes -
    the installed/built add-on does NOT ship it - so also accept the generated markers a
    built UCC add-on always carries: a `<app>_rh_<name>.py` REST handler and/or the
    appserver SPA build dir. (A source-layout add-on still matches via globalConfig.json.)"""
    import glob
    if _find_globalconfig(app_dir):
        return True
    if glob.glob(os.path.join(app_dir, 'bin', '*_rh_*.py')):
        return True
    if os.path.isdir(os.path.join(app_dir, 'appserver', 'static', 'js', 'build')):
        return True
    return False


def _app_meta(app_dir):
    """(displayName, version) for an installed app - from globalConfig.json meta when
    present, else default/app.conf ([ui] label + [launcher] version)."""
    gc = _find_globalconfig(app_dir)
    if gc:
        try:
            with open(gc, 'r', encoding='utf-8') as fh:
                m = (json.load(fh) or {}).get('meta', {}) or {}
            if m.get('displayName') or m.get('version'):
                return m.get('displayName'), str(m.get('version') or '')
        except Exception:  # noqa: BLE001
            pass
    label, version = None, ''
    try:
        with open(os.path.join(app_dir, 'default', 'app.conf'), 'r',
                  encoding='utf-8', errors='replace') as fh:
            for line in fh:
                s = line.strip()
                if label is None and s.startswith('label') and '=' in s:
                    label = s.split('=', 1)[1].strip()
                elif not version and s.startswith('version') and '=' in s:
                    version = s.split('=', 1)[1].strip()
    except OSError:
        pass
    return label, version


def _seed_include(rel):
    """Authoring source only: default/ + bin/ + package/ + README/ + the default metadata.
    (globalConfig.json is added explicitly at the project root by the import handler;
    lib/local/__pycache__/appserver are pruned or excluded.)"""
    if rel.endswith(_SEED_BIN_EXT):
        return False
    if rel == 'metadata/default.meta':
        return True
    return rel.split('/', 1)[0] in ('default', 'bin', 'package', 'README')


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
        except Exception as e:  # noqa: BLE001 - surface any error as JSON, never 500-with-stack
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

    def _t_sync_project(self, store, args, _sk):
        """Replace the agent's KV project with the SPA's current VFS, so a Splunk-mode
        agent run extends the project the user is actually looking at (imported / wizard /
        seeded), instead of a stale or empty KV project. The SPA calls this right before
        agent_start; the agent's done-event then syncs KV back to the VFS.

        An EMPTY files[] with no appId CLEARS the project - so starting a new app (empty
        VFS) doesn't leave the agent reading a previously-built one (it would otherwise see
        'a project is already loaded' and extend the old app instead of starting fresh)."""
        app_id = str(args.get('appId') or '').strip()
        files = args.get('files')
        if not isinstance(files, list):
            return json_response({'error': 'files[] is required'}, status=400)
        if files and not app_id:
            return json_response({'error': 'appId is required when files are provided'}, status=400)
        store.reset(app_id, str(args.get('version') or '1.0.0'))
        written = 0
        for f in files:
            if not isinstance(f, dict):
                continue
            safe = to_safe_project_path(app_id, str(f.get('path') or ''))
            if safe is not None:
                store.write(safe, str(f.get('content') or ''))
                written += 1
        return json_response({'ok': True, 'appId': app_id, 'files': written})

    # --- My Apps: save / list / resume / delete add-on projects (KV-backed) ----
    def _apps(self, store, session_key):
        return builder_common.KVAppLibrary(session_key, APP, user=getattr(store, 'user', None))

    def _t_list_apps(self, store, args, session_key):
        return json_response({'ok': True, 'apps': self._apps(store, session_key).list()})

    def _t_save_app(self, store, args, session_key):
        app_id = str(args.get('appId') or '').strip()
        files = args.get('files')
        if not app_id or not isinstance(files, list):
            return json_response({'error': 'appId and files[] are required'}, status=400)
        clean = [{'path': str(f.get('path')), 'content': str(f.get('content') or '')}
                 for f in files if isinstance(f, dict) and f.get('path')]
        result = self._apps(store, session_key).save(
            app_id, str(args.get('name') or app_id), str(args.get('version') or '1.0.0'), clean)
        return json_response({'ok': True, **result})

    def _t_load_app(self, store, args, session_key):
        app_id = str(args.get('appId') or '').strip()
        if not app_id:
            return json_response({'error': 'appId is required'}, status=400)
        proj = self._apps(store, session_key).load(app_id)
        if proj is None:
            return json_response({'ok': True, 'found': False}, status=404)
        return json_response({'ok': True, 'found': True, **proj})

    def _t_delete_app(self, store, args, session_key):
        app_id = str(args.get('appId') or '').strip()
        if not app_id:
            return json_response({'error': 'appId is required'}, status=400)
        self._apps(store, session_key).delete(app_id)
        return json_response({'ok': True, 'deleted': app_id})

    # --- Dashboard / saved-search generation (MCP tools, engine-backed) --------
    def _t_generate_dashboard(self, store, args, session_key):
        app_id = store.app_id()
        if not app_id:
            return json_response({'error': 'call ucc_create_addon first'}, status=400)
        panels = _coerce_array(args.get('panels'))
        if not args.get('title') or not panels:
            return json_response({'error': 'title and a non-empty panels[] are required'}, status=400)
        try:
            spec = {'title': args.get('title'), 'description': args.get('description'),
                    'panels': panels, 'theme': args.get('theme')}
            content = builder_generators.build_dashboard_view_xml(spec)
            file_name = builder_generators.view_file_name(args.get('title'))
        except Exception as e:  # noqa: BLE001
            return json_response({'error': str(e)}, status=400)
        safe = to_safe_project_path(app_id, 'package/default/data/ui/views/%s' % file_name)
        if safe:
            store.write(safe, content)
        return json_response({'ok': True, 'path': safe, 'fileName': file_name,
                              'text': f"Created Dashboard Studio dashboard {file_name}."})

    def _t_generate_savedsearch(self, store, args, session_key):
        app_id = store.app_id()
        if not app_id:
            return json_response({'error': 'call ucc_create_addon first'}, status=400)
        if not args.get('name') or not args.get('search'):
            return json_response({'error': 'name and search are required'}, status=400)
        try:
            spec = dict(args)
            spec['alert'] = _coerce_object(args.get('alert'))
            stanza = builder_generators.build_savedsearch_stanza(spec)
        except Exception as e:  # noqa: BLE001
            return json_response({'error': str(e)}, status=400)
        safe = to_safe_project_path(app_id, 'package/default/savedsearches.conf')
        existing = (store.read(safe) or '') if safe else ''
        content = (existing.rstrip() + '\n\n' + stanza) if existing.strip() else stanza
        if safe:
            store.write(safe, content)
        return json_response({'ok': True, 'path': safe,
                              'text': f"Added saved search [{args.get('name')}] to savedsearches.conf."})

    def _t_generate_tests(self, store, args, session_key):
        """Generate a pytest-splunk-addon test scaffold (props/transforms/CIM validation)
        for the project's sourcetypes, optionally seeded with sample events captured by the
        input emulator. The deterministic file set is built natively in-Splunk; we write it
        into the KV project under <appId>/tests/."""
        app_id = store.app_id()
        if not app_id:
            return json_response({'error': 'call ucc_create_addon first'}, status=400)
        try:
            scaffold = builder_generators.build_pytest_scaffold({
                'addonName': app_id, 'sourcetypes': _coerce_array(args.get('sourcetypes'))})
        except Exception as e:  # noqa: BLE001
            return json_response({'error': str(e)}, status=400)
        written = []
        for f in (scaffold.get('files') or []):
            safe = to_safe_project_path(app_id, str(f.get('path') or ''))
            if safe:
                store.write(safe, str(f.get('content') or ''))
                written.append(safe)
        return json_response({'ok': True, 'files': written,
                              'text': f"Generated pytest-splunk-addon scaffold ({len(written)} files) "
                                      "under tests/. Run it against a Splunk to validate props/transforms/CIM."})

    # --- Seed from an add-on already installed on this Splunk ----------------
    def _t_list_installed_apps(self, store, args, session_key):
        """List installed UCC add-ons (those with a globalConfig.json) that can be seeded
        into the builder."""
        apps = []
        try:
            for name in sorted(os.listdir(_APPS_DIR)):
                if name.startswith('.'):
                    continue
                app_dir = os.path.join(_APPS_DIR, name)
                if not os.path.isdir(app_dir) or not _is_ucc_app(app_dir):
                    continue
                label, version = _app_meta(app_dir)
                apps.append({'appId': name,
                             'displayName': label or name,
                             'version': version,
                             'isUCCApp': True})
        except OSError as e:
            return json_response({'error': str(e)}, status=500)
        return json_response({'ok': True, 'apps': apps})

    def _t_import_installed_app(self, store, args, session_key):
        """Read an installed add-on's authoring source (globalConfig + default/ + bin/ +
        package/ + README/), excluding vendored libs, bytecode and instance-local config,
        and return it as files[] for the builder to load into its VFS."""
        app_id = _safe_app_id(args.get('appId'))
        if not app_id:
            return json_response({'error': 'valid appId is required'}, status=400)
        apps_real = os.path.realpath(_APPS_DIR)
        root = os.path.realpath(os.path.join(_APPS_DIR, app_id))
        # Confinement: the resolved path must be a direct child of etc/apps (blocks
        # traversal + symlink escapes), exist, and contain a globalConfig.json.
        if os.path.dirname(root) != apps_real or not os.path.isdir(root):
            return json_response({'error': 'app not found'}, status=404)
        if not _is_ucc_app(root):
            return json_response({'error': 'not a UCC add-on'}, status=400)

        files, skipped, seen = [], [], set()
        state = {'total': 0, 'truncated': False}

        def _add(target, content, size):
            if target in seen:
                return
            if state['total'] + size > _SEED_MAX_TOTAL:
                state['truncated'] = True
                return
            seen.add(target)
            state['total'] += size
            files.append({'path': target, 'content': content})

        # The canonical globalConfig.json is the add-on's source of truth (real inputs/
        # accounts/config) - emit it at the PROJECT ROOT regardless of where it physically
        # lives (a BUILT add-on keeps it under appserver/static/js/build), so the builder
        # treats the seed as a normal UCC source project.
        gc = _find_globalconfig(root)
        if gc:
            try:
                with open(gc, 'r', encoding='utf-8') as fh:
                    gc_content = fh.read()
                _add(f'{app_id}/globalConfig.json', gc_content, len(gc_content.encode('utf-8')))
            except (OSError, UnicodeDecodeError):
                pass

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in _SEED_PRUNE_DIRS]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root).replace(os.sep, '/')
                if not _seed_include(rel):
                    continue
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                if sz > _SEED_MAX_FILE:
                    skipped.append(rel)
                    continue
                try:
                    with open(full, 'r', encoding='utf-8') as fh:
                        content = fh.read()
                except (OSError, UnicodeDecodeError):
                    skipped.append(rel)
                    continue
                _add(f'{app_id}/{rel}', content, sz)
        return json_response({'ok': True, 'appId': app_id, 'files': files,
                              'truncated': state['truncated'], 'skipped': skipped[:50]})

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
            return json_response({'error': 'project is empty - author globalConfig.json first'}, status=400)
        # Build natively in Splunk's python (ucc-gen + AppInspect, vendored under lib/).
        # No nested LLM-fix loop here - the advisor agent reads the findings below and
        # patches the source itself, then calls build_and_inspect again.
        builder_build = _load_sibling('builder_build')
        try:
            result = builder_build.build_and_inspect(
                files, app_id, version=store.version() or '1.0.0',
                do_package=package, include_warnings=bool(args.get('includeWarnings', False)))
        except Exception as e:  # noqa: BLE001
            return json_response({'error': f'build failed: {e}'}, status=500)
        # Write any corrected files back into the project so Monaco reflects them.
        for f in (result.get('files') or []):
            safe = to_safe_project_path(app_id, f.get('path', ''))
            if safe is not None:
                store.write(safe, f.get('content', ''))
        return json_response({'ok': True, **result})
