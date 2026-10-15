import './lib/theme';
import './index.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider, useAuth } from './lib/auth';
import { ArmonyPage } from './pages/Armony';
import { Dashboard } from './pages/Dashboard';
import { DockerPage } from './pages/Docker';
import { DownloadsPage } from './pages/Downloads';
import { IntegrationsPage } from './pages/Integrations';
import { Login } from './pages/Login';
import { MediaPage } from './pages/Media';
import { MediaAutomationPage } from './pages/MediaAutomation';
import { SecurityPage } from './pages/Security';
import { SystemPage } from './pages/System';
import { UpcomingPage } from './pages/Upcoming';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4_000,
      retry: (n, e) => !(e instanceof ApiError && [400, 401, 403, 404].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function App() {
  const { state, user } = useAuth();
  if (!state)
    return (
      <div className="flex h-full items-center justify-center">
        <img src="/favicon.svg" alt="Caricamento" className="size-10 animate-pulse" />
      </div>
    );
  if (!user) return <Login setup={state.setupRequired} />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="sistema" element={<SystemPage />} />
        <Route path="docker" element={<DockerPage />} />
        <Route path="media" element={<MediaPage />} />
        <Route path="media-automation" element={<MediaAutomationPage />} />
        <Route path="download" element={<DownloadsPage />} />
        <Route path="armony" element={<ArmonyPage />} />
        <Route path="integrazioni" element={<IntegrationsPage />} />
        <Route path="sicurezza" element={<SecurityPage />} />
        <Route path="in-arrivo/media-automation" element={<Navigate to="/media-automation" replace />} />
        <Route path="in-arrivo/:id" element={<UpcomingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
