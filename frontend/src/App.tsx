import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
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
import ApiDocsPage from './pages/ApiDocsPage';
import CrossPlatformPage from './pages/CrossPlatformPage';
import WorkflowPage from './pages/WorkflowPage';
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

  useEffect(() => {
    accessStatsApi.track(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

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
            {/* Crash 服务 */}
            <Route path="symbolicate" element={<SymbolicatePage />} />
            <Route path="manage" element={<ManagePage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="sentry-service" element={<SentryServicePage />} />
            {/* Pods 组件管理 */}
            <Route path="pods" element={<PodsPage />} />
            {/* CI/CD 管理 */}
            <Route path="cicd" element={<CICDPage />} />
            <Route path="cicd/quality" element={<CICDPage />} />
            <Route path="cicd/devices" element={<CICDPage />} />
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
          </Route>
          <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
