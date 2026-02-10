import React from 'react';
import ReactDOM from 'react-dom/client';
import { SplunkThemeProvider } from '@splunk/themes';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SplunkThemeProvider family="enterprise" colorScheme="dark" density="comfortable">
      <App />
    </SplunkThemeProvider>
  </React.StrictMode>
);
