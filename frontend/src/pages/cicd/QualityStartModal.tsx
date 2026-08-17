import { Alert, Checkbox, Modal, Radio, Select, Space, Tag, Typography } from 'antd';
import { JenkinsBuild, JenkinsQualitySuite, SonicDevicePool } from '../../services/api';

const { Text } = Typography;

type QualityDevice = NonNullable<SonicDevicePool['devices']>[number];

interface QualityStartModalProps {
  open: boolean;
  submitting?: boolean;
  submitMessage?: string;
  builds: JenkinsBuild[];
  selectedBuild: JenkinsBuild | null;
  qualitySuite: JenkinsQualitySuite;
  qualitySuiteGroups: Array<{ title: string; options: Array<{ label: string; value: JenkinsQualitySuite }> }>;
  durationOptions: Array<{ label: string; value: number }>;
  durationSeconds: number;
  stutterScenarioOptions: Array<{ label: string; value: string }>;
  stutterScenario: string;
  businessFlowFeatureGroups: Array<{ title: string; options: Array<{ label: string; value: string }> }>;
  businessFlowFeatures: string[];
  skipInstall: boolean;
  availableDevicePools: SonicDevicePool[];
  availableDevices: QualityDevice[];
  selectedDeviceUdids: string[];
  publishChannelLabel: (channel?: string) => string;
  shouldUseInstalledProductionApp: (build?: JenkinsBuild | null) => boolean;
  onBuildChange: (build: JenkinsBuild | null) => void;
  onQualitySuiteChange: (suite: JenkinsQualitySuite) => void;
  onDurationChange: (seconds: number) => void;
  onStutterScenarioChange: (scenario: string) => void;
  onBusinessFlowFeaturesChange: (features: string[]) => void;
  onSkipInstallChange: (value: boolean) => void;
  onDeviceUdidsChange: (udids: string[]) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function QualityStartModal({
  open,
  submitting,
  submitMessage,
  builds,
  selectedBuild,
  qualitySuite,
  qualitySuiteGroups,
  durationOptions,
  durationSeconds,
  stutterScenarioOptions,
  stutterScenario,
  businessFlowFeatureGroups,
  businessFlowFeatures,
  skipInstall,
  availableDevicePools,
  availableDevices,
  selectedDeviceUdids,
  publishChannelLabel,
  shouldUseInstalledProductionApp,
  onBuildChange,
  onQualitySuiteChange,
  onDurationChange,
  onStutterScenarioChange,
  onBusinessFlowFeaturesChange,
  onSkipInstallChange,
  onDeviceUdidsChange,
  onSubmit,
  onClose,
}: QualityStartModalProps) {
  return (
    <Modal
      title="自动质检"
      open={open}
      okText="开始质检"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={onSubmit}
      cancelButtonProps={{ disabled: submitting }}
      closable={!submitting}
      maskClosable={!submitting}
      onCancel={() => {
        if (submitting) return;
        onClose();
      }}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {submitting && (
          <Alert
            type="info"
            showIcon
            message={submitMessage || '正在提交 Jenkins 质检任务...'}
            description="Jenkins 创建构建需要一点时间，任务出现在列表后弹窗会自动关闭。"
          />
        )}
        <div>
          <Text strong>质检构建</Text>
          <Select
            value={selectedBuild?.number}
            disabled={submitting}
            style={{ marginTop: 8, width: '100%' }}
            placeholder="请选择构建"
            options={builds.map((build) => ({
              value: build.number,
              label: [
                `#${build.number}`,
                publishChannelLabel(build.publishChannel) || '未知渠道',
                build.branchName || '-',
                build.appVersion || '',
              ].filter(Boolean).join(' '),
            }))}
            onChange={(value) => {
              const nextBuild = builds.find((build) => build.number === value) || null;
              onBuildChange(nextBuild);
              onSkipInstallChange(shouldUseInstalledProductionApp(nextBuild));
            }}
          />
        </div>
        <div>
          <Text strong>测试套件</Text>
          <Radio.Group
            value={qualitySuite}
            disabled={submitting}
            onChange={(event) => onQualitySuiteChange(event.target.value)}
            style={{ display: 'block', marginTop: 8 }}
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {qualitySuiteGroups.map((group) => (
                <div
                  key={group.title}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '132px 1fr',
                    columnGap: 8,
                    alignItems: 'start',
                  }}
                >
                  <Text type="secondary">{group.title}</Text>
                  <Space wrap size={[16, 8]} align="center">
                    {group.options.map((option) => (
                      <Radio key={option.value} value={option.value}>
                        {option.label}
                      </Radio>
                    ))}
                  </Space>
                </div>
              ))}
            </Space>
          </Radio.Group>
        </div>
        {(qualitySuite === 'monkey' || qualitySuite === 'stutter' || qualitySuite === 'business_flow') && (
          <div>
            <Text strong>
              {qualitySuite === 'stutter' ? '卡顿检测时长' : (qualitySuite === 'business_flow' ? '业务编排时长' : 'Monkey 执行时长')}
            </Text>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={durationOptions}
              value={durationSeconds}
              disabled={submitting}
              onChange={(event) => onDurationChange(event.target.value)}
              style={{ display: 'block', marginTop: 8 }}
            />
          </div>
        )}
        {qualitySuite === 'stutter' && (
          <div>
            <Text strong>卡顿检测场景</Text>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={stutterScenarioOptions}
              value={stutterScenario}
              disabled={submitting}
              onChange={(event) => onStutterScenarioChange(event.target.value)}
              style={{ display: 'block', marginTop: 8 }}
            />
          </div>
        )}
        {qualitySuite === 'business_flow' && (
          <div>
            <Text strong>业务功能编排</Text>
            <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
              {businessFlowFeatureGroups.map((group) => (
                <div
                  key={group.title}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '96px 1fr',
                    columnGap: 8,
                    alignItems: 'start',
                  }}
                >
                  <Text type="secondary">{group.title}</Text>
                  <Space wrap size={[16, 8]}>
                    {group.options.map((option) => (
                      <Checkbox
                        key={option.value}
                        checked={businessFlowFeatures.includes(option.value)}
                        disabled={submitting}
                        onChange={(event) => {
                          onBusinessFlowFeaturesChange(event.target.checked
                            ? Array.from(new Set([...businessFlowFeatures, option.value]))
                            : businessFlowFeatures.filter((item) => item !== option.value));
                        }}
                      >
                        {option.label}
                      </Checkbox>
                    ))}
                  </Space>
                </div>
              ))}
            </Space>
          </div>
        )}
        <div>
          <Checkbox
            checked={skipInstall}
            disabled={submitting}
            onChange={(event) => onSkipInstallChange(event.target.checked)}
          >
            使用设备上已安装的 App
          </Checkbox>
        </div>
        <div>
          <Text strong>设备池（空闲）</Text>
          {availableDevicePools.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message="当前没有空闲设备池"
              style={{ marginTop: 8 }}
            />
          )}
        </div>
        {availableDevices.length > 0 && (
          <div>
            <Checkbox.Group
              value={selectedDeviceUdids}
              disabled={submitting}
              onChange={(values) => onDeviceUdidsChange(values as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}
            >
              {availableDevices.map((device) => (
                <Checkbox key={device.udid} value={device.udid}>
                  <Space size={6} wrap>
                    <Text>{device.marketName || device.name || 'iPhone'}</Text>
                    {device.productVersion && <Tag>{device.productVersion}</Tag>}
                    <Text code style={{ fontSize: 12 }}>{device.udid}</Text>
                  </Space>
                </Checkbox>
              ))}
            </Checkbox.Group>
          </div>
        )}
      </Space>
    </Modal>
  );
}
