"""Shared helpers for UCC App Builder REST handlers (Splunk 10.4, py3.13)."""
import json
import time

import splunk.rest as rest

KV_COLLECTION = 'ucc_builder_files'


def json_response(payload, status=200):
    return {
        'status': status,
        'payload': json.dumps(payload),
        'headers': {'Content-Type': 'application/json'},
    }


def get_session_key(req):
    if not isinstance(req, dict):
        return None
    sess = req.get('session', {})
    if isinstance(sess, dict):
        return sess.get('authtoken') or sess.get('sessionKey')
    return None


def derive_app_id(name):
    """TA_-prefixed snake id (mirrors the standalone builder)."""
    out = ''.join(c.lower() if c.isalnum() else '_' for c in str(name))
    return out if out.startswith('ta_') else 'ta_' + out


def to_safe_project_path(app_id, p):
    """
    Confine a caller path to the project subtree. Returns '<app_id>/<path>' or
    None if absolute, contains '.'/'..'/'' segment, backslash or NUL - so the AI
    agent can never escape the project (mirrors server/mcp/core.ts).
    """
    if not isinstance(p, str) or p == '':
        return None
    if '\0' in p or '\\' in p:
        return None
    if p.startswith('/'):
        return None
    segments = p.split('/')
    if any(s in ('', '.', '..') for s in segments):
        return None
    rel = p if (not app_id or p.startswith(app_id + '/')) else f'{app_id}/{p}'
    if app_id and not rel.startswith(app_id + '/'):
        return None
    return rel


class KVProjectStore:
    """
    Per-session add-on project stored in the KV collection. _key = session-prefixed
    path; an `__meta__` row holds appId/version. Session-scoped so concurrent users
    don't collide. Uses splunk.rest against storage/collections/data.
    """

    def __init__(self, session_key, app, user=None):
        self.sk = session_key
        self.app = app
        self.user = user
        self.base = f'/servicesNS/nobody/{app}/storage/collections/data/{KV_COLLECTION}'

    def _sid(self):
        # Scope the project to the authenticated USER (stable across calls, unlike
        # the per-request auth token) so a build survives multiple MCP tool calls.
        if self.user:
            safe = ''.join(c if (c.isalnum() or c in '_-') else '_' for c in str(self.user))
            return ('u_' + safe)[:80]
        return str(abs(hash(self.sk)) % (10 ** 12))

    def _full_key(self, key):
        return f'{self._sid()}:{key}'

    def _doc_url(self, key):
        # The _key contains '/' (project paths); URL-encode it for the REST path.
        from urllib.parse import quote
        return f'{self.base}/{quote(self._full_key(key), safe="")}'

    def _get(self, key):
        try:
            _, body = rest.simpleRequest(
                self._doc_url(key), sessionKey=self.sk,
                method='GET', raiseAllErrors=False)
            doc = json.loads(body)
            return doc if isinstance(doc, dict) and '_key' in doc else None
        except Exception:
            return None

    def _put(self, key, fields):
        doc = {'_key': self._full_key(key), 'session': self._sid(),
               'updated_at': time.time(), **fields}
        # Upsert: update existing (encoded _key in path), else insert into collection.
        if self._get(key) is not None:
            rest.simpleRequest(self._doc_url(key), sessionKey=self.sk,
                               method='POST', jsonargs=json.dumps(doc), raiseAllErrors=False)
        else:
            rest.simpleRequest(self.base, sessionKey=self.sk, method='POST',
                               jsonargs=json.dumps(doc), raiseAllErrors=False)

    def reset(self, app_id, version):
        # Clear this session's rows, then write meta. The _key contains '/' (project
        # paths) so it MUST be URL-encoded in the DELETE path - otherwise the '/' is
        # treated as a path separator, the DELETE 404s, and stale files from prior
        # projects accumulate (which then break the build with nested garbage).
        from urllib.parse import quote
        for row in self._query():
            try:
                rest.simpleRequest(f"{self.base}/{quote(row['_key'], safe='')}", sessionKey=self.sk,
                                   method='DELETE', raiseAllErrors=False)
            except Exception:
                pass
        self._put('__meta__', {'path': '__meta__', 'content': json.dumps({'appId': app_id, 'version': version})})

    def _meta(self):
        doc = self._get('__meta__')
        if not doc:
            return {}
        try:
            return json.loads(doc.get('content') or '{}')
        except ValueError:
            return {}

    def app_id(self):
        return self._meta().get('appId', '')

    def version(self):
        return self._meta().get('version', '1.0.0')

    def write(self, path, content):
        self._put(path, {'path': path, 'content': content})

    def read(self, path):
        doc = self._get(path)
        return doc.get('content') if doc else None

    def _query(self):
        try:
            q = json.dumps({'session': self._sid()})
            _, body = rest.simpleRequest(
                f'{self.base}?query={q}&count=0', sessionKey=self.sk,
                method='GET', raiseAllErrors=False)
            rows = json.loads(body)
            return rows if isinstance(rows, list) else []
        except Exception:
            return []

    def list_paths(self):
        return sorted(r.get('path') for r in self._query() if r.get('path') and r.get('path') != '__meta__')

    def count(self):
        return len(self.list_paths())

    def dump(self):
        return [{'path': r['path'], 'content': r.get('content', '')}
                for r in self._query() if r.get('path') and r.get('path') != '__meta__']


