/* App Builder Advisor — Splunk Web dashboard page.
 *
 * Describe an add-on -> the in-app Agent (Splunk Agent SDK / splunklib.ai) authors and
 * builds it (AppInspect-clean) -> review/edit the authored files in Monaco -> save &
 * rebuild. AI provider/model/temperature are configurable (TrackMe-style); for OpenRouter
 * the model list is populated dynamically with only tool-enabled (agentic) models.
 * All calls go to this app's own REST endpoints (the same tools exposed on the Splunk MCP
 * Server), authenticated by the current Splunk Web session via splunkjs.
 */
require([
  'jquery',
  'splunkjs/mvc',
  'splunkjs/mvc/simplexml/ready!'
], function ($, mvc) {
  'use strict';

  var APP = 'ucc_app_builder';
  var service = mvc.createService({ owner: 'nobody', app: APP });
  var aiCfg = { settings: {}, keySet: {}, providers: ['openrouter', 'openai', 'anthropic', 'google'] };

  function staticAppUrl(file) {
    // Splunk serves app static at /<locale>/static/app/<app>/<file>. Derive the
    // locale from the current page path (e.g. /en-US/app/ucc_app_builder/advisor).
    var locale = (window.location.pathname.split('/')[1]) || 'en-US';
    return '/' + locale + '/static/app/' + APP + '/' + file;
  }

  function call(endpoint, bodyObj, cb) {
    service.request(
      '/services/' + APP + '/' + endpoint, 'POST',
      null, null, JSON.stringify(bodyObj || {}),
      { 'Content-Type': 'application/json' },
      function (err, resp) {
        if (err) {
          var msg = err;
          try { msg = JSON.parse(err.data).error || err.data || err; } catch (e) {}
          cb(msg || 'request failed'); return;
        }
        var data = resp && (resp.data !== undefined ? resp.data : null);
        if (data === null && resp && resp.body) { try { data = JSON.parse(resp.body); } catch (e) {} }
        cb(null, data || {});
      }
    );
  }

  // ---- layout -------------------------------------------------------------
  var $root = $('#ucc-advisor-app').empty();
  $root.append(
    '<div class="ucc-grid">' +
    '  <div class="ucc-left">' +
    '    <div class="ucc-settings-toggle"><a href="#" id="ucc-toggle-settings">⚙ AI Settings</a><span id="ucc-cfg-summary" class="ucc-appid"></span></div>' +
    '    <div id="ucc-settings" class="ucc-settings" style="display:none">' +
    '      <div class="ucc-frow"><label>Provider</label><select id="cfg-provider"></select></div>' +
    '      <div class="ucc-frow"><label>API key</label><input id="cfg-key" type="password" placeholder="(unchanged)" /><span id="cfg-key-state" class="ucc-keystate"></span></div>' +
    '      <div class="ucc-frow" id="cfg-baseurl-row"><label>Base URL</label><input id="cfg-baseurl" type="text" /></div>' +
    '      <div class="ucc-frow"><label>Model</label><select id="cfg-model"></select><button id="cfg-refresh" class="btn" title="Refresh model list">↻</button></div>' +
    '      <div class="ucc-frow"><label>Model (free text)</label><input id="cfg-model-text" type="text" placeholder="or type a model id" /></div>' +
    '      <div class="ucc-frow"><label>Temperature</label><input id="cfg-temp" type="number" min="0" max="2" step="0.1" placeholder="default" /></div>' +
    '      <div class="ucc-frow"><label>Max steps</label><input id="cfg-maxsteps" type="number" min="1" max="100" /></div>' +
    '      <div class="ucc-frow"><label></label><button id="cfg-save" class="btn btn-primary">Save settings</button><span id="cfg-save-state" class="ucc-keystate"></span></div>' +
    '    </div>' +
    '    <h3>Describe your add-on</h3>' +
    '    <textarea id="ucc-prompt" rows="5" placeholder="e.g. Build an add-on called acme_logs with a required api_url text field (URL validator) and a logging tab."></textarea>' +
    '    <div class="ucc-controls"><button id="ucc-build" class="btn btn-primary">Build add-on</button></div>' +
    '    <div id="ucc-status" class="ucc-status"></div>' +
    '    <div id="ucc-answer" class="ucc-answer"></div>' +
    '  </div>' +
    '  <div class="ucc-right">' +
    '    <div class="ucc-filebar">' +
    '      <label>Project files:</label>' +
    '      <select id="ucc-files"><option value="">(none yet)</option></select>' +
    '      <span id="ucc-appid" class="ucc-appid"></span>' +
    '      <span class="ucc-spacer"></span>' +
    '      <button id="ucc-save" class="btn" disabled>Save</button>' +
    '      <button id="ucc-rebuild" class="btn" disabled>Rebuild &amp; Inspect</button>' +
    '    </div>' +
    '    <iframe id="ucc-monaco" class="ucc-monaco"></iframe>' +
    '  </div>' +
    '</div>'
  );

  var $status = $('#ucc-status'), $answer = $('#ucc-answer'), $files = $('#ucc-files');
  var $appid = $('#ucc-appid'), $build = $('#ucc-build'), $save = $('#ucc-save'), $rebuild = $('#ucc-rebuild');
  var monaco = document.getElementById('ucc-monaco'), monacoReady = false, currentPath = null;

  // Load Monaco inside the iframe via srcdoc (Splunk Web injects its page chrome into
  // served .html files, which breaks a standalone frame; srcdoc is fully ours). Only
  // external same-origin scripts -> CSP-safe.
  (function initMonaco() {
    var b = staticAppUrl('').replace(/\/$/, '');   // /<locale>/static/app/ucc_app_builder
    monaco.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<style>html,body,#ed{height:100%;width:100%;margin:0;padding:0}</style></head>' +
      '<body><div id="ed"></div>' +
      '<script src="' + b + '/vendor/monaco/vs/loader.js"><\/script>' +
      '<script src="' + b + '/monaco_boot.js"><\/script>' +
      '</body></html>';
  })();

  function log(msg, kind) {
    var ts = new Date().toLocaleTimeString();
    $status.prepend($('<div class="ucc-line">').addClass('ucc-' + (kind || 'info')).text('[' + ts + '] ' + msg));
  }
  function busy(on) { $build.prop('disabled', on).text(on ? 'Working…' : 'Build add-on'); }

  // ---- Monaco iframe bridge ----------------------------------------------
  window.addEventListener('message', function (e) {
    if ((e.data || {}).type === 'monaco-ready') { monacoReady = true; }
  });
  function setEditor(value, language) {
    if (!monacoReady) { return setTimeout(function () { setEditor(value, language); }, 150); }
    monaco.contentWindow.postMessage({ type: 'set', value: value, language: language || 'json' }, '*');
  }
  function getEditor(cb) {
    var reqId = String(Date.now());
    function onMsg(e) {
      var m = e.data || {};
      if (m.type === 'content' && m.reqId === reqId) { window.removeEventListener('message', onMsg); cb(m.value); }
    }
    window.addEventListener('message', onMsg);
    monaco.contentWindow.postMessage({ type: 'get', reqId: reqId }, '*');
  }
  function langFor(path) {
    if (/\.json$/.test(path)) return 'json';
    if (/\.py$/.test(path)) return 'python';
    if (/\.(conf|cfg|spec|manifest)$/.test(path)) return 'ini';
    if (/\.(md|markdown)$/.test(path)) return 'markdown';
    return 'plaintext';
  }

  // ---- AI settings --------------------------------------------------------
  function currentProvider() { return $('#cfg-provider').val() || 'openrouter'; }
  function currentModel() { return ($('#cfg-model-text').val() || '').trim() || $('#cfg-model').val() || ''; }
  function cfgSummary() {
    var s = aiCfg.settings || {};
    $('#ucc-cfg-summary').text('  ' + (s.ai_provider || 'openrouter') + ' · ' + (currentModel() || s.ai_model || '?'));
  }
  function loadConfig() {
    call('ai_config', { action: 'get' }, function (err, d) {
      if (err) { log('ai_config: ' + err, 'error'); return; }
      aiCfg = d; var s = d.settings || {};
      var $p = $('#cfg-provider').empty();
      (d.providers || aiCfg.providers).forEach(function (p) { $p.append($('<option>').val(p).text(p)); });
      $p.val(s.ai_provider || 'openrouter');
      $('#cfg-baseurl').val(s.ai_base_url || '');
      $('#cfg-temp').val(s.temperature || '');
      $('#cfg-maxsteps').val(s.max_steps || '40');
      $('#cfg-model-text').val('');
      onProviderChange(s.ai_model);
      updateKeyState();
      cfgSummary();
    });
  }
  function updateKeyState() {
    var set = (aiCfg.keySet || {})[currentProvider()];
    $('#cfg-key-state').text(set ? 'key saved ✓' : 'no key saved').toggleClass('ucc-ok', !!set);
  }
  function onProviderChange(preferModel) {
    var p = currentProvider();
    updateKeyState();
    $('#cfg-baseurl-row').toggle(p === 'openrouter' || p === 'openai');
    var $m = $('#cfg-model').empty();
    if (p === 'openrouter' || p === 'openai') {
      $m.append('<option value="">(loading models…)</option>');
      call('ai_models', { provider: p }, function (err, d) {
        $m.empty();
        if (err || !d || d.ok === false || !(d.models || []).length) {
          $m.append('<option value="">(use free text)</option>');
          log('model list: ' + (err || (d && d.error) || 'none — enter a model id in free text'), 'info');
        } else {
          d.models.forEach(function (m) { $m.append($('<option>').val(m.id).text(m.id)); });
          var want = preferModel || (aiCfg.settings || {}).ai_model;
          if (want && d.models.some(function (m) { return m.id === want; })) { $m.val(want); }
          log('Loaded ' + d.models.length + ' tool-enabled ' + p + ' models.', 'ok');
        }
        cfgSummary();
      });
    } else {
      $m.append('<option value="">(enter model id in free text)</option>');
      if (preferModel) { $('#cfg-model-text').val(preferModel); }
    }
  }
  $('#ucc-toggle-settings').on('click', function (e) { e.preventDefault(); $('#ucc-settings').slideToggle(120); });
  $('#cfg-provider').on('change', function () { onProviderChange(); cfgSummary(); });
  $('#cfg-model, #cfg-model-text').on('change keyup', cfgSummary);
  $('#cfg-refresh').on('click', function (e) { e.preventDefault(); onProviderChange(currentModel()); });
  $('#cfg-save').on('click', function () {
    var payload = {
      action: 'save', ai_provider: currentProvider(),
      ai_base_url: $('#cfg-baseurl').val().trim(), ai_model: currentModel(),
      temperature: $('#cfg-temp').val().trim(), max_steps: $('#cfg-maxsteps').val().trim()
    };
    var key = $('#cfg-key').val(); if (key) { payload.api_key = key; }
    $('#cfg-save-state').text('saving…').removeClass('ucc-ok');
    call('ai_config', payload, function (err, d) {
      if (err || (d && d.error)) { $('#cfg-save-state').text('error').addClass('ucc-error'); log('save settings: ' + (err || d.error), 'error'); return; }
      aiCfg = d; $('#cfg-key').val(''); $('#cfg-save-state').text('saved ✓').addClass('ucc-ok');
      updateKeyState(); cfgSummary(); log('AI settings saved.', 'ok');
    });
  });

  // ---- project files ------------------------------------------------------
  function refreshFiles(selectPath) {
    call('list_project', {}, function (err, d) {
      if (err) { log('list_project: ' + err, 'error'); return; }
      $appid.text(d.appId ? ('appId: ' + d.appId) : '');
      var files = d.files || [];
      $files.empty();
      if (!files.length) { $files.append('<option value="">(none yet)</option>'); return; }
      files.forEach(function (p) { $files.append($('<option>').attr('value', p).text(p)); });
      var pick = selectPath && files.indexOf(selectPath) >= 0 ? selectPath
               : (files.indexOf(d.appId + '/globalConfig.json') >= 0 ? d.appId + '/globalConfig.json' : files[0]);
      $files.val(pick); loadFile(pick);
    });
  }
  function loadFile(path) {
    if (!path) return;
    currentPath = path;
    call('read_file', { path: path }, function (err, d) {
      if (err) { log('read_file: ' + err, 'error'); return; }
      setEditor(d.found ? (d.content || '') : '', langFor(path));
      $save.prop('disabled', false); $rebuild.prop('disabled', false);
    });
  }

  // ---- actions ------------------------------------------------------------
  $build.on('click', function () {
    var prompt = $('#ucc-prompt').val().trim();
    if (!prompt) { log('Enter a description first.', 'error'); return; }
    busy(true); $answer.empty();
    log('Agent (Splunk Agent SDK) authoring + building — this can take ~30-90s…');
    call('advisor', {
      prompt: prompt, provider: currentProvider(), model: currentModel(),
      temperature: $('#cfg-temp').val().trim()
    }, function (err, d) {
      busy(false);
      if (err) { log('advisor: ' + err, 'error'); return; }
      if (d.error) { log('advisor: ' + d.error, 'error'); return; }
      log('Agent finished.', 'ok');
      $answer.text(typeof d.answer === 'string' ? d.answer : JSON.stringify(d.answer, null, 2));
      refreshFiles();
    });
  });
  $files.on('change', function () { loadFile($(this).val()); });
  $save.on('click', function () {
    if (!currentPath) return;
    getEditor(function (content) {
      call('write_file', { path: currentPath, content: content }, function (err, d) {
        if (err || (d && d.error)) { log('save: ' + (err || d.error), 'error'); return; }
        log('Saved ' + currentPath, 'ok');
      });
    });
  });
  $rebuild.on('click', function () {
    log('Building + AppInspect…'); $rebuild.prop('disabled', true);
    call('build_and_inspect', { includeWarnings: false }, function (err, d) {
      $rebuild.prop('disabled', false);
      if (err || (d && d.error)) { log('build: ' + (err || d.error), 'error'); return; }
      log('Build: ' + (d.clean ? 'AppInspect-CLEAN ✓' : 'not clean'), d.clean ? 'ok' : 'error');
      (d.trace || []).forEach(function (t) { log('  ' + t); });
      refreshFiles(currentPath);
    });
  });

  // init
  loadConfig();
  refreshFiles();
  log('Ready. Configure AI Settings, then describe an add-on and click Build.');
});
