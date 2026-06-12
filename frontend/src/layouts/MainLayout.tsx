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
} from '@ant-design/icons';
import { authUtils } from '../utils/auth';

const { Header, Content } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = authUtils.isAdmin();
  const isAuthenticated = authUtils.isAuthenticated();

  // Determine which top-level menu key is active
  const getSelectedKey = () => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (['/sentry-service', '/history', '/symbolicate', '/manage'].some((prefix) => path.startsWith(prefix))) {
      return '/symbolicate-group';
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
      key: '/cicd',
      icon: <RocketOutlined />,
      label: 'CI/CD',
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
      key: '/routes',
      icon: <NodeIndexOutlined />,
      label: '路由管理',
    },
  ];

  const handleLogin = () => {
    navigate('/login');
  };

  const handleLogout = () => {
    authUtils.clearToken();
    sessionStorage.clear();
    window.location.reload();
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

        {isAuthenticated && isAdmin ? (
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: 'pointer', padding: '0 16px' }}>
              <Avatar
                icon={<CrownOutlined />}
                style={{ backgroundColor: '#faad14' }}
              />
              <span style={{ color: 'white' }}>管理员</span>
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
      <Content style={{ padding: '24px', background: '#f0f2f5' }}>
        <div
          style={{
            background: '#fff',
            padding: '24px',
            minHeight: '500px',
            borderRadius: 8,
          }}
        >
          <Outlet />
        </div>
      </Content>
    </Layout>
  );
}
