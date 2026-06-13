import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import {
  BugOutlined,
  AppstoreOutlined,
  RocketOutlined,
  FileSearchOutlined,
  NodeIndexOutlined,
  ToolOutlined,
} from '@ant-design/icons';

const { Title, Paragraph } = Typography;

interface FeatureCard {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  path: string;
  color: string;
  gradient: string;
}

const features: FeatureCard[] = [
  {
    key: 'symbolicate',
    title: 'Crash 服务',
    description: '查看 Sentry 线上崩溃、下载原始崩溃并进行符号化解析，快速定位崩溃原因',
    icon: <BugOutlined />,
    path: '/sentry-service',
    color: '#1677ff',
    gradient: 'linear-gradient(135deg, #1677ff 0%, #4096ff 100%)',
  },
  {
    key: 'pods',
    title: 'Pods 组件管理',
    description: '管理 CocoaPods 组件库，查看版本信息、依赖关系，支持组件发布与更新',
    icon: <AppstoreOutlined />,
    path: '/pods',
    color: '#52c41a',
    gradient: 'linear-gradient(135deg, #52c41a 0%, #73d13d 100%)',
  },
  {
    key: 'cicd',
    title: 'CI/CD 管理',
    description: 'nn-ios Jenkins 构建与发布蒲公英、TestFlight、苹果商店包',
    icon: <RocketOutlined />,
    path: '/cicd',
    color: '#722ed1',
    gradient: 'linear-gradient(135deg, #722ed1 0%, #9254de 100%)',
  },
  {
    key: 'logs',
    title: '日志服务',
    description: '收集和分析应用运行日志，支持日志检索、统计分析和异常告警',
    icon: <FileSearchOutlined />,
    path: '/logs',
    color: '#fa541c',
    gradient: 'linear-gradient(135deg, #fa541c 0%, #ff7a45 100%)',
  },
  {
    key: 'devops',
    title: 'DevOps 技能库',
    description: '沉淀 podx、mgit 工具链用法，提供组件发布、仓库批量操作和日常命令速查',
    icon: <ToolOutlined />,
    path: '/devops',
    color: '#faad14',
    gradient: 'linear-gradient(135deg, #faad14 0%, #ffc53d 100%)',
  },
  {
    key: 'routes',
    title: '路由管理',
    description: '管理 App 内路由配置，支持路由注册、跳转测试和路由表可视化',
    icon: <NodeIndexOutlined />,
    path: '/routes',
    color: '#13c2c2',
    gradient: 'linear-gradient(135deg, #13c2c2 0%, #36cfc9 100%)',
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <Title level={2} style={{ marginBottom: 8 }}>
          iOS 移动管理平台
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 16 }}>
          一站式 iOS 应用开发管理工具，覆盖崩溃分析、组件管理、CI/CD、日志、DevOps 工具链和路由
        </Paragraph>
      </div>

      <Row gutter={[24, 24]} justify="center" style={{ maxWidth: 1200, margin: '0 auto' }}>
        {features.map((feature) => (
          <Col xs={24} sm={12} lg={8} key={feature.key}>
            <Card
              hoverable
              onClick={() => navigate(feature.path)}
              style={{
                height: '100%',
                borderRadius: 12,
                overflow: 'hidden',
                transition: 'all 0.3s ease',
              }}
              styles={{
                body: { padding: 0 },
              }}
            >
              <div
                style={{
                  background: feature.gradient,
                  padding: '32px 24px 24px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div
                  style={{
                    fontSize: 36,
                    color: '#fff',
                    background: 'rgba(255,255,255,0.2)',
                    borderRadius: 12,
                    width: 64,
                    height: 64,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {feature.icon}
                </div>
                <Title level={4} style={{ color: '#fff', margin: 0 }}>
                  {feature.title}
                </Title>
              </div>
              <div style={{ padding: '20px 24px 24px' }}>
                <Paragraph type="secondary" style={{ margin: 0, fontSize: 14, lineHeight: 1.8 }}>
                  {feature.description}
                </Paragraph>
              </div>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
