import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/common/Toast';
import ErrorBoundary from './components/common/ErrorBoundary';
import AppLayout from './components/layout/AppLayout';
import Dashboard from './pages/Dashboard';
import Instances from './pages/Instances';
import InstanceDetail from './pages/InstanceDetail';
import DatabaseCleanup from './pages/DatabaseCleanup';
import Statements from './pages/Statements';
import StatementDetail from './pages/StatementDetail';
import Alerts from './pages/Alerts';
import JobRuns from './pages/JobRuns';
import Settings from './pages/Settings';
import AlertsHub from './pages/AlertsHub';
import ClusterDetail from './pages/ClusterDetail';
import HealthReport from './pages/HealthReport';
import ReportHistory from './pages/ReportHistory';
import ClusterQuery from './pages/ClusterQuery';
import ClusterGroupDetail from './pages/ClusterGroupDetail';
import GrafanaEmbed from './pages/GrafanaEmbed';
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
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/instances" element={<Instances />} />
                <Route path="/instances/cleanup" element={<DatabaseCleanup />} />
                <Route path="/instances/:id" element={<InstanceDetail />} />
                <Route path="/statements" element={<Statements />} />
                <Route path="/statements/:seriesId" element={<StatementDetail />} />
                <Route path="/alerts" element={<AlertsHub />} />
                <Route path="/alerts/rules" element={<AlertsHub />} />
                <Route path="/alerts/adaptive" element={<AlertsHub />} />
                <Route path="/alerts/templates" element={<AlertsHub />} />
                <Route path="/alerts/:id" element={<Alerts />} />
                <Route path="/jobs" element={<JobRuns />} />
                <Route path="/reports/history" element={<ReportHistory />} />
                <Route path="/cluster-query/:queryid" element={<ClusterQuery />} />
                {/* /clusters → Instances Hub'da kümeler view'ına redirect */}
                <Route path="/clusters" element={<Navigate to="/instances?view=clusters" replace />} />
                <Route path="/clusters/:cluster_id" element={<ClusterGroupDetail />} />
                <Route path="/settings" element={<Settings />} />
                {/* Eski route'lar — yeni AlertsHub'a redirect */}
                <Route path="/settings/alert-rules" element={<Navigate to="/alerts/rules" replace />} />
                <Route path="/settings/adaptive-alerting" element={<Navigate to="/alerts/adaptive" replace />} />
                {/* /cluster-detail Instances Hub'a redirect — instance detay /instances/:id'de */}
                <Route path="/cluster-detail" element={<Navigate to="/instances" replace />} />
                <Route path="/cluster/:id" element={<ClusterDetail />} />
                <Route path="/cluster/:id/health-report" element={<HealthReport />} />
                <Route path="/grafana/:uid" element={<GrafanaEmbed />} />
                <Route path="/grafana" element={<GrafanaEmbed />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
