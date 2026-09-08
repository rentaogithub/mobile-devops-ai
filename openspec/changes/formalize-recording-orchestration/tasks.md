# Tasks: Formalize Recording Orchestration

## Consolidated Delivery Criteria

- Increment A: [Recording Source and Persistent Drafts](../../../docs/设计与演进.md#increment-a)
- Increment B: [Low-code Round Trip](../../../docs/设计与演进.md#increment-b)
- Increment C: [Published Versions and Quality Gates](../../../docs/设计与演进.md#increment-c)

Execute increments in A → B → C order. The consolidated document retains design constraints and exit criteria; detailed historical implementation plans remain available in Git history. The checkboxes below remain the authoritative OpenSpec-level delivery ledger.

## Increment A: Recording Source and Persistent Drafts

- [x] 1. Add SQLite migrations for flow assets, drafts, versions, and audit events. `[BRR-012, BRR-013, BRR-016]`
- [x] 2. Implement canonical recording-step normalization and SHA-256 source fingerprint tests. `[BRR-012]`
- [x] 3. Implement orchestration preview API returning recording identity, selected steps, fingerprint, template, and diagnostics. `[BRR-012]`
- [x] 4. Implement Flow Asset and Draft services with revision-based optimistic locking. `[BRR-013]`
- [x] 5. Implement create, read, save, validate, and reset-from-recording draft APIs. `[BRR-013, BRR-014]`
- [x] 6. Replace the implicit orchestration entry with a recording confirmation flow. `[BRR-012]`
- [x] 7. Refactor the visual designer to load and save a persistent draft instead of regenerating on every open. `[BRR-013]`
- [x] 8. Add frontend autosave, unsaved-state flush, and `FLOW_DRAFT_CONFLICT` recovery. `[BRR-013]`
- [ ] 9. Add backend, route, and frontend tests for Increment A. `[BRR-012, BRR-013, BRR-014]`

## Increment B: Low-code Round Trip

- [ ] 10. Add a safe YAML dependency and reject tags, anchors, aliases, and executable extensions. `[BRR-014]`
- [ ] 11. Implement canonical DSL-to-YAML formatting and YAML-to-DSL parsing with line/column diagnostics. `[BRR-014]`
- [ ] 12. Implement `ReplayFlowCodeEditor` with Schema-aware completion, formatting, and diagnostics. `[BRR-014]`
- [ ] 13. Add canvas/code mode switching using a single in-memory DSL state. `[BRR-014]`
- [ ] 14. Preserve unsupported valid structures as low-code nodes without semantic rewriting. `[BRR-014]`
- [ ] 15. Add semantic round-trip tests comparing compiled graphs before and after YAML conversion. `[BRR-014]`

## Increment C: Publish, History, and Quality Gates

- [x] 16. Implement transactional publish service that stores immutable DSL and compiled graph snapshots. `[BRR-015]`
- [x] 17. Implement version list, version detail, and create-draft-from-version APIs. `[BRR-015]`
- [x] 18. Implement publish and history UI, including release notes, warnings, copy, and rollback-to-new-draft. `[BRR-015]`
- [ ] 19. Split debug runs and quality runs; require `flowVersionId` for quality execution. `[BRR-016]`
- [ ] 20. Extend quality tasks to bind App build, environment, account mapping, device target, and published flow version. `[BRR-017]`
- [ ] 21. Map quality run results to `passed`, `failed`, `infra_failed`, and `cancelled`. `[BRR-017]`
- [ ] 22. Update Jenkins quality gates to consume version-bound run results and preserve evidence links. `[BRR-017]`
- [ ] 23. Add role checks and audit events for save, publish, rollback, debug run, and quality run. `[BRR-018]`
- [ ] 24. Add migration compatibility and legacy-run labeling tests. `[BRR-019]`
- [ ] 25. Execute the unlocked-device end-to-end acceptance: record, annotate, create draft, edit, publish, run, inspect evidence. `[BRR-012..BRR-019]`

## Follow-up Change Boundary

- [ ] 26. Create a separate OpenSpec change for Monkey exploration execution after the versioned quality flow is stable. `[BRR-020]`

## Composable Single-run Execution Chain

- [x] 27. Add compatible Flow Asset migrations and model fields for optional published pre-flow and post-flow version references. `[BRR-021]`
- [x] 28. Validate exact published-version references, self-reference, transitive cycles, project scope, and referenced-flow archival. `[BRR-021]`
- [x] 29. Implement persistent version-pinned `pre -> main -> post` single-run execution with cleanup-after-failure semantics and input-name-only persistence. `[BRR-021]`
- [x] 30. Add Replay Center publish action, published-version-only execution-chain configuration, runtime input confirmation, execution task list, and phase evidence report. `[BRR-021]`
- [x] 31. Complete real-device acceptance for a saved draft flow and verify its node screenshots and WDA Source evidence. `[BRR-016, BRR-021]`

## Replay Center Quality Integration

- [x] 32. Add the independent `replay_flow` quality-suite option while retaining the existing **业务编排时长** choices and legacy `business_flow` executor. `[BRR-022]`
- [x] 33. Add published Replay Center task/version selection, pinned chain preview, and runtime input collection to quality-task creation. `[BRR-017, BRR-022]`
- [x] 34. Persist an immutable pre/main/post execution manifest and keep runtime input values out of Jenkins parameters and logs. `[BRR-016, BRR-018, BRR-022]`
- [x] 35. Add the Jenkins WDA replay runner with soft-deadline looping, stop-on-failure, post-cleanup-after-failure, and JSON evidence reporting. `[BRR-017, BRR-021, BRR-022]`
- [ ] 36. Complete unlocked-device Jenkins acceptance for a `replay_flow` quality task and verify report/artifact links in Quality Center. `[BRR-017, BRR-022]`
