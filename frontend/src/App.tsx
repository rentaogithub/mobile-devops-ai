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
import { authUtils } from './utils/auth';
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
  const handleLogin = (password: string, isAdmin: boolean) => {
    authUtils.setToken(password);
    authUtils.setAdmin(isAdmin);
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
            {/* 日志服务 */}
            <Route path="logs" element={<LogsPage />} />
            <Route path="logs/pair" element={<LogsPairPage />} />
            {/* DevOps 技能库 */}
            <Route path="devops" element={<DevOpsPage />} />
            {/* 路由管理 */}
            <Route path="routes" element={<RoutesPage />} />
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