# (Removed get_sidecar_url / sidecar_call - the build engine, artifact generators and AI
# proxy now run natively in Splunk's python; see builder_build.py / builder_generators.py /
# builder_llm.py / builder_api.py. The app no longer depends on a Node sidecar.)


APPS_COLLECTION = 'ucc_builder_apps'


class KVAppLibrary:
    """Saved add-on projects ('My Apps') - one KV row per (user, appId), each holding the
    project's authored source files as a JSON blob. Lets a user save, list, resume and
    delete multiple add-ons across sessions/devices (server-side, unlike the SPA's
    single-state localStorage)."""

    def __init__(self, session_key, app, user=None):
        self.sk = session_key
        self.app = app
        self.user = user
        self.base = f'/servicesNS/nobody/{app}/storage/collections/data/{APPS_COLLECTION}'

    def _uid(self):
        if self.user:
            safe = ''.join(c if (c.isalnum() or c in '_-') else '_' for c in str(self.user))
            return ('u_' + safe)[:80]
        return str(abs(hash(self.sk)) % (10 ** 12))

    def _key(self, app_id):
        safe_app = ''.join(c if (c.isalnum() or c in '_-.') else '_' for c in str(app_id))[:120]
        return f'{self._uid()}:{safe_app}'

    def _doc_url(self, app_id):
        from urllib.parse import quote
        return f'{self.base}/{quote(self._key(app_id), safe="")}'

    def _get(self, app_id):
        try:
            _, body = rest.simpleRequest(self._doc_url(app_id), sessionKey=self.sk,
                                         method='GET', raiseAllErrors=False)
            doc = json.loads(body)
            return doc if isinstance(doc, dict) and '_key' in doc else None
        except Exception:
            return None

    def save(self, app_id, name, version, files):
        doc = {'_key': self._key(app_id), 'uid': self._uid(), 'appId': app_id,
               'name': name or app_id, 'version': version or '1.0.0',
               'files': json.dumps(files or []), 'updated_at': time.time()}
        if self._get(app_id) is not None:
            rest.simpleRequest(self._doc_url(app_id), sessionKey=self.sk, method='POST',
                               jsonargs=json.dumps(doc), raiseAllErrors=False)
        else:
            rest.simpleRequest(self.base, sessionKey=self.sk, method='POST',
                               jsonargs=json.dumps(doc), raiseAllErrors=False)
        return {'appId': app_id, 'fileCount': len(files or [])}

    def list(self):
        try:
            q = json.dumps({'uid': self._uid()})
            _, body = rest.simpleRequest(f'{self.base}?query={q}&count=0', sessionKey=self.sk,
                                         method='GET', raiseAllErrors=False)
            rows = json.loads(body)
            out = [{'appId': r.get('appId'), 'name': r.get('name'),
                    'version': r.get('version'), 'updated_at': r.get('updated_at'),
                    'fileCount': len(json.loads(r.get('files') or '[]'))}
                   for r in (rows if isinstance(rows, list) else [])]
            return sorted(out, key=lambda x: x.get('updated_at') or 0, reverse=True)
        except Exception:
            return []

    def load(self, app_id):
        doc = self._get(app_id)
        if not doc:
            return None
        try:
            files = json.loads(doc.get('files') or '[]')
        except ValueError:
            files = []
        return {'appId': doc.get('appId'), 'name': doc.get('name'),
                'version': doc.get('version'), 'files': files}

    def delete(self, app_id):
        try:
            rest.simpleRequest(self._doc_url(app_id), sessionKey=self.sk,
                               method='DELETE', raiseAllErrors=False)
            return True
        except Exception:
            return False


