import { ReleaseBranchModal } from './ReleaseBranchModal';
import type { useReleaseBranchModal } from './useReleaseBranchModal';

interface ReleaseBranchModalContainerProps {
  modal: ReturnType<typeof useReleaseBranchModal>;
  baseBranchOptions: Array<{ value: string; label: string }>;
  branchLoading?: boolean;
  onRefreshBranches: () => void;
}

export function ReleaseBranchModalContainer({
  modal,
  baseBranchOptions,
  branchLoading,
  onRefreshBranches,
}: ReleaseBranchModalContainerProps) {
  return (
    <ReleaseBranchModal
      open={modal.open}
      creating={modal.creating}
      branchName={modal.branchName}
      baseBranch={modal.baseBranch}
      baseBranchOptions={baseBranchOptions}
      branchLoading={branchLoading}
      log={modal.log}
      onBranchNameChange={modal.setBranchName}
      onBaseBranchChange={modal.setBaseBranch}
      onRefreshBranches={onRefreshBranches}
      onSubmit={modal.createReleaseBranch}
      onClose={modal.closeModal}
    />
  );
}
