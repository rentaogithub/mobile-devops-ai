import { Alert, AutoComplete, Button, Input, Modal, Radio, Space, Tag, Typography } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import {
  JenkinsAppStoreReleaseGuard,
  JenkinsBuild,
  JenkinsQualitySuite,
  JenkinsReleasePreflightResult,
  WorkflowReleaseGate,
} from '../../services/api';
import { ReleaseGatePanel } from './ReleaseGatePanel';
import { ReleasePreflightPanel } from './ReleasePreflightPanel';

const { Text } = Typography;
type DeployTarget = 'Pgyer' | 'TestFlight' | 'AppStore';

interface ReleasePublishModalProps {
  open: boolean;
  publishing?: boolean;
  canOperateCicd?: boolean;
  canPublishPgyerOrTestFlight?: boolean;
  canPublishAppStore?: boolean;
  deployTarget: DeployTarget;
  deployTargetOptions: Array<{ label: string; value: DeployTarget }>;
  publishBranch: string;
  publishBranchOptions: Array<{ value: string; label: string }>;
  branchLoading?: boolean;
  branches: string[];
  resolvedPublishAppVersion: string;
  appStoreReleaseGuard?: JenkinsAppStoreReleaseGuard | null;
  appStoreReleaseGuardLoading?: boolean;
  appStoreReleaseGuardError?: string;
  releasePreflight?: JenkinsReleasePreflightResult | null;
  releasePreflightLoading?: boolean;
  releasePreflightError?: string;
  releasePreflightBlocked?: boolean;
  appStoreGatePending?: boolean;
  appStoreGateBlocked?: boolean;
  appStoreGateWarningNeedsReason?: boolean;
  verificationPassword: string;
  releaseNotes: string;
  gateBuildNumber?: number;
  gateBuildOptions: Array<{ value: number; label: string }>;
  gatePreview?: WorkflowReleaseGate;
  gatePreviewLoading?: boolean;
  gateMissingSuites: JenkinsQualitySuite[];
  gateOverrideReason: string;
  sourceBuilds: JenkinsBuild[];
  releaseNotesLength: (value: string) => number;
  getHighestReleaseBranch: (list: string[]) => string;
  qualitySuiteName: (suite?: string) => string;
  onPublish: () => void;
  onClose: () => void;
  onDeployTargetChange: (value: DeployTarget) => void;
  onPublishBranchChange: (value: string) => void;
  onGateBuildNumberChange: (value?: number) => void;
  onVerificationPasswordChange: (value: string) => void;
  onReleaseNotesChange: (value: string) => void;
  onRefreshBranches: () => void;
  onOpenUrl: (url?: string) => void;
  onRunMissingSuite: (build?: JenkinsBuild, suite?: JenkinsQualitySuite) => void;
  onGateOverrideReasonChange: (value: string) => void;
}

