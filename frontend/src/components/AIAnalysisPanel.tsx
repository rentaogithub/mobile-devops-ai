import React from 'react';
import { Card, Tag, List, Typography, Space, Spin, Alert } from 'antd';
import {
  RobotOutlined,
  ExclamationCircleOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { CrashAnalysis } from '../types';

const { Text, Paragraph } = Typography;

interface AIAnalysisPanelProps {
  analysis: CrashAnalysis | null;
  loading: boolean;
}

const AIAnalysisPanel: React.FC<AIAnalysisPanelProps> = ({ analysis, loading }) => {
  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
        return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
      case 'high':
        return <ExclamationCircleOutlined style={{ color: '#ff7a45' }} />;
      case 'medium':
        return <WarningOutlined style={{ color: '#faad14' }} />;
      case 'low':
        return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
      default:
        return <ExclamationCircleOutlined />;
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'red';
      case 'high':
        return 'orange';
      case 'medium':
        return 'gold';
      case 'low':
        return 'green';
      default:
        return 'default';
    }
  };

  const getSeverityText = (severity: string) => {
    switch (severity) {
      case 'critical':
        return '严重';
      case 'high':
        return '高';
      case 'medium':
        return '中等';
      case 'low':
        return '低';
      default:
        return '未知';
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <Spin size="large" />
        <div style={{ marginTop: 16 }}>
          <Text type="secondary">AI 正在分析崩溃日志...</Text>
        </div>
      </div>
    );
  }

  if (!analysis) {
    return (
      <Alert
        message="AI 分析不可用"
        description="未提供 API Key 或 AI 分析失败。符号化结果仍然可用。"
        type="info"
        showIcon
        icon={<RobotOutlined />}
      />
    );
  }

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {analysis.appVersion && (
            <div>
              <Text strong>应用版本：</Text>
              <Tag color="purple" style={{ marginLeft: 8 }}>
                {analysis.appVersion}
              </Tag>
            </div>
          )}
          <div>
            <Text strong>崩溃类型：</Text>
            <Tag color="blue" style={{ marginLeft: 8 }}>
              {analysis.crashType}
            </Tag>
          </div>
          {analysis.crashThread && (
            <div>
              <Text strong>崩溃线程：</Text>
              <Tag color="cyan" style={{ marginLeft: 8 }}>
                {analysis.crashThread}
              </Tag>
            </div>
          )}
          {analysis.crashModule && (
            <div>
              <Text strong>崩溃模块：</Text>
              <Tag color="geekblue" style={{ marginLeft: 8 }}>
                {analysis.crashModule}
              </Tag>
            </div>
          )}
          {analysis.crashLocation && (
            <div>
              <Text strong>崩溃位置：</Text>
              <Tag color="magenta" style={{ marginLeft: 8 }}>
                {analysis.crashLocation}
              </Tag>
            </div>
          )}
          {(analysis.crashFile || analysis.crashLine) && (
            <div>
              <Text strong>代码位置：</Text>
              <Tag color="volcano" style={{ marginLeft: 8 }}>
                {analysis.crashFile}
                {analysis.crashLine && `:${analysis.crashLine}`}
              </Tag>
            </div>
          )}
          <div>
            <Text strong>严重程度：</Text>
            <Tag
              color={getSeverityColor(analysis.severity)}
              icon={getSeverityIcon(analysis.severity)}
              style={{ marginLeft: 8 }}
            >
              {getSeverityText(analysis.severity)}
            </Tag>
          </div>
          <div>
            <Text strong>受影响组件：</Text>
            <div style={{ marginTop: 8 }}>
              {analysis.affectedComponents.map((component, index) => (
                <Tag key={index} style={{ marginBottom: 4 }}>
                  {component}
                </Tag>
              ))}
            </div>
          </div>
        </Space>
      </Card>

      <Card size="small" title={<Space><RobotOutlined />分析总结</Space>} style={{ marginBottom: 16 }}>
        <Paragraph>{analysis.summary}</Paragraph>
      </Card>

      {analysis.crashStack && (
        <Card 
          size="small" 
          title="崩溃堆栈快照" 
          style={{ 
            marginBottom: 16,
            background: '#fff7e6',
            border: '1px solid #ffd591'
          }}
        >
          <pre
            style={{
              background: '#fffbe6',
              padding: '12px',
              borderRadius: '4px',
              fontSize: '12px',
              fontFamily: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace',
              maxHeight: '300px',
              overflow: 'auto',
              margin: 0,
              border: '1px solid #ffe58f',
              lineHeight: '1.6',
              color: '#d46b08',
              whiteSpace: 'pre',
              wordWrap: 'normal',
              overflowX: 'auto'
            }}
          >
            {analysis.crashStack}
          </pre>
        </Card>
      )}

      <Card size="small" title="可能原因" style={{ marginBottom: 16 }}>
        <List
          size="small"
          dataSource={analysis.possibleCauses}
          renderItem={(cause, index) => (
            <List.Item>
              <Text>
                {index + 1}. {cause}
              </Text>
            </List.Item>
          )}
        />
      </Card>

      <Card size="small" title="修复建议">
        <List
          size="small"
          dataSource={analysis.suggestions}
          renderItem={(suggestion, index) => (
            <List.Item>
              <Text>
                {index + 1}. {suggestion}
              </Text>
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
};

export default AIAnalysisPanel;
