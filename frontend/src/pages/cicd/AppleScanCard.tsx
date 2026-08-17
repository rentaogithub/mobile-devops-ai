import { Alert, Button, Card, Col, Empty, Image, QRCode, Row, Space, Typography } from 'antd';
import { MobileOutlined } from '@ant-design/icons';
import { ReactNode } from 'react';

const { Text } = Typography;

interface AppleScanCardProps {
  enrollUrl?: string;
  loading?: boolean;
  emptyDescription: string;
  guideImage: string;
  registrationResult?: ReactNode;
  onCreateEnrollment: () => void;
}

export function AppleScanCard({
  enrollUrl,
  loading,
  emptyDescription,
  guideImage,
  registrationResult,
  onCreateEnrollment,
}: AppleScanCardProps) {
  return (
    <Card title="扫码采集 Identifier">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {enrollUrl ? (
          <Row gutter={[20, 16]} align="top">
            <Col xs={24} lg={7}>
              <Space direction="vertical" size={12} style={{ width: '100%', alignItems: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                  <QRCode value={enrollUrl} size={220} />
                </div>
                <Button size="small" type="primary" icon={<MobileOutlined />} onClick={onCreateEnrollment} loading={loading}>
                  重新生成
                </Button>
                <Text type="secondary" style={{ width: '100%', textAlign: 'center' }}>
                  使用 iPhone Safari 扫码打开，设备 Identifier 会自动回传到平台。
                </Text>
                {registrationResult}
              </Space>
            </Col>
            <Col xs={24} lg={17}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Image
                  src={guideImage}
                  alt="扫码安装 iOS 描述文件操作指引"
                  preview={{ mask: '查看大图' }}
                  style={{
                    width: '100%',
                    border: '1px solid #eef2f7',
                    borderRadius: 8,
                    background: '#f8fbff',
                  }}
                />
                <Alert
                  type="info"
                  showIcon
                  message="手机上这样操作"
                  description={(
                    <Space direction="vertical" size={4}>
                      <Text>用 Safari 打开二维码页面，允许下载描述文件；随后进入 iPhone 设置首页，点击顶部“已下载描述文件”并安装。若没有看到入口，可进入“设置 &gt; 通用 &gt; VPN与设备管理”安装。</Text>
                      <Text strong style={{ color: '#d93025' }}>若最后提示“描述文件安装失败”，只要平台已采集到 Identifier 就可以忽略。</Text>
                    </Space>
                  )}
                />
              </Space>
            </Col>
          </Row>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={emptyDescription}
          />
        )}
      </Space>
    </Card>
  );
}
