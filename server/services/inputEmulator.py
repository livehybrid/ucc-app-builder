#!/usr/bin/env python3
"""
Input emulator — run a generated modular input's collection logic the way Splunk would,
WITHOUT installing the add-on or touching a real Splunk.

UCC/AOB inputs delegate to `<input>_helper.collect_events(helper, ew)` (or `stream_events`),
where `helper` is a ModularInputHelper and `ew` an EventWriter. We stub both with the
user-supplied input args + account/credential values + proxy, exec the helper source, call
its collection function, and capture the events it would have indexed — so you can SEE the
real data before authoring props/transforms.

Protocol: read ONE JSON object from stdin:
  { "helperCode": "...", "args": {field: value}, "index": "main",
    "proxy": {"enabled":bool,"host":..,"port":..,"username":..,"password":..} | null,
    "maxEvents": 200, "timeout": 30 }
Print ONE JSON object to stdout:
  { "ok": true, "events": [...], "logs": [...], "count": N, "truncated": bool }
  or { "ok": false, "error": "...", "trace": "...", "logs": [...] }
"""
import json
import sys
import traceback
import types

MAX_EVENTS_DEFAULT = 200


class CaptureEventWriter:
    """Stand-in for splunklib.modularinput.EventWriter — collects events instead of writing
    XML to stdout."""

    def __init__(self, sink):
        self._sink = sink

    def write_event(self, event):
        self._sink.append(event)

    def log(self, severity, message):  # EventWriter.log(severity, msg)
        pass

    def close(self):
        pass


class StubHelper:
    """Stand-in for the AOB/UCC ModularInputHelper. Sources config from the user's test
    values; performs REAL HTTP via requests so the events are genuine."""

    def __init__(self, args, index, proxy, logs):
        self._args = args or {}
        self._index = index or 'main'
        self._proxy = proxy or {}
        self._logs = logs
        self._events = []

    # --- config accessors the helper code calls ---------------------------------------
    def get_arg(self, name):
        return self._args.get(name)

    def get_output_index(self, *_a, **_k):
        return self._index

    def get_sourcetype(self, *_a, **_k):
        return self._args.get('sourcetype')

    def get_input_stanza_names(self, *_a, **_k):
        return self._args.get('__input_name__', 'emulated_input')

    def get_input_stanza(self, *_a, **_k):
        name = self._args.get('__input_name__', 'emulated_input')
        return {name: dict(self._args)}

    def get_global_setting(self, key):
        return self._args.get(key)

    def get_check_interval(self, *_a, **_k):
        try:
            return int(self._args.get('interval') or 0)
        except (TypeError, ValueError):
            return 0

    def get_user_credential_by_username(self, username):
        return {'username': username, 'password': self._args.get('password')}

    def get_user_credential_by_account_id(self, account_id):
        return {'username': self._args.get('username'), 'password': self._args.get('password'),
                'name': account_id}

    # --- proxy ------------------------------------------------------------------------
    def get_proxy(self):
        p = self._proxy
        if not p or not p.get('enabled') or not p.get('host'):
            return {}
        return {'proxy_url': p.get('host'), 'proxy_port': p.get('port'),
                'proxy_username': p.get('username'), 'proxy_password': p.get('password'),
                'proxy_type': p.get('type', 'http')}

    def _proxies(self):
        p = self._proxy
        if not p or not p.get('enabled') or not p.get('host'):
            return None
        auth = ''
        if p.get('username'):
            auth = f"{p['username']}:{p.get('password', '')}@"
        scheme = p.get('type', 'http')
        url = f"{scheme}://{auth}{p['host']}:{p.get('port', 8080)}"
        return {'http': url, 'https': url}

    # --- HTTP (real) ------------------------------------------------------------------
    def send_http_request(self, url, method='GET', parameters=None, payload=None,
                          headers=None, cookies=None, verify=True, cert=None,
                          timeout=None, use_proxy=True, **_kw):
        import requests
        kwargs = {
            'params': parameters, 'headers': headers, 'cookies': cookies,
            'verify': verify, 'cert': cert, 'timeout': timeout or 30,
        }
        if use_proxy:
            proxies = self._proxies()
            if proxies:
                kwargs['proxies'] = proxies
        if payload is not None:
            if isinstance(payload, (dict, list)):
                kwargs['json'] = payload
            else:
                kwargs['data'] = payload
        return requests.request(method.upper(), url, **{k: v for k, v in kwargs.items() if v is not None})

    # --- events -----------------------------------------------------------------------
    def new_event(self, data, source=None, index=None, sourcetype=None, host=None,
                  time=None, done=True, unbroken=True, **_kw):
        return {
            'data': data if isinstance(data, str) else json.dumps(data),
            'source': source, 'sourcetype': sourcetype or self._args.get('sourcetype'),
            'index': index or self._index, 'host': host, 'time': time,
        }

    # --- logging ----------------------------------------------------------------------
    def _log(self, level, msg):
        self._logs.append(f'[{level}] {msg}')

    def log(self, msg):
        self._log('INFO', msg)

    def log_debug(self, msg):
        self._log('DEBUG', msg)

    def log_info(self, msg):
        self._log('INFO', msg)

    def log_warning(self, msg):
        self._log('WARNING', msg)

    def log_error(self, msg):
        self._log('ERROR', msg)

    def log_critical(self, msg):
        self._log('CRITICAL', msg)


def _install_import_shims():
    """The generated helper may `import import_declare_test` (a UCC path bootstrap) at module
    load. Stub it (and a couple of common UCC modules) so the helper imports standalone — we
    replace the helper OBJECT, so these are never actually used."""
    for name in ('import_declare_test',):
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)


def main():
    logs = []
    try:
        req = json.loads(sys.stdin.read() or '{}')
        code = req.get('helperCode') or ''
        args = req.get('args') or {}
        index = req.get('index') or 'main'
        proxy = req.get('proxy')
        max_events = int(req.get('maxEvents') or MAX_EVENTS_DEFAULT)
        if not code.strip():
            print(json.dumps({'ok': False, 'error': 'helperCode is required', 'logs': logs}))
            return

        _install_import_shims()
        events = []
        helper = StubHelper(args, index, proxy, logs)
        ew = CaptureEventWriter(events)

        ns = {'__name__': 'emulated_helper'}
        try:
            exec(compile(code, '<helper>', 'exec'), ns)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({'ok': False, 'error': f'helper import failed: {type(e).__name__}: {e}',
                              'trace': traceback.format_exc()[-1800:], 'logs': logs}))
            return

        fn = ns.get('collect_events') or ns.get('stream_events')
        if not callable(fn):
            print(json.dumps({'ok': False,
                              'error': 'helper defines no collect_events/stream_events function',
                              'logs': logs}))
            return

        fn(helper, ew)
        truncated = len(events) > max_events
        print(json.dumps({'ok': True, 'count': len(events), 'truncated': truncated,
                          'events': events[:max_events], 'logs': logs}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}',
                          'trace': traceback.format_exc()[-1800:], 'logs': logs}))


if __name__ == '__main__':
    main()
