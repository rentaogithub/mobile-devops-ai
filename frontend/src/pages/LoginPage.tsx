import { useEffect, useState } from 'react';
import { Card, Input, Button, message, Typography, Space, Segmented, Select } from 'antd';
import { LockOutlined, UserAddOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AuthUser } from '../utils/auth';
import { authApi, PlatformProductLine, PlatformRole } from '../services/api';

const { Title, Paragraph, Text } = Typography;

interface LoginPageProps {
  onLogin: (user: AuthUser) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [requestedRole, setRequestedRole] = useState<PlatformRole | undefined>(undefined);
  const [productLines, setProductLines] = useState<PlatformProductLine[]>([]);
  const [productLineId, setProductLineId] = useState('nn');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const registrationPassword = username.trim() ? `${username.trim()}123` : '';

  useEffect(() => {
    void authApi.listPublicProductLines().then((response) => {
      const lines = response.data || [];
      setProductLines(lines);
      if (!lines.some((item) => item.id === productLineId) && lines[0]) setProductLineId(lines[0].id);
    }).catch(() => undefined);
  }, []);

  const redirectPath = (() => {
    const value = new URLSearchParams(location.search).get('redirect') || '/';
    if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/';
    return value;
  })();

  const handleSubmit = async () => {
    if (!username.trim() || !password.trim()) {
      message.warning('请输入 NN 邮箱前缀和密码');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (data.success) {
        const user = data.data?.user as AuthUser;
        message.success(`欢迎，${user.username}`);
        onLogin(user);
        navigate(redirectPath, { replace: true });
      } else {
        message.error(data.error || '密码错误');
      }
    } catch (error) {
      message.error('登录失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    const nextUsername = username.trim();
    if (!nextUsername) {
      message.warning('请输入 NN 邮箱前缀');
      return;
    }
    if (!requestedRole) {
      message.warning('请选择申请角色');
      return;
    }
    const initialPassword = `${nextUsername}123`;

    setLoading(true);
    try {
      const response = await authApi.register({
        username: nextUsername,
        password: initialPassword,
        requestedRole,
        productLineId,
      });
      if (!response.success) throw new Error(response.error || '提交注册申请失败');
      message.success('注册申请已提交，等待管理员审核');
      setMode('login');
    } catch (error: any) {
      const errorText = typeof error === 'string' ? error : (error?.error || error?.message || '');
      if (errorText.includes('Cannot POST /api/auth/register')) {
        message.error('注册接口未生效，请重启后端服务');
      } else {
        message.error(errorText || '提交注册申请失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (mode === 'login') {
        handleSubmit();
      } else {
        handleRegister();
      }
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card
        style={{
          width: 400,
          boxShadow: '0 10px 40px rgba(0,0,0,0.1)',
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div style={{ textAlign: 'center' }}>
            <LockOutlined style={{ fontSize: 48, color: '#faad14', marginBottom: 16 }} />
            <Title level={2} style={{ marginBottom: 8 }}>
              {mode === 'login' ? '平台实名登录' : '注册申请'}
            </Title>
            <Paragraph type="secondary">
              {mode === 'login' ? 'AI 执行与审批必须关联到具体操作者' : '提交后需管理员审核角色，通过后即可登录'}
            </Paragraph>
          </div>

          <Segmented
            block
            value={mode}
            onChange={(value) => {
              setMode(value as 'login' | 'register');
              setPassword('');
            }}
            options={[
              { label: '登录', value: 'login' },
              { label: '注册申请', value: 'register' },
            ]}
          />

          <Input
            size="large"
            placeholder="NN 邮箱前缀"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={handleKeyPress}
          />

          {mode === 'register' && (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Select
                size="large"
                value={productLineId}
                onChange={setProductLineId}
                options={productLines.map((item) => ({ label: item.name, value: item.id }))}
                placeholder="请选择产品线"
              />
              <Space.Compact style={{ width: '100%' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 11px',
                    border: '1px solid #d9d9d9',
                    borderRight: 0,
                    borderRadius: '6px 0 0 6px',
                    background: '#fafafa',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Text strong>
                    <Text type="danger">*</Text> 角色：
                  </Text>
                </div>
                <Select
                  size="large"
                  placeholder="请选择申请角色"
                  value={requestedRole}
                  onChange={setRequestedRole}
                  style={{ flex: 1 }}
                  options={[
                    { label: '测试', value: 'tester' },
                    { label: '研发', value: 'developer' },
                    { label: '产品运营', value: 'product' },
                  ]}
                />
              </Space.Compact>
              <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                请按实际岗位选择，避免选错后需要管理员重新处理
              </Paragraph>
            </Space>
          )}

          {mode === 'login' && (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Input.Password
                size="large"
                placeholder="请输入密码"
                prefix={<LockOutlined />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyPress}
              />
              <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
                如果忘记密码，可向管理员获取
              </Paragraph>
            </Space>
          )}

          {mode === 'register' && (
            <Input.Password
              size="large"
              placeholder="默认密码：NN 邮箱前缀 + 123"
              prefix={<LockOutlined />}
              value={registrationPassword}
              readOnly
            />
          )}

          <Button
            type="primary"
            size="large"
            block
            loading={loading}
            icon={mode === 'register' ? <UserAddOutlined /> : undefined}
            onClick={mode === 'login' ? handleSubmit : handleRegister}
          >
            {mode === 'login' ? '登录' : '提交注册申请'}
          </Button>
          
          <Button type="link" block onClick={() => navigate(redirectPath, { replace: true })}>
            返回原页面
          </Button>
        </Space>
      </Card>
    </div>
  );
}
