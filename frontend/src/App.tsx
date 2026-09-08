import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import ApplicationServicesPage from './pages/ApplicationServicesPage';
import ApplicationsPage from './pages/ApplicationsPage';
import AndroidPage from './pages/AndroidPage';
import MainLayout from './layouts/MainLayout';
import HomePage from './pages/HomePage';
import SymbolicatePage from './pages/SymbolicatePage';
import ManagePage from './pages/ManagePage';
import HistoryPage from './pages/HistoryPage';
import PodsPage from './pages/PodsPage';
import CICDPage from './pages/CICDPage';
import DevOpsPage from './pages/DevOpsPage';
import LogsPage from './pages/LogsPage';
import LogsPairPage from './pages/LogsPairPage';
import RoutesPage from './pages/RoutesPage';
import LoginPage from './pages/LoginPage';
import SentryServicePage from './pages/SentryServicePage';
import AccessStatsPage from './pages/AccessStatsPage';
import AssistantInsightsPage from './pages/AssistantInsightsPage';
import ApiDocsPage from './pages/ApiDocsPage';
import CrossPlatformPage from './pages/CrossPlatformPage';
import WorkflowPage from './pages/WorkflowPage';
import DeviceConsolePage from './pages/DeviceConsolePage';
import ReplayCenterPage from './pages/ReplayCenterPage';
import ReplayFlowEditorPage from './pages/ReplayFlowEditorPage';
import { authUtils } from './utils/auth';
import type { AuthUser } from './utils/auth';
import { accessStatsApi } from './services/api';

message.config({
  top: 80,
  duration: 3,
  maxCount: 3,
});

function AccessTracker() {
  const location = useLocation();
  const currentPath = `${location.pathname}${location.search}`;

  useEffect(() => {
    accessStatsApi.track(currentPath);
  }, [currentPath]);

  useEffect(() => {
    const handleAuthStateChanged = () => {
      accessStatsApi.track(currentPath);
    };
    window.addEventListener('auth-state-changed', handleAuthStateChanged);
    return () => {
      window.removeEventListener('auth-state-changed', handleAuthStateChanged);
    };
  }, [currentPath]);

  return null;
}

function App() {
  const handleLogin = (user: AuthUser) => {
    authUtils.setUser(user);
  };

  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <AccessTracker />
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<HomePage />} />
            <Route path="services" element={<ApplicationServicesPage />} />
            <Route path="bugly" element={<ApplicationServicesPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="android" element={<AndroidPage />} />
            {/* Crash 服务 */}
            <Route path="symbolicate" element={<SymbolicatePage />} />
            <Route path="manage" element={<ManagePage />} />
            <Route path="roles" element={<ManagePage roleManagementOnly />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="sentry-service" element={<SentryServicePage />} />
            {/* 组件库 */}
            <Route path="pods" element={<PodsPage />} />
            {/* CI/CD 管理 */}
            <Route path="cicd" element={<CICDPage />} />
            <Route path="cicd/quality" element={<CICDPage />} />
            <Route path="cicd/replay" element={<ReplayCenterPage />} />
            <Route path="cicd/replay/new" element={<DeviceConsolePage mode="replay-create" />} />
            <Route path="cicd/replay/:assetId/edit" element={<ReplayFlowEditorPage />} />
            <Route path="cicd/devices" element={<CICDPage />} />
            <Route path="cicd/device-control" element={<DeviceConsolePage />} />
            {/* 日志服务 */}
            <Route path="logs" element={<LogsPage />} />
            <Route path="logs/pair" element={<LogsPairPage />} />
            {/* DevOps 技能库 */}
            <Route path="devops" element={<DevOpsPage />} />
            {/* 路由管理 */}
            <Route path="routes" element={<RoutesPage />} />
            {/* API 接口文档 */}
            <Route path="api-docs" element={<ApiDocsPage />} />
            {/* 跨端能力 */}
            <Route path="cross-platform" element={<CrossPlatformPage />} />
            {/* 移动研发质量中心 */}
            <Route path="workflow" element={<WorkflowPage />} />
            {/* 访问统计 */}
            <Route path="access-stats" element={<AccessStatsPage />} />
            {/* AI 提效看板 */}
            <Route path="assistant-insights" element={<AssistantInsightsPage />} />
          </Route>
          <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
