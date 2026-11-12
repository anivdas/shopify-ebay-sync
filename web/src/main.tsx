import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';
import { ConfirmProvider, RouterProvider, ToastProvider } from './ui.tsx';

createRoot(document.getElementById('root')!).render(
  <RouterProvider>
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  </RouterProvider>,
);
