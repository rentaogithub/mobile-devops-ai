import { useEffect, useState } from 'react';
import { Layout, Menu, Dropdown, Space, Avatar, Button } from 'antd';
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
} from '@ant-design/icons';
import { authUtils } from '../utils/auth';

const { Header, Content } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [, setAuthVersion] = useState(0);
  const isAuthenticated = authUtils.isAuthenticated();
  const isAdmin = isAuthenticated && authUtils.isAdmin();

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

  // Determine which top-level menu key is active
  const getSelectedKey = () => {
    const path = location.pathname;
    if (path === '/') return '/';
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
    {
      key: '/workflow',
      icon: <ApartmentOutlined />,
      label: '质量中心',
    },
    {
      key: '/symbolicate-group',
      icon: <BugOutlined />,
      label: <span onClick={() => navigate('/sentry-service')}>Crash 服务</span>,
      children: [
        { key: '/sentry-service', label: 'Sentry 服务' },
        { key: '/history', label: '历史记录' },
        { key: '/symbolicate', label: 'Crash 符号化' },
        { key: '/manage', label: 'dSYM 管理' },
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
        { key: '/cicd/quality', label: '自动质检' },
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
    ...(isAdmin ? [{
      key: '/access-stats',
      icon: <BarChartOutlined />,
      label: '访问统计',
    }] : []),
  ];

  const handleLogin = () => {
    navigate('/login');
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
              marginRight: '32px',
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

        {location.pathname === '/' ? null : isAuthenticated ? (
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: 'pointer', padding: '0 16px' }}>
              <Avatar
                icon={isAdmin ? <CrownOutlined /> : <UserOutlined />}
                style={{ backgroundColor: isAdmin ? '#faad14' : '#1677ff' }}
              />
              <span style={{ color: 'white' }}>{authUtils.getUser()?.displayName || authUtils.getUser()?.username}</span>
            </Space>
          </Dropdown>
        ) : (
          <Button
            type="primary"
            icon={<CrownOutlined />}
            onClick={handleLogin}
          >
            管理员登录
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
