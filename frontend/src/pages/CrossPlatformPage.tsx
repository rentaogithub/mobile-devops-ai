import { Typography, Card, Space } from 'antd';
import { MobileOutlined } from '@ant-design/icons';

const { Title, Paragraph } = Typography;
const JS_SDK_EXAMPLE_URL = 'https://fe-tools.nn.com/js-sdk-example/index.html';

export default function CrossPlatformPage() {
  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <Title level={4} style={{ marginBottom: 8 }}>
            <MobileOutlined style={{ marginRight: 8, color: '#2f54eb' }} />
            跨端能力
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            使用 JS SDK 示例页面查看和调试原生与 Web 的跨端交互能力。
          </Paragraph>
        </div>
      </Space>

      <Card
        styles={{
          body: {
            padding: 0,
            height: 'calc(100vh - 220px)',
            minHeight: 640,
            overflow: 'hidden',
          },
        }}
      >
        <iframe
          src={JS_SDK_EXAMPLE_URL}
          title="跨端能力"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
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
