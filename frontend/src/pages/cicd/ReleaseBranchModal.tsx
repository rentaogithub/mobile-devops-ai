import { Button, Input, Modal, Select, Space, Typography } from 'antd';

const { Text } = Typography;

interface ReleaseBranchModalProps {
  open: boolean;
  creating?: boolean;
  branchName: string;
  baseBranch: string;
  baseBranchOptions: Array<{ value: string; label: string }>;
  branchLoading?: boolean;
  log?: string;
  onBranchNameChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onRefreshBranches: () => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ReleaseBranchModal({
  open,
  creating,
  branchName,
  baseBranch,
  baseBranchOptions,
  branchLoading,
  log,
  onBranchNameChange,
  onBaseBranchChange,
  onRefreshBranches,
  onSubmit,
  onClose,
}: ReleaseBranchModalProps) {
  return (
    <Modal
      title="拉取新分支"
      open={open}
      okText="开始拉取"
      cancelText="关闭"
      confirmLoading={creating}
      onOk={onSubmit}
      onCancel={() => {
        if (creating) return;
        onClose();
      }}
      cancelButtonProps={{ disabled: creating }}
      closable={!creating}
      maskClosable={!creating}
      width={720}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Text strong>新分支名称</Text>
          <Input
            value={branchName}
            disabled={creating}
            onChange={(event) => onBranchNameChange(event.target.value)}
            placeholder="例如 release/5.15.0"
            style={{ marginTop: 8 }}
          />
        </div>
        <div>
          <Text strong>基准分支</Text>
          <Select
            value={baseBranch}
            options={baseBranchOptions}
            disabled={creating}
            loading={branchLoading}
            onChange={onBaseBranchChange}
            placeholder="请选择基准分支"
            notFoundContent={branchLoading ? '正在加载分支...' : '未找到 release 分支'}
            style={{ marginTop: 8, width: '100%' }}
          />
          <Button
            size="small"
            type="link"
            onClick={onRefreshBranches}
            loading={branchLoading}
            disabled={creating}
            style={{ paddingInline: 0, marginTop: 4 }}
          >
            刷新分支列表
          </Button>
        </div>
        {log && (
          <pre
            style={{
              margin: 0,
              maxHeight: 280,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 12,
              lineHeight: 1.5,
              background: '#fafafa',
              padding: 12,
              border: '1px solid #f0f0f0',
              borderRadius: 4,
            }}
          >
            {log}
          </pre>
        )}
      </Space>
    </Modal>
  );
}
