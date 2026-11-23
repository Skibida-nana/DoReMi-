import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import { App } from './app/App';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element in renderer index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
