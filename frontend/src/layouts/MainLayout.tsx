import { useEffect, useState } from 'react';
import { Layout, Menu, Dropdown, Space, Avatar, Button, Badge } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
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
} from '@ant-design/icons';
import { authUtils } from '../utils/auth';
import { authApi } from '../services/api';

const { Header, Content } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setAuthVersion] = useState(0);
  const [pendingRegistrationCount, setPendingRegistrationCount] = useState(0);
  const isAuthenticated = authUtils.isAuthenticated();
  const currentUser = authUtils.getUser();
  const currentRole = currentUser?.role || 'guest';
  const isAdmin = isAuthenticated && currentRole === 'admin';
  const canUseQuality = isAuthenticated && ['tester', 'developer', 'admin'].includes(currentRole);
  const canAccessCrashTools = isAuthenticated && ['developer', 'admin'].includes(currentRole);
  const canAccessQualityCenter = isAdmin;
  const canAccessRoleManagement = isAdmin;
  const canAccessAccessStats = isAdmin;
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
      <span style={{ color: roleMenuTextColor }}>角色权限管理</span>
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
    void authUtils.refreshUser();
  }, []);

  useEffect(() => {
    const path = location.pathname;
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
    }
  }, [
    canAccessAccessStats,
    canAccessCrashTools,
    canAccessQualityCenter,
    canAccessRoleManagement,
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
      label: <span onClick={() => navigate(canAccessCrashTools ? '/sentry-service' : '/history')}>Crash 服务</span>,
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
      label: 'Pods 组件',
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
            📱 iOS 移动管理平台
          </div>
          <Menu
            theme="dark"
            mode="horizontal"
            selectedKeys={[getSelectedKey()]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ flex: 1, minWidth: 0 }}
          />
        </div>

        {isAuthenticated ? (
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: 'pointer', paddingLeft: 12, whiteSpace: 'nowrap' }}>
              <Avatar
                icon={isAdmin ? <CrownOutlined /> : <UserOutlined />}
                style={{ backgroundColor: isAdmin ? '#faad14' : '#1677ff' }}
              />
              <span style={{ color: 'white' }}>{roleLabel}・{currentUser?.username}</span>
            </Space>
          </Dropdown>
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
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
}
