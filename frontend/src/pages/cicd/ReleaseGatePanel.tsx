import { Alert, Button, Collapse, Input, Select, Space, Tag, Typography } from 'antd';
import { JenkinsQualitySuite, WorkflowReleaseGate } from '../../services/api';

const { Paragraph, Text } = Typography;

type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';

function releaseGateItemLabel(code?: string) {
  const labels: Record<string, string> = {
    build_failed: '构建状态',
    required_suite_missing: '缺少质检',
    suite_commit_mismatch: 'Commit 不匹配',
    suite_branch_mismatch: '分支不匹配',
    suite_expired: '质检已过期',
    suite_failed: '质检失败',
    suite_incomplete: '质检未完成',
    open_issue: '阻断 Issue',
    crash_threshold: 'Crash 门限',
    failed_test_threshold: '失败用例',
    metric_regression: '指标回退',
    baseline_missing: '缺少基线',
  };
  return labels[String(code || '')] || '质量问题';
}

interface ReleaseGatePanelProps {
  deployTarget: DeployTarget;
  gateBuildNumber?: number;
  gateBuildOptions: Array<{ value: number; label: string }>;
  preview?: WorkflowReleaseGate;
  previewLoading?: boolean;
  missingSuites: JenkinsQualitySuite[];
  overrideReason: string;
  onGateBuildChange: (value?: number) => void;
  onOverrideReasonChange: (value: string) => void;
  onRunMissingSuite: (suite: JenkinsQualitySuite) => void;
  qualitySuiteName: (suite?: string) => string;
}

export function ReleaseGatePanel({
  deployTarget,
  gateBuildNumber,
  gateBuildOptions,
  preview,
  previewLoading,
  missingSuites,
  overrideReason,
  onGateBuildChange,
  onOverrideReasonChange,
  onRunMissingSuite,
  qualitySuiteName,
}: ReleaseGatePanelProps) {
  return (
    <Collapse
      className="publish-advanced-options"
      size="small"
      ghost
      items={[{
        key: 'quality-gate',
        label: '发布前门禁（可选）',
        children: (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text type="secondary">
              {deployTarget === 'AppStore'
                ? '苹果商店包可选择门禁源构建；如选择，必须使用同发布分支的最新 TestFlight 成功构建。'
                : '如需执行质量门禁，可选择一个已完成构建；未选择时直接按常规 CI/CD 流程发布。'}
            </Text>
            {deployTarget === 'AppStore' && gateBuildOptions.length === 0 && (
              <Alert type="info" showIcon message="当前没有可选的同分支 TestFlight 成功构建；可不选择门禁直接发布。" />
            )}
            <Select
              allowClear
              value={gateBuildNumber}
              options={gateBuildOptions}
              onChange={onGateBuildChange}
              placeholder="选择门禁源构建"
              style={{ width: '100%' }}
              notFoundContent="当前分支没有可用的成功构建"
            />
            {previewLoading && <Text type="secondary">正在执行质量门禁预检...</Text>}
            {preview && !previewLoading && (
              <Alert
                className="release-gate-preview"
                showIcon
                type={preview.status === 'passed' ? 'success' : preview.status === 'warning' ? 'warning' : 'error'}
                message={(
                  <div className="release-gate-preview-title">
                    <span>{preview.status === 'passed' ? '质量门禁通过' : preview.status === 'warning' ? '存在发布风险' : '发布已阻断'}</span>
                    <Space size={4} wrap>
                      {(preview.result.blockers || []).length > 0 && <Tag color="error">{preview.result.blockers?.length} 项阻断</Tag>}
                      {(preview.result.warnings || []).length > 0 && <Tag color="warning">{preview.result.warnings?.length} 项风险</Tag>}
                      <Tag>{preview.score} 分</Tag>
                    </Space>
                  </div>
                )}
                description={(
                  <div className="release-gate-preview-content">
                    {missingSuites.length > 0 && (
                      <div className="release-gate-preview-action">
                        <Text type="secondary">需要先完成 {missingSuites.map(qualitySuiteName).join('、')}，再重新预检。</Text>
                        <Button type="primary" size="small" onClick={() => onRunMissingSuite(missingSuites[0])}>
                          执行{qualitySuiteName(missingSuites[0])}
                        </Button>
                      </div>
                    )}
                    {((preview.result.blockers || []).length > 0 || (preview.result.warnings || []).length > 0) && (
                      <Collapse
                        size="small"
                        items={[
                          ...((preview.result.blockers || []).length > 0 ? [{
                            key: 'blockers',
                            label: `查看 ${(preview.result.blockers || []).length} 项阻断详情`,
                            children: (
                              <ul className="release-gate-preview-list">
                                {(preview.result.blockers || []).map((item, index) => (
                                  <li key={`${item.code}-${index}`}>
                                    <Tag color="error">{releaseGateItemLabel(item.code)}</Tag>
                                    <Paragraph ellipsis={{ rows: 2, tooltip: item.message }}>{item.message}</Paragraph>
                                  </li>
                                ))}
                              </ul>
                            ),
                          }] : []),
                          ...((preview.result.warnings || []).length > 0 ? [{
                            key: 'warnings',
                            label: `查看 ${(preview.result.warnings || []).length} 项风险详情`,
                            children: (
                              <ul className="release-gate-preview-list">
                                {(preview.result.warnings || []).map((item, index) => (
                                  <li key={`${item.code}-${index}`}>
                                    <Tag color="warning">{releaseGateItemLabel(item.code)}</Tag>
                                    <Paragraph ellipsis={{ rows: 2, tooltip: item.message }}>{item.message}</Paragraph>
                                  </li>
                                ))}
                              </ul>
                            ),
                          }] : []),
                        ]}
                      />
                    )}
                    {preview.status === 'passed' && <Text type="secondary">构建状态、必需测试套件、Crash 和阻塞级 Issue 均已通过检查。</Text>}
                  </div>
                )}
              />
            )}
            {deployTarget !== 'Pgyer' && gateBuildNumber && (
              <Input.TextArea
                rows={2}
                placeholder="门禁仅有警告时的人工放行原因（门禁阻断不可覆盖）"
                value={overrideReason}
                onChange={(event) => onOverrideReasonChange(event.target.value)}
              />
            )}
          </Space>
        ),
      }]}
    />
  );
}
