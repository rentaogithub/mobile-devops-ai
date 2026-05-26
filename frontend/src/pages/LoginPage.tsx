import { useState } from 'react';
import { Card, Input, Button, message, Typography, Space } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

const { Title, Paragraph } = Typography;

interface LoginPageProps {
  onLogin: (password: string, isAdmin: boolean) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async () => {
    if (!password.trim()) {
      message.warning('请输入管理员密码');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (data.success) {
        const isAdmin = data.data?.isAdmin || false;
        if (isAdmin) {
          message.success('管理员登录成功');
          onLogin(password, isAdmin);
          navigate('/manage');
        } else {
          message.error('请输入管理员密码');
        }
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
              管理员登录
            </Title>
            <Paragraph type="secondary">请输入管理员密码以获取管理权限</Paragraph>
          </div>

          <Input.Password
            size="large"
            placeholder="请输入管理员密码"
            prefix={<LockOutlined />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyPress={handleKeyPress}
          />

          <Button type="primary" size="large" block loading={loading} onClick={handleSubmit}>
            登录
          </Button>
          
          <Button type="link" block onClick={() => navigate('/')}>
            返回首页
          </Button>
        </Space>
      </Card>
    </div>
  );
}
