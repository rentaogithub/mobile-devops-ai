import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import {
  BugOutlined,
  AppstoreOutlined,
  RocketOutlined,
  FileSearchOutlined,
  NodeIndexOutlined,
  ToolOutlined,
  ApiOutlined,
  MobileOutlined,
  CodeOutlined,
  ExperimentOutlined,
  CloudUploadOutlined,
  SafetyCertificateOutlined,
  RightOutlined,
  ApartmentOutlined,
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
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'pods',
    title: 'Pods 组件管理',
    description: '管理 CocoaPods 组件库，查看版本信息、依赖关系，支持组件发布与更新',
    icon: <AppstoreOutlined />,
    path: '/pods',
    color: '#52c41a',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'cicd',
    title: 'CI/CD 管理',
    description: 'nn-ios Jenkins 构建与发布蒲公英、TestFlight、苹果商店包',
    icon: <RocketOutlined />,
    path: '/cicd',
    color: '#722ed1',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'logs',
    title: '日志服务',
    description: '收集和分析应用运行日志，支持日志检索、统计分析和异常告警',
    icon: <FileSearchOutlined />,
    path: '/logs',
    color: '#fa541c',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'devops',
    title: 'DevOps 技能库',
    description: '沉淀 podx、mgit 工具链用法，提供组件发布、仓库批量操作和日常命令速查',
    icon: <ToolOutlined />,
    path: '/devops',
    color: '#faad14',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'api-docs',
    title: 'API 接口',
    description: '用户查询服务接口文档，集中查看请求参数、响应字段与调用地址',
    icon: <ApiOutlined />,
    path: '/api-docs',
    color: '#eb2f96',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'routes',
    title: '路由管理',
    description: '管理 App 内路由配置，支持路由注册、跳转测试和路由表可视化',
    icon: <NodeIndexOutlined />,
    path: '/routes',
    color: '#13c2c2',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
  {
    key: 'cross-platform',
    title: '跨端能力',
    description: '查看和调试 JS SDK 跨端能力示例，验证各类原生与 Web 交互能力',
    icon: <MobileOutlined />,
    path: '/cross-platform',
    color: '#2f54eb',
    gradient: 'linear-gradient(135deg, #334155 0%, #475569 100%)',
  },
];

const serviceChain = [
  {
    key: 'development',
    title: '研发支撑',
    description: '查工具用法、管组件、查接口',
    icon: <CodeOutlined />,
    services: [
      { label: 'DevOps 技能库', path: '/devops' },
      { label: 'Pods 组件', path: '/pods' },
      { label: 'API 接口', path: '/api-docs' },
    ],
  },
  {
    key: 'integration',
    title: '联调验证',
    description: '调路由跳转、验证 JS SDK 能力',
    icon: <ExperimentOutlined />,
    services: [
      { label: '路由管理', path: '/routes' },
      { label: '跨端能力', path: '/cross-platform' },
    ],
  },
  {
    key: 'delivery',
    title: '构建发布',
    description: '自动构建、质检并发布应用',
    icon: <CloudUploadOutlined />,
    services: [
      { label: 'CI/CD 管理', path: '/cicd' },
      { label: '自动质检', path: '/cicd/quality' },
    ],
  },
  {
    key: 'operations',
    title: '运行保障',
    description: '查运行日志、定位线上崩溃',
    icon: <SafetyCertificateOutlined />,
    services: [
      { label: '日志服务', path: '/logs' },
      { label: 'Crash 服务', path: '/sentry-service' },
    ],
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <Title level={2} style={{ marginBottom: 8 }}>
          iOS 移动管理平台
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 16 }}>
          一站式 iOS 应用开发管理工具，覆盖崩溃分析、组件管理、CI/CD、日志、API 文档、DevOps 工具链、路由和跨端能力
        </Paragraph>

        <section className="service-chain" aria-label="iOS 移动管理平台服务链">
          <button type="button" className="service-chain-workflow" onClick={() => navigate('/workflow')}>
            <span className="service-chain-workflow-icon"><ApartmentOutlined /></span>
            <span className="service-chain-workflow-content">
              <span className="service-chain-workflow-title">移动研发质量中心</span>
              <span className="service-chain-workflow-description">汇聚构建、质检与线上问题，辅助识别变更风险、发布风险并沉淀回归与质量知识</span>
            </span>
            <RightOutlined className="service-chain-workflow-arrow" />
          </button>
          <div className="service-chain-label">移动研发服务链</div>
          <div className="service-chain-flow">
            {serviceChain.map((stage, index) => (
              <div className="service-chain-segment" key={stage.key}>
                <div className={`service-chain-stage service-chain-stage-${index + 1}`}>
                  <div className="service-chain-stage-header">
                    <span className="service-chain-stage-icon">{stage.icon}</span>
                    <span>
                      <span className="service-chain-stage-title">{stage.title}</span>
                      <span className="service-chain-stage-description">{stage.description}</span>
                    </span>
                  </div>
                  <div className="service-chain-services">
                    {stage.services.map((service) => (
                      <button
                        type="button"
                        className="service-chain-service"
                        key={service.path}
                        onClick={() => navigate(service.path)}
                      >
                        {service.label}
                      </button>
                    ))}
                  </div>
                </div>
                {index < serviceChain.length - 1 && (
                  <RightOutlined className="service-chain-arrow" aria-hidden="true" />
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <Row gutter={[24, 24]} style={{ maxWidth: 1440, margin: '0 auto' }}>
        {features.map((feature) => (
          <Col xs={24} sm={12} xl={6} key={feature.key}>
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
                  background: '#f7f9fc',
                  padding: '28px 22px',
                  minHeight: 120,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  borderBottom: '1px solid #f0f0f0',
                }}
              >
                <div
                  style={{
                    fontSize: 36,
                    color: '#1677ff',
                    background: '#eaf2ff',
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
                <Title level={4} style={{ color: '#1f2937', margin: 0 }}>
                  {feature.title}
                </Title>
              </div>
              <div style={{ padding: '20px 22px 24px', minHeight: 112 }}>
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
