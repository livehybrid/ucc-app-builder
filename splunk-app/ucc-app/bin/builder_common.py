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
    None if absolute, contains '.'/'..'/'' segment, backslash or NUL — so the AI
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
        # paths) so it MUST be URL-encoded in the DELETE path — otherwise the '/' is
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


def get_sidecar_url(session_key, app='ucc_app_builder'):
    """Read the configured Node build-engine URL from the app's config conf."""
    try:
        _, body = rest.simpleRequest(
            f'/servicesNS/nobody/{app}/configs/conf-ucc_app_builder_settings/build_engine?output_mode=json',
            sessionKey=session_key, method='GET', raiseAllErrors=False)
        entry = json.loads(body).get('entry', [])
        if entry:
            return entry[0].get('content', {}).get('url')
    except Exception:
        pass
    return None


def sidecar_call(path, payload, session_key):
    """POST to the Node build engine. Returns (result_dict, error_str)."""
    import ssl
    import urllib.request
    base = get_sidecar_url(session_key)
    if not base:
        return None, 'sidecar URL not configured'
    try:
        req = urllib.request.Request(
            base.rstrip('/') + path,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}, method='POST')
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=300, context=ctx) as resp:
            return json.loads(resp.read().decode('utf-8')), None
    except Exception as e:  # noqa: BLE001
        return None, str(e)
