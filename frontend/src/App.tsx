import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import HomePage from './pages/HomePage';
import SymbolicatePage from './pages/SymbolicatePage';
import ManagePage from './pages/ManagePage';
import HistoryPage from './pages/HistoryPage';
import PodsPage from './pages/PodsPage';
import CICDPage from './pages/CICDPage';
import GitPage from './pages/GitPage';
import LogsPage from './pages/LogsPage';
import LogsPairPage from './pages/LogsPairPage';
import RoutesPage from './pages/RoutesPage';
import LoginPage from './pages/LoginPage';
import SentryServicePage from './pages/SentryServicePage';
import { authUtils } from './utils/auth';

message.config({
  top: 80,
  duration: 3,
  maxCount: 3,
});

function App() {
  const handleLogin = (password: string, isAdmin: boolean) => {
    authUtils.setToken(password);
    authUtils.setAdmin(isAdmin);
  };

  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<HomePage />} />
            {/* 崩溃日志符号化 */}
            <Route path="symbolicate" element={<SymbolicatePage />} />
            <Route path="manage" element={<ManagePage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="sentry-service" element={<SentryServicePage />} />
            {/* Pods 组件管理 */}
            <Route path="pods" element={<PodsPage />} />
            {/* CI/CD 管理 */}
            <Route path="cicd" element={<CICDPage />} />
            {/* Git 管理 */}
            <Route path="git" element={<GitPage />} />
            {/* 日志分析 */}
            <Route path="logs" element={<LogsPage />} />
            <Route path="logs/pair" element={<LogsPairPage />} />
            {/* 路由管理 */}
            <Route path="routes" element={<RoutesPage />} />
          </Route>
          <Route path="/login" element={<LoginPage onLogin={handleLogin} />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
