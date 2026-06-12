import { Typography, Card, Button, Space } from 'antd';
import {
  NodeIndexOutlined,
  ExportOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;
const PROTOCOL_JUMP_URL = 'https://fe-tools.nn.com/protocol-jump.html';

export default function RoutesPage() {
  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <Title level={4} style={{ marginBottom: 8 }}>
            <NodeIndexOutlined style={{ marginRight: 8, color: '#13c2c2' }} />
            路由管理
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            使用协议跳转工具调试 App 内路由、Scheme 和通用跳转链接。
          </Paragraph>
        </div>
        <Button
          icon={<ExportOutlined />}
          onClick={() => window.open(PROTOCOL_JUMP_URL, '_blank', 'noopener,noreferrer')}
        >
          新窗口打开
        </Button>
      </Space>

      <Card styles={{ body: { padding: 0, height: 'calc(100vh - 220px)', minHeight: 640 } }}>
        <iframe
          src={PROTOCOL_JUMP_URL}
          title="协议跳转工具"
          style={{
            width: '100%',
            height: '100%',
            border: 0,
            display: 'block',
            borderRadius: 8,
          }}
        />
      </Card>
    </div>
  );
}
