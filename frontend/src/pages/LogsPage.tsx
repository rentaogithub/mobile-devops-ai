import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Typography,
  Card,
  Button,
  Space,
  Steps,
  Tag,
  Spin,
  Alert,
  Descriptions,
  message,
} from 'antd';
import {
  FileSearchOutlined,
  QrcodeOutlined,
  MobileOutlined,
  LinkOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  DisconnectOutlined,
} from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import { pairingApi, PairingSessionData, PairingStatusData } from '../services/api';

const { Title, Paragraph, Text } = Typography;

type ConnectionState = 'idle' | 'qrcode' | 'polling' | 'paired' | 'viewing' | 'error';

export default function LogsPage() {
  const [state, setState] = useState<ConnectionState>('idle');
  const [session, setSession] = useState<PairingSessionData | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatusData | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [qrValue, setQrValue] = useState('');

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<PairingSessionData | null>(null);

  // 保持 ref 同步
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      stopPolling();
      // 清理配对会话
      if (sessionRef.current) {
        pairingApi.delete(sessionRef.current.pairingId).catch(() => {});
      }
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  /**
   * 开始配对流程 - 创建会话并生成二维码
   */
  const startPairing = async () => {
    try {
      setState('qrcode');
      setErrorMsg('');
      setPairingStatus(null);

      const response = await pairingApi.create();
      if (!response.success || !response.data) {
        throw new Error('创建配对会话失败');
      }

      const { pairingId, token } = response.data;
      setSession({ pairingId, token });

      // 生成二维码内容 - App 扫码后解析此 JSON
      // 包含平台地址 + pairingId + token
      const qrData = JSON.stringify({
        type: 'nn-realtime-log',
        pairingId,
        token,
        serverUrl: `${window.location.origin}/api/pairing/confirm`,
      });
      setQrValue(qrData);

      // 开始轮询配对状态
      setState('polling');
      startPolling(pairingId);
    } catch (error: any) {
      setState('error');
      setErrorMsg(error?.error || error?.message || '创建配对会话失败');
    }
  };

  /**
   * 轮询配对状态
   */
  const startPolling = (pairingId: string) => {
    stopPolling();

    pollingRef.current = setInterval(async () => {
      try {
        const response = await pairingApi.getStatus(pairingId);
        if (!response.success || !response.data) return;

        const data = response.data;
        setPairingStatus(data);

        if (data.status === 'paired') {
          stopPolling();
          setState('paired');
          message.success('设备配对成功！');
        } else if (data.status === 'expired') {
          stopPolling();
          setState('error');
          setErrorMsg('配对会话已过期，请重新生成二维码');
        }
      } catch {
        // 轮询失败不中断，继续重试
      }
    }, 1500);
  };

  /**
   * 打开设备日志页面
   */
  const openDeviceLog = () => {
    if (pairingStatus?.deviceLogUrl) {
      setState('viewing');
    }
  };

  /**
   * 在新窗口打开设备日志
   */
  const openInNewWindow = () => {
    if (pairingStatus?.deviceLogUrl) {
      window.open(pairingStatus.deviceLogUrl, '_blank');
    }
  };

  /**
   * 断开连接，重置状态
   */
  const disconnect = () => {
    stopPolling();
    if (session) {
      pairingApi.delete(session.pairingId).catch(() => {});
    }
    setState('idle');
    setSession(null);
    setPairingStatus(null);
    setQrValue('');
    setErrorMsg('');
  };

  /**
   * 获取当前步骤
   */
  const getCurrentStep = (): number => {
    switch (state) {
      case 'idle': return 0;
      case 'qrcode':
      case 'polling': return 1;
      case 'paired': return 2;
      case 'viewing': return 3;
      default: return 0;
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <Title level={4}>
          <FileSearchOutlined style={{ marginRight: 8, color: '#faad14' }} />
          实时日志
        </Title>
        <Paragraph type="secondary">
          通过 NN App 扫描二维码，连接设备实时日志服务，在浏览器中查看设备运行日志
        </Paragraph>
      </div>

      {/* 步骤指示器 */}
      <Card style={{ marginBottom: 24 }}>
        <Steps
          current={getCurrentStep()}
          items={[
            { title: '准备', description: '生成二维码', icon: <QrcodeOutlined /> },
            { title: '扫码', description: 'App 扫描配对', icon: <MobileOutlined /> },
            { title: '已配对', description: '获取日志地址', icon: <LinkOutlined /> },
            { title: '查看日志', description: '实时日志流', icon: <CheckCircleOutlined /> },
          ]}
        />
      </Card>

      {/* 主内容区 */}
      {state === 'idle' && (
        <Card>
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <QrcodeOutlined style={{ fontSize: 64, color: '#1677ff', marginBottom: 24 }} />
            <Title level={5}>连接设备实时日志</Title>
            <Paragraph type="secondary" style={{ maxWidth: 500, margin: '0 auto 24px' }}>
              点击下方按钮生成二维码，然后在 NN App 中通过 Debug → 实时日志 → 扫描二维码 进行配对。
              配对成功后，设备日志将实时展示在浏览器中。
            </Paragraph>
            <Button type="primary" size="large" icon={<QrcodeOutlined />} onClick={startPairing}>
              生成配对二维码
            </Button>
          </div>
        </Card>
      )}

      {(state === 'qrcode' || state === 'polling') && (
        <Card>
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            {qrValue ? (
              <>
                <div
                  style={{
                    display: 'inline-block',
                    padding: 16,
                    background: '#fff',
                    borderRadius: 8,
                    border: '1px solid #f0f0f0',
                    marginBottom: 24,
                  }}
                >
                  <QRCodeSVG value={qrValue} size={220} level="M" />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <Space>
                    <Spin size="small" />
                    <Text type="secondary">等待 App 扫码配对...</Text>
                  </Space>
                </div>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  请在 NN App 中打开：Debug → 实时日志 → 扫描二维码
                </Paragraph>
                <Space style={{ marginTop: 16 }}>
                  <Button onClick={startPairing} icon={<ReloadOutlined />}>
                    重新生成
                  </Button>
                  <Button onClick={disconnect}>取消</Button>
                </Space>
              </>
            ) : (
              <Spin tip="正在生成二维码..." />
            )}
          </div>
        </Card>
      )}

      {state === 'paired' && pairingStatus && (
        <Card>
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="设备配对成功"
            description="已成功连接到设备日志服务，点击下方按钮查看实时日志"
            style={{ marginBottom: 24 }}
          />

          <Descriptions bordered column={1} size="small" style={{ marginBottom: 24 }}>
            {pairingStatus.deviceInfo?.name && (
              <Descriptions.Item label="设备名称">
                {pairingStatus.deviceInfo.name}
              </Descriptions.Item>
            )}
            {pairingStatus.deviceInfo?.model && (
              <Descriptions.Item label="设备型号">
                {pairingStatus.deviceInfo.model}
              </Descriptions.Item>
            )}
            {pairingStatus.deviceInfo?.systemVersion && (
              <Descriptions.Item label="系统版本">
                {pairingStatus.deviceInfo.systemVersion}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="日志服务地址">
              <Tag color="blue">{pairingStatus.deviceLogUrl}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="连接状态">
              <Tag color="green" icon={<CheckCircleOutlined />}>已连接</Tag>
            </Descriptions.Item>
          </Descriptions>

          <Space>
            <Button type="primary" size="large" icon={<FileSearchOutlined />} onClick={openDeviceLog}>
              在当前页面查看日志
            </Button>
            <Button size="large" icon={<LinkOutlined />} onClick={openInNewWindow}>
              在新窗口打开
            </Button>
            <Button danger icon={<DisconnectOutlined />} onClick={disconnect}>
              断开连接
            </Button>
          </Space>
        </Card>
      )}

      {state === 'viewing' && pairingStatus?.deviceLogUrl && (
        <Card
          title={
            <Space>
              <MobileOutlined />
              <span>设备实时日志</span>
              {pairingStatus.deviceInfo?.name && (
                <Tag color="blue">{pairingStatus.deviceInfo.name}</Tag>
              )}
              <Tag color="green" icon={<CheckCircleOutlined />}>已连接</Tag>
            </Space>
          }
          extra={
            <Space>
              <Button size="small" icon={<LinkOutlined />} onClick={openInNewWindow}>
                新窗口
              </Button>
              <Button size="small" danger icon={<DisconnectOutlined />} onClick={disconnect}>
                断开
              </Button>
            </Space>
          }
          bodyStyle={{ padding: 0 }}
        >
          <iframe
            src={pairingStatus.deviceLogUrl}
            style={{
              width: '100%',
              height: 'calc(100vh - 320px)',
              minHeight: 500,
              border: 'none',
            }}
            title="设备实时日志"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        </Card>
      )}

      {state === 'error' && (
        <Card>
          <Alert
            type="error"
            showIcon
            icon={<CloseCircleOutlined />}
            message="配对失败"
            description={errorMsg || '未知错误'}
            style={{ marginBottom: 24 }}
          />
          <Space>
            <Button type="primary" icon={<ReloadOutlined />} onClick={startPairing}>
              重新生成二维码
            </Button>
            <Button onClick={disconnect}>返回</Button>
          </Space>
        </Card>
      )}

      {/* 使用说明 */}
      <Card title="使用说明" style={{ marginTop: 24 }} size="small">
        <Steps
          direction="vertical"
          size="small"
          current={-1}
          items={[
            {
              title: '电脑浏览器打开实时日志平台',
              description: '点击"生成配对二维码"按钮',
            },
            {
              title: '平台生成配对二维码',
              description: '包含 pairingId 和 token 信息',
            },
            {
              title: 'App 扫描二维码',
              description: '在 NN App 中打开 Debug → 实时日志 → 扫描二维码',
            },
            {
              title: 'App 启动日志服务',
              description: 'App 解析二维码后启动 NNBrowserLogServer，获取本机 IP 和端口',
            },
            {
              title: 'App 回调平台',
              description: 'App 将 deviceLogUrl（如 http://10.1.107.116:8989）提交给平台',
            },
            {
              title: '浏览器获取日志地址',
              description: '平台通知浏览器配对成功，返回 deviceLogUrl',
            },
            {
              title: '查看实时日志',
              description: '浏览器通过 iframe 或新窗口打开设备日志页面',
            },
          ]}
        />
      </Card>
    </div>
  );
}
