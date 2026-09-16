import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './App.js';
import './styles.css';

/**
 * Dashboard entry point (CMP-13).
 *
 * Mounting only. The tree is in `App.tsx` so that it can be read without the
 * bootstrap noise, and so a future component test has something to render.
 */
const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <Dashboard />
    </StrictMode>,
  );
