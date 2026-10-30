import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { LoginPage } from "@/auth/LoginPage";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeProvider } from "@/components/layout/Theme";
import { Spinner, ToastProvider } from "@/components/ui";

const OverviewPage = lazy(() => import("@/pages/overview/OverviewPage"));
const ApplicationsPage = lazy(() => import("@/pages/applications/ApplicationsPage"));
const CreateApplicationPage = lazy(() => import("@/pages/applications/CreateApplicationPage"));
const ApplicationDetailPage = lazy(() => import("@/pages/applications/ApplicationDetailPage"));
const OverviewTab = lazy(() => import("@/pages/applications/tabs/OverviewTab"));
const DeploymentsTab = lazy(() => import("@/pages/applications/tabs/DeploymentsTab"));
const BuildLogsTab = lazy(() => import("@/pages/applications/tabs/BuildLogsTab"));
const ConfigurationTab = lazy(() => import("@/pages/applications/tabs/ConfigurationTab"));
const DomainsTab = lazy(() => import("@/pages/applications/tabs/DomainsTab"));
const EnvironmentTab = lazy(() => import("@/pages/applications/tabs/EnvironmentTab"));
const SettingsTab = lazy(() => import("@/pages/applications/tabs/SettingsTab"));
const DeploymentsPage = lazy(() => import("@/pages/runs/DeploymentsPage"));
const BuildRunsPage = lazy(() => import("@/pages/runs/BuildRunsPage"));
const ReleaseDetailPage = lazy(() => import("@/pages/runs/ReleaseDetailPage"));
const InfrastructurePage = lazy(() => import("@/pages/infrastructure/InfrastructurePage"));
const ServersPage = lazy(() => import("@/pages/infrastructure/ServersPage"));
const RegistriesPage = lazy(() => import("@/pages/infrastructure/RegistriesPage"));
const DomainsPage = lazy(() => import("@/pages/infrastructure/DomainsPage"));
const PipelinesPage = lazy(() => import("@/pages/pipelines/PipelinesPage"));
const ActivityPage = lazy(() => import("@/pages/activity/ActivityPage"));
const LogsPage = lazy(() => import("@/pages/logs/LogsPage"));
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage"));
const SecretsPage = lazy(() => import("@/pages/settings/SecretsPage"));
const AccountPage = lazy(() => import("@/pages/settings/AccountPage"));
const RepoPilotPage = lazy(() => import("@/pages/repopilot/RepoPilotPage"));
const RepoPilotRunPage = lazy(() => import("@/pages/repopilot/RunDetailPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));

function Routed() {
  const { client } = useAuth();

  if (!client) return <LoginPage />;

  return (
    <Suspense fallback={<div className="content"><Spinner /></div>}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="applications/new" element={<CreateApplicationPage />} />
          <Route path="applications/:name" element={<ApplicationDetailPage />}>
            <Route index element={<OverviewTab />} />
            <Route path="deployments" element={<DeploymentsTab />} />
            <Route path="logs" element={<BuildLogsTab />} />
            <Route path="configuration" element={<ConfigurationTab />} />
            <Route path="domains" element={<DomainsTab />} />
            <Route path="environment" element={<EnvironmentTab />} />
            <Route path="settings" element={<SettingsTab />} />
          </Route>
          <Route path="pipelines" element={<PipelinesPage />} />
          <Route path="deployments" element={<DeploymentsPage />} />
          <Route path="build-runs" element={<BuildRunsPage />} />
          <Route path="releases/:releaseId" element={<ReleaseDetailPage />} />
          <Route path="repopilot" element={<RepoPilotPage />} />
          <Route path="repopilot/runs/:runId" element={<RepoPilotRunPage />} />
          <Route path="infrastructure" element={<InfrastructurePage />} />
          <Route path="servers" element={<ServersPage />} />
          <Route path="registries" element={<RegistriesPage />} />
          <Route path="domains" element={<DomainsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/secrets" element={<SecretsPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Routed />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
