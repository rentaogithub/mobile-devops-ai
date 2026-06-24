import React, { useState } from 'react';
import { Input, Space, Button, Tooltip } from 'antd';
import { EyeInvisibleOutlined, EyeOutlined, CloseCircleOutlined, InfoCircleOutlined, LockOutlined } from '@ant-design/icons';
import { authUtils } from '../utils/auth';

interface APIKeyInputProps {
  value: string;
  onChange: (key: string) => void;
  onValidate?: (isValid: boolean) => void;
}

const APIKeyInput: React.FC<APIKeyInputProps> = ({ value, onChange, onValidate }) => {
  const [visible, setVisible] = useState(false);
  const isAdmin = authUtils.isAdmin();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    // 保存到 localStorage
    if (newValue.trim()) {
      localStorage.setItem('openai_api_key', newValue);
    } else {
      localStorage.removeItem('openai_api_key');
    }

    // 简单的格式验证
    if (onValidate) {
      const isValid = newValue.trim().length > 0 && newValue.startsWith('sk-');
      onValidate(isValid);
    }
  };

  const handleClear = () => {
    onChange('');
    localStorage.removeItem('openai_api_key');
    if (onValidate) {
      onValidate(false);
    }
  };

  // 如果不是管理员且有API Key，显示为只读状态
  if (!isAdmin && value) {
    return (
      <Space.Compact style={{ width: '100%' }}>
        <Input
          type="password"
          value={value}
          disabled
          placeholder="API Key 已配置（仅管理员可查看）"
          prefix={
            <Tooltip title="API Key 已配置，仅管理员可以查看和修改">
              <LockOutlined style={{ color: 'rgba(0,0,0,.45)' }} />
            </Tooltip>
          }
        />
      </Space.Compact>
    );
  }

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={handleChange}
        placeholder={isAdmin ? "输入 OpenAI API Key（可选，用于 AI 智能分析）" : "API Key 未配置（请联系管理员）"}
        disabled={!isAdmin && !value}
        prefix={
          <Tooltip title={isAdmin ? "OpenAI API Key 用于智能分析崩溃日志。保存在浏览器本地。" : "仅管理员可以配置 API Key"}>
            {isAdmin ? <InfoCircleOutlined style={{ color: 'rgba(0,0,0,.45)' }} /> : <LockOutlined style={{ color: 'rgba(0,0,0,.45)' }} />}
          </Tooltip>
        }
        suffix={
          isAdmin ? (
            <Space size={4}>
              {value && (
                <Button
                  type="text"
                  size="small"
                  icon={<CloseCircleOutlined />}
                  onClick={handleClear}
                  style={{ padding: '0 4px' }}
                />
              )}
              <Button
                type="text"
                size="small"
                icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => setVisible(!visible)}
                style={{ padding: '0 4px' }}
              />
            </Space>
          ) : undefined
        }
      />
    </Space.Compact>
  );
};

export default APIKeyInput;
