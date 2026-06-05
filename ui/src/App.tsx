import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/common/Toast';
import ErrorBoundary from './components/common/ErrorBoundary';
import AppLayout from './components/layout/AppLayout';
import { getToken } from './api/client';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Instances = lazy(() => import('./pages/Instances'));
const InstanceDetail = lazy(() => import('./pages/InstanceDetail'));
const DatabaseCleanup = lazy(() => import('./pages/DatabaseCleanup'));
const Statements = lazy(() => import('./pages/Statements'));
const StatementDetail = lazy(() => import('./pages/StatementDetail'));
const Alerts = lazy(() => import('./pages/Alerts'));
const JobRuns = lazy(() => import('./pages/JobRuns'));
const Settings = lazy(() => import('./pages/Settings'));
const AlertsHub = lazy(() => import('./pages/AlertsHub'));
const ClusterDetail = lazy(() => import('./pages/ClusterDetail'));
const HealthReport = lazy(() => import('./pages/HealthReport'));
const ReportHistory = lazy(() => import('./pages/ReportHistory'));
const Insights = lazy(() => import('./pages/Insights'));
const ClusterQuery = lazy(() => import('./pages/ClusterQuery'));
const ClusterGroupDetail = lazy(() => import('./pages/ClusterGroupDetail'));
const GrafanaEmbed = lazy(() => import('./pages/GrafanaEmbed'));
const Login = lazy(() => import('./pages/Login'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 30000,
      staleTime: 10000,
    },
  },
});

// Token yoksa login'e yönlendir
function RequireAuth({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function PageLoadingFallback() {
  return (
    <div className="flex items-center justify-center min-h-screen text-[#64748B]">
      <div className="flex flex-col items-center gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#3B82F6] border-t-transparent"></div>
        <span className="text-sm">Yukleniyor...</span>
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <Suspense fallback={<PageLoadingFallback />}>
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
                <Route path="/alerts/system-health" element={<AlertsHub />} />
                <Route path="/alerts/rules" element={<AlertsHub />} />
                <Route path="/alerts/adaptive" element={<AlertsHub />} />
                <Route path="/alerts/templates" element={<AlertsHub />} />
                <Route path="/alerts/:id" element={<Alerts />} />
                <Route path="/jobs" element={<JobRuns />} />
                <Route path="/insights" element={<Insights />} />
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
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
