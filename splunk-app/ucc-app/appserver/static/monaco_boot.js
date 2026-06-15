/* Monaco bootstrap, loaded as an EXTERNAL script inside the editor iframe's srcdoc
 * (after vs/loader.js). Kept external (not inline) so it runs even under a strict
 * script-src CSP, and srcdoc keeps it out of Splunk Web's static-HTML injection. */
(function () {
  var me = (document.currentScript && document.currentScript.src) || '';
  var base = me.replace(/\/monaco_boot\.js.*$/, '');           // .../app/ucc_app_builder
  // Run language services on the main thread (avoids cross-document worker setup;
  // the editor still renders + highlights). Good enough for review/edit.
  self.MonacoEnvironment = { getWorker: function () { return { postMessage: function () {}, addEventListener: function () {}, terminate: function () {} }; } };
  require.config({ paths: { vs: base + '/vendor/monaco/vs' } });
  require(['vs/editor/editor.main'], function () {
    var editor = monaco.editor.create(document.getElementById('ed'), {
      value: '', language: 'json', automaticLayout: true, minimap: { enabled: false },
      scrollBeyondLastLine: false, fontSize: 12, theme: 'vs'
    });
    window.addEventListener('message', function (e) {
      var m = e.data || {};
      if (m.type === 'set') {
        editor.setValue(m.value || '');
        if (m.language) { monaco.editor.setModelLanguage(editor.getModel(), m.language); }
      } else if (m.type === 'get') {
        parent.postMessage({ type: 'content', reqId: m.reqId, value: editor.getValue() }, '*');
      }
    });
    parent.postMessage({ type: 'monaco-ready' }, '*');
  });
})();
