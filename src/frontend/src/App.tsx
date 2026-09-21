import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OfflineBanner } from './components/shell/OfflineBanner';
import { ProtectionBanner } from './components/shell/ProtectionBanner';
import { Overview } from './pages/Overview';
import { Investigation } from './pages/Investigation';
import { Tickets } from './pages/Tickets';
import { Schedule } from './pages/Schedule';
import { CloseLoop } from './pages/CloseLoop';
import { Landing } from './pages/Landing';

const queryClient = new QueryClient();
const Simulation = lazy(() => import('./pages/Simulation').then((module) => ({ default: module.Simulation })));

/**
 * There is one navigation system: the pill. On the map route it floats over the
 * full-bleed map; everywhere else it sits in the top row of PageHeader's console
 * bar, in the same screen position, so it does not move as you navigate.
 */
function Shell() {
  const { pathname, search, hash } = useLocation();
  if (pathname === '//map') return <Navigate to={{ pathname: '/map', search, hash }} replace />;

  return (
    <div className="h-screen overflow-hidden text-fg">
      {/* The shell owns the viewport height for every route, so a page never
          declares h-screen of its own. Pages used to, which meant the
          OfflineBanner's height was added on top of a full viewport and pushed
          the bottom of every screen out of view whenever it rendered. */}
      <div className="flex h-full flex-col">
        <OfflineBanner />
        <ProtectionBanner />
        <div className="min-h-0 flex-1">
          <Routes>
            <Route path="/map" element={<Overview />} />
            {/* Investigation supersedes the old per-tower detail page, since
                deleted: origin/main repointed /tower/:towerId at it, so both
                paths land here. */}
            <Route path="/investigation" element={<Investigation />} />
            <Route path="/investigation/:towerId" element={<Investigation />} />
            <Route path="/tower/:towerId" element={<Investigation />} />
            <Route path="/loop" element={<CloseLoop />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/simulation" element={<Suspense fallback={<div role="status" className="p-6 text-muted">Loading simulation…</div>}><Simulation /></Suspense>} />
            <Route path="/health" element={<Navigate to="/map" replace />} />
            <Route path="/integrations" element={<Navigate to="/map" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/*" element={<Shell />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
