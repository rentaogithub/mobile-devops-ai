# Change Proposal: Formalize Recording Orchestration

## Summary

把现有“录制后临时生成画布”的技术闭环升级为来源明确、可持久化、可发布、可审计并可接入自动质检的流程资产体系。

## Why

现有系统能够录制、补标、生成 DSL、可视化编排和真机执行，但用户打开编排时可能实际使用最近一次历史录制，且画布修改尚未形成稳定草稿。复杂条件也缺少低代码编辑，正式质量任务无法绑定不可变版本。

这些缺口会导致：

- 用户无法确认流程来源。
- 页面关闭后编辑结果可能丢失。
- 历史报告不能严格恢复执行时的流程版本。
- Jenkins 门禁可能执行临时 DSL，而不是审核过的 P0 流程。

## What Changes

1. 将“编排流程”改为显式的“基于本次录制生成编排”，生成前确认录制和步骤。
2. 增加 Flow Asset、Flow Draft 和草稿 revision，持久化画布编辑结果。
3. 增加 YAML 低代码编辑器，并与画布共享同一份 DSL。
4. 增加不可变 Published Version 和 History。
5. 区分草稿调试运行和发布版本质量运行。
6. 允许 P0 用例、自动质检任务和 Jenkins 门禁绑定发布版本。
7. 明确 Monkey 仅输出探索候选，必须人工收敛后才能成为正式流程。

## Current Capability Reused

- DeviceRecordingService 的录制、候选和补标能力。
- DSL v1、JSON Schema、静态校验和执行图编译。
- DeviceReplayFlowExecutionService 的状态驱动执行和证据。
- ReplayFlowDesigner 的可视化投影和编辑能力。

## Impacted Areas

### Backend

- 新增流程资产、草稿和版本持久化服务。
- 扩展 device-control API。
- 质量任务绑定发布版本。
- 增加迁移和权限审计。

### Frontend

- 录制来源确认界面。
- 草稿保存、冲突和恢复界面。
- 低代码编辑器。
- 发布、历史、复制和回滚界面。

### CI

- Jenkins 质量门禁读取发布版本运行结果。
- 区分产品失败和基础设施失败。

## Compatibility

- 现有 Recording 文件和证据保持可读。
- 现有 DSL v1 保持有效。
- 现有 `/replay-flows/runs` 调试 API 在迁移期间保留。
- 旧录制可以生成新的 Flow Draft。
- 现有历史运行记录不反向伪造发布版本，只标记为 legacy run。

## Delivery Increments

1. 来源确认与草稿持久化。
2. 低代码与画布双向编辑。
3. 发布历史与自动质检门禁。

Monkey 探索执行本身不属于本 change 的实现范围；本 change 只定义其输出必须进入候选和人工收敛流程。

## Success Criteria

- 每个草稿都能追溯到明确录制和来源指纹。
- 页面关闭和服务重启后草稿仍可恢复。
- 画布和 YAML 双向切换不改变 DSL 语义。
- 所有正式质检运行绑定不可变发布版本。
- 历史报告能够恢复执行时 DSL、执行图、设备和证据。
