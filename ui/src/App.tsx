import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/common/Toast';
import AppLayout from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Instances from './pages/Instances';
import InstanceDetail from './pages/InstanceDetail';
import Statements from './pages/Statements';
import StatementDetail from './pages/StatementDetail';
import Alerts from './pages/Alerts';
import JobRuns from './pages/JobRuns';
import Settings from './pages/Settings';
import AlertRules from './pages/AlertRules';
import ClusterDetail from './pages/ClusterDetail';
import Login from './pages/Login';
import { getToken } from './api/client';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 30000,
      staleTime: 10000,
    },
  },
});

// Token yoksa login'e yönlendir
function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/instances" element={<Instances />} />
              <Route path="/instances/:id" element={<InstanceDetail />} />
              <Route path="/statements" element={<Statements />} />
              <Route path="/statements/:seriesId" element={<StatementDetail />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/jobs" element={<JobRuns />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/alert-rules" element={<AlertRules />} />
              <Route path="/cluster-detail" element={<ClusterDetail />} />
              <Route path="/cluster/:id" element={<ClusterDetail />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
