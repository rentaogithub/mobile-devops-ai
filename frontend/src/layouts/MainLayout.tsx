import { hasApplicationServices, requiredServicesForPage } from '../../../backend/src/services/ApplicationServiceCatalog';
import { useEffect, useState } from 'react';
import { Layout, Menu, Dropdown, Space, Avatar, Button, Badge, Select, Spin } from 'antd';
import { Outlet, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  HomeOutlined,
  BugOutlined,
  AppstoreOutlined,
  RocketOutlined,
  FileSearchOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  LogoutOutlined,
  CrownOutlined,
  BarChartOutlined,
  ApiOutlined,
  MobileOutlined,
  ApartmentOutlined,
  UserOutlined,
  TeamOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { authUtils } from '../utils/auth';
import { authApi } from '../services/api';

const { Header, Content } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setAuthVersion] = useState(0);
  const [authHydrating, setAuthHydrating] = useState(true);
  const [pendingRegistrationCount, setPendingRegistrationCount] = useState(0);
  const isAuthenticated = authUtils.isAuthenticated();
  const currentUser = authUtils.getUser();
  const activeProductLine = authUtils.getActiveProductLine();
  const activeApplication = authUtils.getActiveApplication();
  const currentRole = authUtils.getActiveRole() || 'guest';
  const isAdmin = isAuthenticated && currentRole === 'admin';
  const isAndroid = activeApplication?.platform === 'android';
  const androidAllowed = ['/', '/android', '/applications', '/roles', '/access-stats', '/assistant-insights', '/services', '/bugly'];
  const platformRouteAllowed = (!isAndroid || androidAllowed.includes(location.pathname)) && hasApplicationServices(activeApplication, requiredServicesForPage(location.pathname)) && (isAdmin || !/^\/services(?:\/|$)/.test(location.pathname));
  const serviceLanding = isAndroid && hasApplicationServices(activeApplication, ['jenkins']) ? '/android' : isAdmin ? '/services' : '/';
  const canUseQuality = isAuthenticated && ['tester', 'developer', 'admin'].includes(currentRole);
  const canAccessCrashTools = isAuthenticated && ['developer', 'admin'].includes(currentRole);
  const canAccessQualityCenter = isAdmin;
  const canAccessRoleManagement = isAdmin;
  const canAccessAccessStats = isAdmin;
  const canAccessAssistantInsights = isAdmin;
  const roleLabelMap = {
    guest: '游客',
    tester: '测试',
    developer: '研发',
    product: '产品运营',
    admin: '管理员',
  } as const;
  const roleLabel = roleLabelMap[currentRole] || '游客';
  const roleMenuTextColor = location.pathname.startsWith('/roles') ? '#fff' : 'rgba(255, 255, 255, 0.65)';
  const roleMenuLabel = (
    <Badge
      dot={pendingRegistrationCount > 0}
      offset={[8, -2]}
      style={{ backgroundColor: '#ff4d4f' }}
    >
      <span style={{ color: roleMenuTextColor }}>配置管理</span>
    </Badge>
  );

  useEffect(() => {
    const refreshAuthState = () => setAuthVersion((value) => value + 1);
    window.addEventListener('storage', refreshAuthState);
    window.addEventListener('auth-state-changed', refreshAuthState);
    return () => {
      window.removeEventListener('storage', refreshAuthState);
      window.removeEventListener('auth-state-changed', refreshAuthState);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authUtils.refreshUser().finally(() => {
      if (!cancelled) setAuthHydrating(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authHydrating) return;
    const path = location.pathname;
    if (!platformRouteAllowed) { navigate(serviceLanding, { replace: true }); return; }
    if (path === '/applications' && !isAdmin) { navigate('/', { replace: true }); return; }
    if (!canAccessCrashTools && ['/sentry-service', '/symbolicate', '/manage'].some((prefix) => path.startsWith(prefix))) {
      navigate('/history', { replace: true });
      return;
    }
    if (!canAccessQualityCenter && path.startsWith('/workflow')) {
      navigate('/', { replace: true });
      return;
    }
    if (!canAccessRoleManagement && path.startsWith('/roles')) {
      navigate('/', { replace: true });
      return;
    }
    if (!canAccessAccessStats && path.startsWith('/access-stats')) {
      navigate('/', { replace: true });
      return;
    }
    if (!canAccessAssistantInsights && path.startsWith('/assistant-insights')) {
      navigate('/', { replace: true });
    }
  }, [
    platformRouteAllowed,
    serviceLanding,
    isAdmin,
    canAccessAssistantInsights,
    canAccessAccessStats,
    canAccessCrashTools,
    canAccessQualityCenter,
    canAccessRoleManagement,
    authHydrating,
    location.pathname,
    navigate,
  ]);

  useEffect(() => {
    const loadPendingRegistrationCount = async () => {
      if (!authUtils.isAdmin()) {
        setPendingRegistrationCount(0);
        return;
      }
      try {
        const response = await authApi.listRegistrationRequests();
        const pendingCount = (response.data || []).filter((request) => (
          request.status === 'pending' && request.requestedRole !== 'guest'
        )).length;
        setPendingRegistrationCount(pendingCount);
      } catch {
        setPendingRegistrationCount(0);
      }
    };

    void loadPendingRegistrationCount();
    window.addEventListener('platform-registration-requests-changed', loadPendingRegistrationCount);
    return () => {
      window.removeEventListener('platform-registration-requests-changed', loadPendingRegistrationCount);
    };
  }, [isAdmin, location.pathname]);

  // Determine which top-level menu key is active
  const getSelectedKey = () => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (path.startsWith('/roles')) {
      return '/roles';
    }
    if (['/sentry-service', '/history', '/symbolicate', '/manage'].some((prefix) => path.startsWith(prefix))) {
      return '/symbolicate-group';
    }
    if (path.startsWith('/cicd')) {
      return '/cicd-group';
    }
    // Match first segment
    const segment = '/' + path.split('/').filter(Boolean)[0];
    return segment;
  };

  const menuItems = [
    {
      key: '/',
      icon: <HomeOutlined />,
      label: '首页',
    },
    ...(canAccessQualityCenter ? [{
      key: '/workflow',
      icon: <ApartmentOutlined />,
      label: '质量中心',
    }] : []),
    {
      key: '/symbolicate-group',
      icon: <BugOutlined />,
      label: <span onClick={() => navigate(canAccessCrashTools && hasApplicationServices(activeApplication, ['sentry']) ? '/sentry-service' : '/history')}>Crash 服务</span>,
      children: [
        ...(canAccessCrashTools ? [{ key: '/sentry-service', label: 'Sentry 服务' }] : []),
        { key: '/history', label: '历史记录' },
        ...(canAccessCrashTools ? [
          { key: '/symbolicate', label: 'Crash 符号化' },
          { key: '/manage', label: 'dSYM 管理' },
        ] : []),
      ],
    },
    {
      key: '/pods',
      icon: <AppstoreOutlined />,
      label: '组件库',
    },
    {
      key: '/cicd-group',
      icon: <RocketOutlined />,
      label: <span onClick={() => navigate('/cicd')}>CI/CD</span>,
      children: [
        { key: '/cicd', label: '发布管理' },
        ...(canUseQuality ? [{ key: '/cicd/quality', label: '自动质检' }] : []),
        ...(canUseQuality ? [{ key: '/cicd/replay', label: '回放中心' }] : []),
        ...(canUseQuality ? [{ key: '/cicd/device-control', label: '真机调试台' }] : []),
        { key: '/cicd/devices', label: 'iOS设备注册' },
      ],
    },
    {
      key: '/logs',
      icon: <FileSearchOutlined />,
      label: '日志服务',
    },
    {
      key: '/devops',
      icon: <ToolOutlined />,
      label: 'DevOps 技能库',
    },
    {
      key: '/api-docs',
      icon: <ApiOutlined />,
      label: 'API 接口',
    },
    {
      key: '/routes',
      icon: <NodeIndexOutlined />,
      label: '路由管理',
    },
    {
      key: '/cross-platform',
      icon: <MobileOutlined />,
      label: '跨端能力',
    },
    ...(canAccessRoleManagement ? [{
      key: '/roles',
      icon: <TeamOutlined />,
      label: roleMenuLabel,
    }] : []),
    ...(canAccessAccessStats ? [{
      key: '/access-stats',
      icon: <BarChartOutlined />,
      label: '访问统计',
    }] : []),
    ...(canAccessAssistantInsights ? [{
      key: '/assistant-insights',
      icon: <RobotOutlined />,
      label: 'AI 提效看板',
    }] : []),
  ];

  const visibleMenuItems = [
    ...menuItems.map((item) => ({ ...item, ...(item.children ? { children: item.children.filter((child) => hasApplicationServices(activeApplication, requiredServicesForPage(child.key))) } : {}) })).filter((item) => (!isAndroid || androidAllowed.includes(item.key)) && hasApplicationServices(activeApplication, requiredServicesForPage(item.key)) && (!item.children || item.children.length > 0)),
    ...(isAdmin ? [{ key: '/services', icon: <AppstoreOutlined />, label: '应用服务' }] : []),
    ...(hasApplicationServices(activeApplication, ['bugly']) ? [{ key: '/bugly', icon: <BugOutlined />, label: 'Bugly 崩溃' }] : []),
    ...(isAndroid && hasApplicationServices(activeApplication, ['jenkins']) ? [{ key: '/android', icon: <MobileOutlined />, label: 'Android 交付' }] : []),
    ...(isAdmin ? [{ key: '/applications', icon: <AppstoreOutlined />, label: '应用接入' }] : []),
  ];

  const handleLogin = () => {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    navigate(`/login?redirect=${encodeURIComponent(redirect)}`);
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      authUtils.clearUser();
      navigate('/');
    }
  };

  const userMenuItems = [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: handleLogout,
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#001529',
          justifyContent: 'space-between',
          padding: '0 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, overflow: 'hidden' }}>
          <div
            style={{
              color: 'white',
              fontSize: '18px',
              fontWeight: 'bold',
              marginRight: '20px',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            }}
            onClick={() => navigate('/')}
          >
            📱 移动管理平台
          </div>
          <Menu
            theme="dark"
            mode="horizontal"
            selectedKeys={[getSelectedKey()]}
            items={visibleMenuItems}
            onClick={({ key }) => navigate(key)}
            style={{ flex: 1, minWidth: 0 }}
          />
        </div>

        {authHydrating ? (
          <Button type="text" loading style={{ color: 'rgba(255, 255, 255, 0.85)' }}>
            正在恢复登录
          </Button>
        ) : isAuthenticated ? (
          <Space size={10} style={{ paddingLeft: 12, whiteSpace: 'nowrap' }}>
            <Select
              value={activeProductLine?.id}
              onChange={(value) => authUtils.setActiveProductLine(value)}
              options={(currentUser?.productLines || []).map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              style={{ minWidth: 120 }}
              popupMatchSelectWidth={false}
            />
            {activeProductLine?.applications?.length ? <Select
              aria-label="当前应用" value={activeApplication?.id} style={{ minWidth: 120 }}
              onChange={(value) => authUtils.setActiveApplication(value)}
              options={activeProductLine.applications.filter((app) => app.active).map((app) => ({ value: app.id, label: app.platform === 'android' ? 'Android' : 'iOS' }))}
            /> : null}
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
              <Avatar
                icon={isAdmin ? <CrownOutlined /> : <UserOutlined />}
                style={{ backgroundColor: isAdmin ? '#faad14' : '#1677ff' }}
              />
              <span style={{ color: 'white' }}>{roleLabel}・{currentUser?.username}</span>
              </Space>
            </Dropdown>
          </Space>
        ) : (
          <Button
            type="primary"
            icon={<CrownOutlined />}
            onClick={handleLogin}
          >
            登录
          </Button>
        )}
      </Header>
      <Content style={{ padding: location.pathname === '/' ? 0 : '24px', background: '#f0f2f5', minWidth: 0 }}>
        <div
          style={{
            background: '#fff',
            padding: location.pathname === '/' ? 0 : '24px',
            minHeight: location.pathname === '/' ? 'calc(100vh - 64px)' : '500px',
            borderRadius: location.pathname === '/' ? 0 : 8,
            minWidth: 0,
          }}
        >
          {authHydrating ? (
            <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip="正在恢复登录状态..." />
            </div>
          ) : (
            platformRouteAllowed ? <Outlet key={`${activeProductLine?.id || 'public-nn'}:${activeApplication?.id || 'ios'}:${JSON.stringify(activeApplication?.services)}:${JSON.stringify(activeApplication?.serviceOptions)}:${activeApplication?.componentLibraryId || 'default-library'}`} /> : <Navigate to={serviceLanding} replace />
          )}
        </div>
      </Content>
    </Layout>
  );
}
