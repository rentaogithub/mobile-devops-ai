import { Button, Space, Typography } from 'antd';
import {
  BranchesOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  SettingOutlined,
} from '@ant-design/icons';

import { JenkinsCicdHealthResult } from '../../services/api';
import { cicdHealthStatusTag } from './CicdHealthPanel';

const { Title, Paragraph } = Typography;

export type CICDSection = 'release' | 'quality' | 'devices';

export function getCicdSectionFromPath(pathname: string): CICDSection {
  if (pathname.startsWith('/cicd/quality')) return 'quality';
  if (pathname.startsWith('/cicd/devices')) return 'devices';
  return 'release';
}

export function getCicdPageMeta(activeSection: CICDSection) {
  if (activeSection === 'quality') {
    return {
      title: '自动质检',
      description: '构建包由 Jenkins 产出，质检任务由独立 Jenkins Job 编排，基于打包机 USB 真机覆盖安装、启动、用例、截图和报告采集。',
    };
  }
  if (activeSection === 'devices') {
    return {
      title: 'iOS设备注册',
      description: '通过扫码采集 iPhone Identifier，并注册到 Apple Developer 设备列表，用于开发包或 Ad Hoc 包安装。',
    };
  }
  return {
    title: '发布管理',
    description: 'nn-ios Jekins构建与发布蒲公英、TestFlight、苹果商店包。',
  };
}

interface CicdPageHeaderProps {
  activeSection: CICDSection;
  title: string;
  description: string;
  cicdHealth?: JenkinsCicdHealthResult | null;
  cicdHealthLoading?: boolean;
  canCreateReleaseBranch?: boolean;
  canOperateCicd?: boolean;
  canAdminCicd?: boolean;
  canUseQuality?: boolean;
  canOpenQualityModal?: boolean;
  loading?: boolean;
  publishing?: boolean;
  qualityLoading?: boolean;
  qualityJobSyncing?: boolean;
  onToggleHealth: () => void;
  onOpenReleaseBranchModal: () => void;
  onRefreshBuilds: () => void;
  onOpenPublishModal: () => void;
  onSyncQualityJobConfig: () => void;
  onOpenDevicePoolModal: () => void;
  onRefreshQuality: () => void;
  onOpenQualityModal: () => void;
}

export function CicdPageHeader({
  activeSection,
  title,
  description,
  cicdHealth,
  cicdHealthLoading,
  canCreateReleaseBranch,
  canOperateCicd,
  canAdminCicd,
  canUseQuality,
  canOpenQualityModal,
  loading,
  publishing,
  qualityLoading,
  qualityJobSyncing,
  onToggleHealth,
  onOpenReleaseBranchModal,
  onRefreshBuilds,
  onOpenPublishModal,
  onSyncQualityJobConfig,
  onOpenDevicePoolModal,
  onRefreshQuality,
  onOpenQualityModal,
}: CicdPageHeaderProps) {
  return (
    <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
      <div>
        <Title level={4}>
          <RocketOutlined style={{ marginRight: 8, color: '#722ed1' }} />
          {title}
        </Title>
        <Paragraph type="secondary">
          {description}
        </Paragraph>
      </div>
      {activeSection === 'release' ? (
        <Space>
          <Button icon={<SettingOutlined />} loading={cicdHealthLoading} onClick={onToggleHealth}>
            <Space size={4}>
              <span>健康检查</span>
              {cicdHealthStatusTag(cicdHealth)}
            </Space>
          </Button>
          {canCreateReleaseBranch && (
            <Button icon={<BranchesOutlined />} onClick={onOpenReleaseBranchModal}>
              拉取新分支
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={onRefreshBuilds} loading={loading}>
            刷新
          </Button>
          {canOperateCicd && (
            <Button type="primary" icon={<PlayCircleOutlined />} loading={publishing} onClick={onOpenPublishModal}>
              发布
            </Button>
          )}
        </Space>
      ) : activeSection === 'quality' ? (
        <Space>
          {canAdminCicd && (
            <>
              <Button icon={<SettingOutlined />} loading={qualityJobSyncing} onClick={onSyncQualityJobConfig}>
                同步 Jenkins 配置
              </Button>
              <Button icon={<SettingOutlined />} onClick={onOpenDevicePoolModal}>
                设备池
              </Button>
            </>
          )}
          <Button icon={<ReloadOutlined />} onClick={onRefreshQuality} loading={qualityLoading}>
            刷新
          </Button>
          {canUseQuality && (
            <Button type="primary" icon={<RocketOutlined />} onClick={onOpenQualityModal} loading={loading} disabled={!canOpenQualityModal}>
              开始质检
            </Button>
          )}
        </Space>
      ) : null}
    </div>
  );
}
