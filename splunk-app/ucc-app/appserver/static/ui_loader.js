/* Mounts the full standalone React SPA inside the native Splunk app.
 *
 * The SPA (built to appserver/static/ui/app.js|css) renders into #root. All of its
 * API traffic is repointed here — without touching SPA source — to a same-origin
 * Splunk REST proxy that forwards to the build engine, so there is no mixed-content
 * / CORS / cert problem and the existing backend is reused. */
require(['jquery', 'splunkjs/mvc/simplexml/ready!'], function ($) {
  'use strict';
  console.log('UCC_LOADER_RAN');
  var APP = 'ucc_app_builder';
  var locale = (window.location.pathname.split('/')[1]) || 'en-US';
  var staticBase = '/' + locale + '/static/app/' + APP;
  var proxyBase = '/' + locale + '/splunkd/__raw/services/' + APP + '/proxy';

  // 1) api.ts builds `${API_BASE}/health` etc.; keep it as a bare '/api' so every call
  //    flows through the single interceptor below.
  window.__UCC_API_BASE__ = '/api';

  // Tell the SPA it is running behind the buffering Splunk REST proxy. A persistent
  // REST handler must return its whole payload at once, so it CANNOT stream SSE
  // incrementally — the server-managed agent loop would otherwise arrive as one burst
  // at completion. The AI panel uses this flag to drive its agent loop client-side
  // (one buffered round-trip per turn) so progress appears step by step instead.
  window.__UCC_PROXIED__ = true;

  // Splunk Web protects POST/PUT/DELETE through /splunkd/__raw/ with a CSRF token —
  // the value of the `splunkweb_csrf_token_<port>` cookie, sent as X-Splunk-Form-Key.
  // CRITICAL: a browser may hold tokens for MULTIPLE Splunk ports (e.g. 8000 AND 8001);
  // we must pick THIS server's port (Splunk validates against splunkweb_csrf_token_
  // <MRSPARKLE_PORT_NUMBER>), not just the first match — else CSRF validation fails.
  function readCookie(name) {
    var parts = (document.cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].replace(/^\s+/, '');
      if (c.indexOf(name + '=') === 0) {
        return decodeURIComponent(c.substring(name.length + 1));
      }
    }
    return '';
  }
  function csrfToken() {
    var port = (window.$C && window.$C.MRSPARKLE_PORT_NUMBER) || window.location.port || '8000';
    var tok = readCookie('splunkweb_csrf_token_' + port);
    if (tok) { return tok; }
    if (window.$C && window.$C.FORM_KEY) { return window.$C.FORM_KEY; }
    return '';
  }

  // 2) Route ALL '/api/...' calls through the same-origin proxy. The real path+query is
  //    passed in the `p` param so the splunkd path stays one segment ('.../proxy') that
  //    a single web.conf expose pattern allows (Splunk expose '*' = one segment only).
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url);
      if (url && url.indexOf('/api/') === 0) {
        var rewritten = proxyBase + '?p=' + encodeURIComponent(url);
        var token = csrfToken();
        // Splunk Web only reads X-Splunk-Form-Key when the request is XHR
        // (X-Requested-With: XMLHttpRequest); otherwise it expects a splunk_form_key
        // FORM param. So both headers are required for the proxy POST to pass CSRF.
        if (typeof input === 'string') {
          init = init || {};
          var h = new Headers((init && init.headers) || {});
          if (token) { h.set('X-Splunk-Form-Key', token); }
          h.set('X-Requested-With', 'XMLHttpRequest');
          init.headers = h;
          input = rewritten;
        } else {
          var req = new Request(rewritten, input);
          try {
            if (token) { req.headers.set('X-Splunk-Form-Key', token); }
            req.headers.set('X-Requested-With', 'XMLHttpRequest');
          } catch (e) {}
          input = req;
        }
      }
    } catch (e) { /* fall through with original */ }
    return origFetch(input, init);
  };

  // 3) Tell @monaco-editor/react to load Monaco from the vendored copy, not a CDN.
  window.__UCC_MONACO_VS__ = staticBase + '/vendor/monaco/vs';

  // 4) Ensure a mount node, then inject the SPA bundle.
  var root = document.getElementById('root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'root';
    (document.querySelector('.dashboard-body') || document.body).appendChild(root);
  }
  var css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = staticBase + '/ui/app.css';
  document.head.appendChild(css);
  var js = document.createElement('script');
  js.type = 'module'; js.src = staticBase + '/ui/app.js';
  document.body.appendChild(js);

  // 5) Give #root a DEFINITE height = the space from its top edge to the bottom of the
  //    viewport. The SPA shell (and the Monaco editor inside it) is height:100%, which
  //    only resolves against a parent with a concrete height. Inside the Splunk
  //    dashboard #root sits below the app chrome at a variable offset, so we measure it
  //    rather than guessing a fixed inset. Without this the shell was 100vh tall, its
  //    lower part (the editor) fell below the fold, and overflow:hidden made that
  //    content unreachable. Recompute on resize and after the chrome settles.
  function sizeRoot() {
    var top = root.getBoundingClientRect().top + (window.scrollY || 0);
    var h = Math.max(320, window.innerHeight - top);
    root.style.height = h + 'px';
    root.style.minHeight = '0';
    root.style.overflow = 'hidden';
  }
  sizeRoot();
  window.addEventListener('resize', sizeRoot);
  // The Splunk header/nav can lay out a frame or two after ready!; re-measure so the
  // editor lines up with the real available height.
  [100, 400, 1000].forEach(function (ms) { setTimeout(sizeRoot, ms); });
});
