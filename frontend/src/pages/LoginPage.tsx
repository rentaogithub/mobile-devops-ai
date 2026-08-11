import { useState } from 'react';
import { Card, Input, Button, message, Typography, Space } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AuthUser } from '../utils/auth';

const { Title, Paragraph } = Typography;

interface LoginPageProps {
  onLogin: (user: AuthUser) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const redirectPath = (() => {
    const value = new URLSearchParams(location.search).get('redirect') || '/';
    if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/login')) return '/';
    return value;
  })();

  const handleSubmit = async () => {
    if (!username.trim() || !password.trim()) {
      message.warning('请输入用户名和密码');
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
        message.success(`欢迎，${user.displayName || user.username}`);
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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
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
              平台实名登录
            </Title>
            <Paragraph type="secondary">AI 执行与审批必须关联到具体操作者</Paragraph>
          </div>

          <Input
            size="large"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={handleKeyPress}
          />

          <Input.Password
            size="large"
            placeholder="请输入密码"
            prefix={<LockOutlined />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyPress}
          />

          <Button type="primary" size="large" block loading={loading} onClick={handleSubmit}>
            登录
          </Button>
          
          <Button type="link" block onClick={() => navigate(redirectPath, { replace: true })}>
            返回原页面
          </Button>
        </Space>
      </Card>
    </div>
  );
}
