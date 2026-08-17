import { Alert, Button, Card, Col, Input, Modal, Popconfirm, Row, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { SonicDevicePool } from '../../services/api';

const { Text } = Typography;

interface DevicePoolModalProps {
  open: boolean;
  saving?: boolean;
  drafts: SonicDevicePool[];
  hasRunningQualityBuild?: boolean;
  cleaningQualityWda?: string | null;
  devicePoolDevicesText: (pool: SonicDevicePool) => string;
  parseDevicePoolDevices: (text: string) => NonNullable<SonicDevicePool['devices']>;
  onUpdateDraft: (index: number, patch: Partial<SonicDevicePool>) => void;
  onAddDraft: () => void;
  onRemoveDraft: (index: number) => void;
  onCleanupWda: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function DevicePoolModal({
  open,
  saving,
  drafts,
  hasRunningQualityBuild,
  cleaningQualityWda,
  devicePoolDevicesText,
  parseDevicePoolDevices,
  onUpdateDraft,
  onAddDraft,
  onRemoveDraft,
  onCleanupWda,
  onSave,
  onClose,
}: DevicePoolModalProps) {
  return (
    <Modal
      title="质检设备池管理"
      open={open}
      okText="保存"
      cancelText="取消"
      width={760}
      confirmLoading={saving}
      onOk={onSave}
      onCancel={onClose}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="设备池由平台维护"
          description="一个设备池可配置多台 iPhone；创建任务时平台会在池内选择未被占用的 UDID，并作为 DEVICE_UDID / DEVICE_SELECTOR 传给 Jenkins。"
        />
        <Card size="small" title="设备维护">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text type="secondary">
              {hasRunningQualityBuild
                ? '当前有质检任务运行中，请先停止或等待任务结束后再清理 WDA。'
                : '用于清理本机 WDA、iproxy、xctrace 残留进程。'}
            </Text>
            <Popconfirm
              title="清理 WDA？"
              description={hasRunningQualityBuild
                ? '当前有质检任务运行中，不能清理 WDA。'
                : '会停止本机 WDA、iproxy、xctrace 残留进程。'}
              okText="清理"
              cancelText="取消"
              okButtonProps={{ danger: true, disabled: hasRunningQualityBuild }}
              disabled={hasRunningQualityBuild}
              onConfirm={onCleanupWda}
            >
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={cleaningQualityWda === '__all__'}
                disabled={hasRunningQualityBuild}
              >
                清理 WDA
              </Button>
            </Popconfirm>
          </Space>
        </Card>
        {drafts.map((pool, index) => (
          <Card size="small" key={`${pool.value}-${index}`}>
            <Row gutter={[8, 8]} align="middle">
              <Col xs={24} sm={6}>
                <Input
                  value={pool.label}
                  placeholder="名称，如 iOS 默认设备池"
                  onChange={(event) => onUpdateDraft(index, { label: event.target.value })}
                />
              </Col>
              <Col xs={24} sm={6}>
                <Input
                  value={pool.value}
                  placeholder="value，如 ios-default"
                  onChange={(event) => onUpdateDraft(index, { value: event.target.value })}
                />
              </Col>
              <Col xs={24} sm={6}>
                <Input
                  value={pool.description}
                  placeholder="说明"
                  onChange={(event) => onUpdateDraft(index, { description: event.target.value })}
                />
              </Col>
              <Col xs={24} sm={2}>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  disabled={drafts.length <= 1}
                  onClick={() => onRemoveDraft(index)}
                />
              </Col>
              <Col span={24}>
                <Input.TextArea
                  rows={3}
                  value={devicePoolDevicesText(pool)}
                  placeholder="每行一台设备：UDID 可选名称，例如 00008101-0015192E0178001E iPhone 12"
                  onChange={(event) => {
                    const devices = parseDevicePoolDevices(event.target.value);
                    onUpdateDraft(index, {
                      devices,
                      deviceId: devices[0]?.udid || '',
                      groupId: undefined,
                    });
                  }}
                />
              </Col>
            </Row>
          </Card>
        ))}
        <Button icon={<PlusOutlined />} onClick={onAddDraft}>
          新增设备池
        </Button>
      </Space>
    </Modal>
  );
}