TRACES_COLLECTION = 'ucc_agent_traces'
_TRACE_MAX_EVENTS = 400
_TRACE_MAX_FIELD = 4000


def _truncate(s, limit):
    s = '' if s is None else str(s)
    return s if len(s) <= limit else s[:limit] + '…'


class KVAgentTraces:
    """Durable record of Splunk Agent SDK (splunklib.ai) chat runs - one KV row per run,
    holding the full progress trace (assistant / tool_call / tool_result events) plus
    metadata, so a run survives the per-job file's TTL prune and can be reviewed, debugged
    or fed to eval after the fact. Persisted by advisor_runner.py at terminal; listed/read
    by builder_agent.py (agent_traces / agent_trace)."""

    def __init__(self, session_key, app, user=None):
        self.sk = session_key
        self.app = app
        self.user = user
        self.base = f'/servicesNS/nobody/{app}/storage/collections/data/{TRACES_COLLECTION}'

    def _uid(self):
        if self.user:
            safe = ''.join(c if (c.isalnum() or c in '_-') else '_' for c in str(self.user))
            return ('u_' + safe)[:80]
        return str(abs(hash(self.sk)) % (10 ** 12))

    def save(self, job_id, meta, events):
        """Persist one run. `events` is the list of trace event dicts; it is capped and
        each event's large text fields are truncated to keep the KV document bounded."""
        capped = events[-_TRACE_MAX_EVENTS:] if isinstance(events, list) else []
        slim = []
        for ev in capped:
            if not isinstance(ev, dict):
                continue
            e = dict(ev)
            for k in ('content', 'result', 'answer', 'trace', 'args'):
                if k in e:
                    e[k] = _truncate(e[k] if isinstance(e[k], str) else json.dumps(e[k], default=str),
                                     _TRACE_MAX_FIELD)
            slim.append(e)
        doc = {
            '_key': str(job_id),
            'uid': self._uid(),
            'job_id': str(job_id),
            'created_at': time.time(),
            'model': str(meta.get('model') or ''),
            'provider': str(meta.get('provider') or ''),
            'status': str(meta.get('status') or ''),
            'prompt': _truncate(meta.get('prompt'), _TRACE_MAX_FIELD),
            'answer': _truncate(meta.get('answer'), _TRACE_MAX_FIELD),
            'error': _truncate(meta.get('error'), _TRACE_MAX_FIELD),
            'step_count': int(meta.get('step_count') or 0),
            'event_count': len(events) if isinstance(events, list) else 0,
            'events': json.dumps(slim, default=str),
        }
        # Existence check in its OWN try/except: a GET on a not-yet-existing key can raise
        # (KV 404), and that must NOT abort the write below - otherwise no run ever persists
        # (every job_id is new). This mirrors KVAppLibrary._get's isolation.
        url = f'{self.base}/{job_id}'
        exists = False
        try:
            _, body = rest.simpleRequest(url, sessionKey=self.sk, method='GET',
                                         raiseAllErrors=False)
            doc_existing = json.loads(body)
            exists = isinstance(doc_existing, dict) and '_key' in doc_existing
        except Exception:
            exists = False
        try:
            if exists:
                rest.simpleRequest(url, sessionKey=self.sk, method='POST',
                                   jsonargs=json.dumps(doc), raiseAllErrors=False)
            else:
                rest.simpleRequest(self.base, sessionKey=self.sk, method='POST',
                                   jsonargs=json.dumps(doc), raiseAllErrors=False)
            return True
        except Exception:
            return False

    def list(self, limit=50):
        try:
            q = json.dumps({'uid': self._uid()})
            url = (f'{self.base}?query={q}&count={int(limit)}'
                   '&fields=job_id,created_at,model,provider,status,prompt,step_count,event_count'
                   '&sort=-created_at')
            _, body = rest.simpleRequest(url, sessionKey=self.sk, method='GET',
                                         raiseAllErrors=False)
            rows = json.loads(body)
            return rows if isinstance(rows, list) else []
        except Exception:
            return []

    def get(self, job_id):
        try:
            from urllib.parse import quote
            url = f'{self.base}/{quote(str(job_id), safe="")}'
            _, body = rest.simpleRequest(url, sessionKey=self.sk, method='GET',
                                         raiseAllErrors=False)
            doc = json.loads(body)
            if not (isinstance(doc, dict) and '_key' in doc):
                return None
            try:
                doc['events'] = json.loads(doc.get('events') or '[]')
            except (ValueError, TypeError):
                doc['events'] = []
            return doc
        except Exception:
            return None