export function ReleasePublishModal({
  open,
  publishing,
  canOperateCicd,
  canPublishPgyerOrTestFlight,
  canPublishAppStore,
  deployTarget,
  deployTargetOptions,
  publishBranch,
  publishBranchOptions,
  branchLoading,
  branches,
  resolvedPublishAppVersion,
  appStoreReleaseGuard,
  appStoreReleaseGuardLoading,
  appStoreReleaseGuardError,
  releasePreflight,
  releasePreflightLoading,
  releasePreflightError,
  releasePreflightBlocked,
  appStoreGatePending,
  appStoreGateBlocked,
  appStoreGateWarningNeedsReason,
  verificationPassword,
  releaseNotes,
  gateBuildNumber,
  gateBuildOptions,
  gatePreview,
  gatePreviewLoading,
  gateMissingSuites,
  gateOverrideReason,
  sourceBuilds,
  releaseNotesLength,
  getHighestReleaseBranch,
  qualitySuiteName,
  onPublish,
  onClose,
  onDeployTargetChange,
  onPublishBranchChange,
  onGateBuildNumberChange,
  onVerificationPasswordChange,
  onReleaseNotesChange,
  onRefreshBranches,
  onOpenUrl,
  onRunMissingSuite,
  onGateOverrideReasonChange,
}: ReleasePublishModalProps) {
  return (
    <Modal
      title="选择发布分支和渠道"
      open={open}
      width={640}
      styles={{ body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto', paddingRight: 4 } }}
      okText="发布"
      cancelText="取消"
      confirmLoading={publishing}
      okButtonProps={{
        disabled: (
          !canOperateCicd ||
          ((deployTarget === 'Pgyer' || deployTarget === 'TestFlight') && !canPublishPgyerOrTestFlight) ||
          (deployTarget === 'AppStore' && !canPublishAppStore) ||
          (deployTarget !== 'Pgyer' && !resolvedPublishAppVersion) ||
          (deployTarget === 'AppStore' && (appStoreReleaseGuardLoading || Boolean(appStoreReleaseGuard?.blocked))) ||
          releasePreflightLoading ||
          releasePreflightBlocked ||
          appStoreGatePending ||
          appStoreGateBlocked ||
          appStoreGateWarningNeedsReason ||
          (deployTarget !== 'Pgyer' && releaseNotesLength(releaseNotes) <= 4)
        ),
      }}
      onOk={onPublish}
      onCancel={onClose}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Text strong>发布分支</Text>
          {deployTarget === 'Pgyer' ? (
            <AutoComplete
              value={publishBranch}
              options={publishBranchOptions}
              onChange={(value) => {
                onPublishBranchChange(value);
                onGateBuildNumberChange(undefined);
              }}
              placeholder="请输入分支名，如 develop 或 release/5.14.7"
              style={{ marginTop: 8, width: '100%' }}
              filterOption={(inputValue, option) =>
                String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
              }
            />
          ) : (
            <Space.Compact style={{ marginTop: 8, width: '100%' }}>
              <Input
                value={publishBranch || '未找到 release/x.x.x 分支'}
                readOnly
                status={publishBranch ? undefined : 'warning'}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 11px',
                  border: '1px solid #d9d9d9',
                  borderLeft: 0,
                  borderRadius: '0 6px 6px 0',
                  background: '#fafafa',
                  whiteSpace: 'nowrap',
                }}
              >
                <Tag color={resolvedPublishAppVersion ? 'blue' : 'red'} style={{ marginInlineEnd: 0 }}>
                  发布版本 {resolvedPublishAppVersion || '未识别'}
                </Tag>
              </div>
            </Space.Compact>
          )}
          <Space style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {branchLoading
                ? '正在加载分支列表...'
                : deployTarget === 'Pgyer'
                  ? '可选择已有分支，也可直接输入分支名'
                  : 'TestFlight / 苹果商店自动使用当前 release/ 下最高版本分支'}
            </Text>
            <Button size="small" type="link" onClick={onRefreshBranches} loading={branchLoading}>
              刷新分支
            </Button>
          </Space>
          {deployTarget === 'AppStore' && appStoreReleaseGuardLoading && (
            <Alert
              type="info"
              showIcon
              message="正在检查苹果商店版本状态..."
              style={{ marginTop: 8 }}
            />
          )}
          {deployTarget === 'AppStore' && !appStoreReleaseGuardLoading && appStoreReleaseGuard?.blocked && (
            <Alert
              type="error"
              showIcon
              message={appStoreReleaseGuard.message || `当前发布版本 ${appStoreReleaseGuard.appVersion || '-'} 状态不允许重复发布`}
              style={{ marginTop: 8 }}
            />
          )}
          {deployTarget === 'AppStore' && !appStoreReleaseGuardLoading && appStoreReleaseGuardError && (
            <Alert
              type="warning"
              showIcon
              message={appStoreReleaseGuardError}
              style={{ marginTop: 8 }}
            />
          )}
          {deployTarget !== 'Pgyer' && !resolvedPublishAppVersion && (
            <Text type="danger" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
              未识别到发布版本
            </Text>
          )}
          <ReleasePreflightPanel
            loading={releasePreflightLoading}
            preflight={releasePreflight}
            error={releasePreflightError}
          />
        </div>
        <div>
          <Text strong>发布渠道</Text>
        </div>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          options={deployTargetOptions}
          value={deployTarget}
          onChange={(event) => {
            const nextTarget = event.target.value as DeployTarget;
            onDeployTargetChange(nextTarget);
            if (nextTarget !== 'Pgyer') {
              onPublishBranchChange(getHighestReleaseBranch(branches));
              onGateBuildNumberChange(undefined);
            }
            if (nextTarget === 'Pgyer') {
              onVerificationPasswordChange('');
              onReleaseNotesChange('');
            }
            if (nextTarget === 'AppStore') {
              onReleaseNotesChange('');
            }
          }}
        />
        {deployTarget !== 'Pgyer' && (
          <Input.Password
            placeholder="请输入验证密码（留空时使用管理员配置）"
            value={verificationPassword}
            onChange={(event) => onVerificationPasswordChange(event.target.value)}
          />
        )}
        {deployTarget !== 'Pgyer' && (
          <div>
            <Text strong>发布文案</Text>
            <Input.TextArea
              value={releaseNotes}
              onChange={(event) => onReleaseNotesChange(event.target.value)}
              placeholder={deployTarget === 'TestFlight'
                ? '请输入 TestFlight 测试内容，会自动填写到 App Store Connect'
                : '请输入苹果商店发布文案，会随正式包发布链路提交'}
              autoSize={{ minRows: 3, maxRows: 6 }}
              maxLength={4000}
              showCount
              status={releaseNotesLength(releaseNotes) <= 4 ? 'error' : undefined}
              style={{ marginTop: 8 }}
            />
            {releaseNotesLength(releaseNotes) <= 4 && (
              <Text type="danger" style={{ fontSize: 12 }}>
                发布文案必填，且必须超过 4 个字
              </Text>
            )}
          </div>
        )}
        {deployTarget === 'AppStore' && (
          <Alert
            type="info"
            showIcon
            message="商店截图、预览视频等素材请在 App Store Connect 修改，平台只负责发布文案和自动提审。"
            action={(
              <Button size="small" type="link" icon={<ExportOutlined />} onClick={() => onOpenUrl('https://appstoreconnect.apple.com/apps')}>
                打开 App Store Connect
              </Button>
            )}
          />
        )}
        <ReleaseGatePanel
          deployTarget={deployTarget}
          gateBuildNumber={gateBuildNumber}
          gateBuildOptions={gateBuildOptions}
          preview={gatePreview}
          previewLoading={gatePreviewLoading}
          missingSuites={gateMissingSuites}
          overrideReason={gateOverrideReason}
          onGateBuildChange={(value) => {
            onGateBuildNumberChange(value);
            onGateOverrideReasonChange('');
          }}
          onOverrideReasonChange={onGateOverrideReasonChange}
          onRunMissingSuite={(suite) => {
            const build = sourceBuilds.find((item) => item.number === gateBuildNumber);
            onRunMissingSuite(build, suite);
          }}
          qualitySuiteName={qualitySuiteName}
        />
      </Space>
    </Modal>
  );
}
