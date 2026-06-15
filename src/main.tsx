import React from 'react';
import ReactDOM from 'react-dom/client';
import { SplunkThemeProvider } from '@splunk/themes';
import { loader } from '@monaco-editor/react';
import App from './App';
import './index.css';

// When embedded in the native Splunk app, load Monaco from the vendored copy (the app
// page loader sets __UCC_MONACO_VS__) instead of the public CDN — works offline / CSP.
const _vs = (window as unknown as { __UCC_MONACO_VS__?: string }).__UCC_MONACO_VS__;
if (_vs) {
  loader.config({ paths: { vs: _vs } });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SplunkThemeProvider family="enterprise" colorScheme="dark" density="comfortable">
      <App />
    </SplunkThemeProvider>
  </React.StrictMode>
);
