# Versioned Quality Flow Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish immutable replay-flow versions, bind P0 quality cases and Jenkins runs to exact versions, classify product versus infrastructure failures, and preserve complete audit/history compatibility.

**Architecture:** Publishing atomically snapshots validated DSL and its compiled graph into monotonically numbered SQLite versions. Formal quality requests reference a saved P0 case and `flowVersionId`; Jenkins passes only identifiers and environment references to a local Node CLI, which loads the immutable version and executes it through the same replay engine used for draft debug runs. Workflow tasks, run bindings, reports, and release gates carry the exact version and normalized result category.

**Tech Stack:** TypeScript 5.3, Node.js 20, Express 4, SQLite/`better-sqlite3`, existing WDA replay engine, Jest, React 18, Ant Design 5, Jenkins parameterized jobs, zsh/Python report wrapper in `scripts/sonic/ios-quality.sh`.

**Spec:** `docs/superpowers/specs/2026-09-01-ios-black-box-recording-orchestration-design.md`; OpenSpec delta: `openspec/changes/formalize-recording-orchestration/specs/ios-black-box-recording-replay/spec.md` (BRR-015 through BRR-020).

## Global Constraints

- Published versions are immutable; editing, rollback, and copying always create or replace an editable draft and require a new publish.
- Version numbers are monotonically increasing per flow asset and allocated inside the same transaction that inserts DSL and compiled graph snapshots.
- Publish requires valid Schema/static validation and successful compilation; failure creates no partial row and consumes no version number.
- Draft debug runs bind `draftId + revision`; formal quality runs bind `flowVersionId` and MUST NOT accept request-body DSL overrides.
- P0 case configuration binds App build, environment, device target, account reference mapping, and input mapping; passwords/tokens/real secret values are never stored in flow assets, versions, audit records, or run logs.
- Publish and rollback require role `developer` or `admin`; draft creation/save/debug remains available to `tester`, `developer`, and `admin`.
- Formal result categories are exactly `passed`, `failed`, `infra_failed`, and `cancelled`.
- Assertion/state/target failures with a healthy device session are product `failed`; locked/disconnected device, WDA startup/transport failure, and runner interruption are `infra_failed`.
- Jenkins receives `flowVersionId`, result category, duration, and report/evidence URL and applies an explicit `infraFailurePolicy` of `block`, `warn`, or `ignore`.
- Existing recordings, DSL v1 template endpoints, evidence files, and historical runs remain readable; unbound historical runs are labeled `legacy` and are never assigned an invented version.
- Monkey remains exploratory: this plan does not auto-publish Monkey paths or make them release-gate inputs; BRR-020 promotion is a separate OpenSpec change.

---

## File Structure

- `backend/src/services/DeviceReplayFlowVersionService.ts`: publish, immutable version reads, version listing, and draft-from-version operations.
- `backend/src/services/DeviceReplayFlowVersionService.test.ts`: atomicity, numbering, immutability, authorization-independent domain behavior.
- `backend/src/services/DeviceReplayFlowQualityService.ts`: P0 case persistence, version-bound task preparation, result classification, and report linkage.
- `backend/src/services/DeviceReplayFlowQualityService.test.ts`: missing version, secret rejection, exact binding, and category mapping.
- `backend/src/services/ReplayFlowAccountResolver.ts`: resolve local test-account references from a locked-down file into in-memory runtime inputs.
- `backend/src/services/ReplayFlowAccountResolver.test.ts`: file-permission, missing reference, and non-persistence tests.
- `backend/src/services/WdaReplayRuntimeAdapter.ts`: WDA HTTP adapter used by the local quality CLI.
- `backend/src/cli/runReplayFlowVersion.ts`: load immutable version, execute it, persist binding, and write a machine-readable result.
- `backend/src/routes/deviceControl.routes.ts`: publish/history/copy/rollback and quality-case APIs with role checks.
- `backend/src/routes/quality.routes.ts`: formal business-flow task validation and version propagation.
- `backend/src/routes/jenkins.routes.ts`: existing Jenkins trigger path migrated from arbitrary business plan to flow version ID.
- `backend/src/services/QualityGateService.ts`: explicit `infraFailurePolicy` handling.
- `backend/src/database/schema.sql`: P0 case bindings and quality case run records.
- `frontend/src/components/ReplayFlowPublishModal.tsx`: publish validation/warnings/release note UI.
- `frontend/src/components/ReplayFlowVersionHistory.tsx`: immutable version list/detail/copy/rollback UI.
- `frontend/src/components/ReplayFlowQualityCasePanel.tsx`: saved P0 case binding editor.
- `frontend/src/components/ReplayFlowDesigner.tsx`: publish/history entry points and current version state.
- `frontend/src/pages/CICDPage.tsx`: published version/P0 case selector replacing arbitrary business feature checkboxes.
- `frontend/src/services/api.ts`: version, P0 case, and quality payload types.
- `scripts/sonic/ios-quality.sh`: version-bound CLI delegation and normalized report/status propagation.
- `scripts/jenkins/nn-auto-quality-config.xml`: `FLOW_VERSION_ID` and `FLOW_QUALITY_CASE_ID` parameters.

### Task 1: Transactional immutable publishing

**Files:**
- Create: `backend/src/services/DeviceReplayFlowVersionService.ts`
- Create: `backend/src/services/DeviceReplayFlowVersionService.test.ts`
- Modify: `backend/src/services/DeviceReplayFlowAssetService.ts`
- Read: `backend/src/database/schema.sql`

**Interfaces:**
- Consumes: `device_replay_flow_assets`, `device_replay_flow_drafts`, `device_replay_flow_versions`, `device_replay_flow_audits`, `validateDeviceReplayFlow`, `compileDeviceReplayFlow`.
- Produces:

```ts
export interface ReplayFlowVersion {
  id: string;
  assetId: string;
  versionNumber: number;
  sourceRecordingId: string;
  sourceFingerprint: string;
  schemaVersion: string;
  flow: DeviceReplayFlowDsl;
  compiled: CompiledDeviceReplayFlow;
  releaseNotes: string;
  publishedBy: string;
  publishedAt: string;
}

export class DeviceReplayFlowVersionService {
  publish(input: { draftId: string; expectedRevision: number; releaseNotes: string; actor: string; isAdmin: boolean }): { asset: ReplayFlowAsset; version: ReplayFlowVersion };
  getVersion(versionId: string, actor: string, isAdmin: boolean): ReplayFlowVersion;
  listVersions(assetId: string, actor: string, isAdmin: boolean): ReplayFlowVersion[];
  createDraftFromVersion(input: { versionId: string; actor: string; isAdmin: boolean; reason: 'copy' | 'rollback' }): ReplayFlowDraft;
}
```

- [ ] **Step 1: Write failing publish tests**

```ts
it('stores immutable dsl and compiled snapshots at version 1', () => {
  const published = versions.publish({ draftId: draft.id, expectedRevision: 1, releaseNotes: 'P0 登录', actor: 'developer', isAdmin: false });
  expect(published.version).toMatchObject({ versionNumber: 1, flow: draft.flow, compiled: compileDeviceReplayFlow(draft.flow) });
  drafts.saveDraft({ draftId: draft.id, expectedRevision: 1, flow: renamedFlow('draft changed'), actor: 'developer', isAdmin: false });
  expect(versions.getVersion(published.version.id, 'developer', false).flow.name).toBe(draft.flow.name);
});

it('does not consume a version number when validation fails', () => {
  expect(() => versions.publish({ draftId: invalidDraft.id, expectedRevision: 1, releaseNotes: 'invalid', actor: 'developer', isAdmin: false }))
    .toThrow(expect.objectContaining({ code: 'FLOW_VALIDATION_FAILED' }));
  expect(versions.publish({ draftId: validDraft.id, expectedRevision: 1, releaseNotes: 'first', actor: 'developer', isAdmin: false }).version.versionNumber).toBe(1);
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `cd backend && npm test -- DeviceReplayFlowVersionService.test.ts --runInBand`

Expected: FAIL because the version service is absent.

- [ ] **Step 3: Implement atomic publish**

Inside one `better-sqlite3` transaction:

1. Load draft and access-check its asset.
2. Require `draft.revision === expectedRevision`, otherwise `FLOW_PUBLISH_CONFLICT` 409.
3. Validate and compile before the first write.
4. Select `COALESCE(MAX(version_number), 0) + 1` for that asset.
5. Insert version with serialized DSL and compiled graph.
6. Update `asset.latest_published_version` and timestamp.
7. Insert `flow.published` audit containing draft revision, version ID/number, warning codes, and release-note length only.

Catch the unique `(asset_id, version_number)` conflict and retry the complete transaction once; a second collision returns `FLOW_PUBLISH_CONFLICT`.

- [ ] **Step 4: Implement copy/rollback as draft replacement, never version mutation**

`createDraftFromVersion` writes the selected version flow into the asset’s editable draft as `revision + 1`, preserving the version’s source recording/fingerprint. Audit action is `flow.copied` or `flow.rollback_draft_created`. Published rows have no update/delete method.

- [ ] **Step 5: Run version, draft, and DSL tests**

Run: `cd backend && npm test -- DeviceReplayFlowVersionService.test.ts DeviceReplayFlowAssetService.test.ts DeviceReplayFlow.test.ts --runInBand && npm run typecheck`

Expected: PASS; version JSON remains unchanged after later draft saves.

- [ ] **Step 6: Commit version lifecycle domain code**

```bash
git add backend/src/services/DeviceReplayFlowVersionService.ts backend/src/services/DeviceReplayFlowVersionService.test.ts backend/src/services/DeviceReplayFlowAssetService.ts
git commit -m "feat: publish immutable replay flow versions"
```

### Task 2: Publish/history APIs and role enforcement

**Files:**
- Modify: `backend/src/routes/deviceControl.routes.ts`
- Modify: `backend/src/routes/deviceControl.routes.test.ts`
- Modify: `backend/src/middleware/auth.ts` only if a typed role helper is needed.

**Interfaces:**
- Consumes: version service from Task 1 and existing `requireAnyRole`.
- Produces:
  - `POST /api/device-control/replay-flow-drafts/:draftId/publish` body `{ expectedRevision, releaseNotes }`.
  - `GET /api/device-control/replay-flow-assets/:assetId/versions`.
  - `GET /api/device-control/replay-flow-versions/:versionId`.
  - `POST /api/device-control/replay-flow-versions/:versionId/copy-to-draft`.
  - `POST /api/device-control/replay-flow-versions/:versionId/rollback-to-draft`.

- [ ] **Step 1: Write failing authorization and immutability route tests**

```ts
it.each(['tester'])('forbids %s from publishing', async (role) => {
  const response = await authenticatedRequest(role).post(`/api/device-control/replay-flow-drafts/${draft.id}/publish`).send({ expectedRevision: 1, releaseNotes: 'release' });
  expect(response.status).toBe(403);
  expect(versionCount()).toBe(0);
});

it('allows developer publish and returns immutable version detail', async () => {
  const response = await authenticatedRequest('developer').post(...).send({ expectedRevision: 1, releaseNotes: 'P0' });
  expect(response.status).toBe(201);
  expect(response.body.data.version).toMatchObject({ versionNumber: 1, releaseNotes: 'P0' });
});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run: `cd backend && npm test -- deviceControl.routes.test.ts --runInBand`

Expected: FAIL with 404 for version routes.

- [ ] **Step 3: Add a route-local publish permission guard**

Because the router-wide guard already admits testers, add `const flowPublishMiddleware = requireAnyRole(['developer', 'admin'])` directly on publish/copy/rollback routes. Reads remain available to tester/developer/admin. Return `FLOW_VALIDATION_FAILED` details unchanged from the domain error.

- [ ] **Step 4: Validate release notes and revision**

Require integer revision >= 1; normalize release notes to at most 2000 characters and require non-empty text for publish. Copy and rollback require no DSL body and ignore any body `flow` field.

- [ ] **Step 5: Run route/service checks**

Run: `cd backend && npm test -- deviceControl.routes.test.ts DeviceReplayFlowVersionService.test.ts --runInBand && npm run typecheck`

Expected: PASS; tester receives 403 and no version/audit rows are created.

- [ ] **Step 6: Commit version HTTP APIs**

```bash
git add backend/src/routes/deviceControl.routes.ts backend/src/routes/deviceControl.routes.test.ts backend/src/middleware/auth.ts
git commit -m "feat: expose replay flow publish and history APIs"
```

### Task 3: Publish and version-history UI

**Files:**
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/components/ReplayFlowPublishModal.tsx`
- Create: `frontend/src/components/ReplayFlowPublishModal.test.tsx`
- Create: `frontend/src/components/ReplayFlowVersionHistory.tsx`
- Create: `frontend/src/components/ReplayFlowVersionHistory.test.tsx`
- Modify: `frontend/src/components/ReplayFlowDesigner.tsx`
- Modify: `frontend/src/components/ReplayFlowDesigner.css`

**Interfaces:**
- Consumes: Task 2 APIs and saved draft state from Increment A.
- Produces typed version API methods and publish/history callbacks that always return a new server draft/version object.

- [ ] **Step 1: Write failing publish warning and rollback tests**

```tsx
it('shows validation warnings and requires release notes before publish', async () => {
  render(<ReplayFlowPublishModal open draft={warningDraft} role="developer" onCancel={vi.fn()} onPublished={onPublished} />);
  expect(screen.getByText(warningDraft.validation.warnings[0].message)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '发布不可变版本' })).toBeDisabled();
});

it('rollback creates a new draft and does not mutate the selected version', async () => {
  render(<ReplayFlowVersionHistory ... />);
  await userEvent.click(screen.getByRole('button', { name: '回滚为新草稿' }));
  await userEvent.click(screen.getByRole('button', { name: '确认创建草稿' }));
  expect(api.rollbackReplayFlowVersion).toHaveBeenCalledWith('version-1');
  expect(onDraftCreated).toHaveBeenCalledWith(expect.objectContaining({ revision: 9 }));
});
```

- [ ] **Step 2: Run component tests and verify the red state**

Run: `cd frontend && npm test -- ReplayFlowPublishModal.test.tsx ReplayFlowVersionHistory.test.tsx`

Expected: FAIL because components/API methods are absent.

- [ ] **Step 3: Add version API contracts**

Add `publishReplayFlowDraft`, `listReplayFlowVersions`, `getReplayFlowVersion`, `copyReplayFlowVersionToDraft`, and `rollbackReplayFlowVersionToDraft`. Types include exact DSL, compiled graph, source fingerprint, publisher, timestamp, and release notes.

- [ ] **Step 4: Build publish modal and role-aware actions**

Display validation errors/warnings, draft revision, source fingerprint prefix, and a required release-note text area. Hide/disable publish for testers with text “发布需要研发或管理员权限”. On success update asset latest version and keep the current draft open.

- [ ] **Step 5: Build immutable history drawer**

List newest version first. Detail view renders metadata, read-only canonical YAML, and compiled node/edge counts. “复制为草稿” and “回滚为新草稿” both require confirmation and replace the designer’s active draft with the returned revision; neither sends DSL to the server.

- [ ] **Step 6: Run frontend tests and build**

Run: `cd frontend && npm test -- ReplayFlowPublishModal.test.tsx ReplayFlowVersionHistory.test.tsx ReplayFlowDesigner.test.tsx && npm run build`

Expected: PASS and the production bundle compiles.

- [ ] **Step 7: Commit publish/history UI**

```bash
git add frontend/src/services/api.ts frontend/src/components/ReplayFlowPublishModal.tsx frontend/src/components/ReplayFlowPublishModal.test.tsx frontend/src/components/ReplayFlowVersionHistory.tsx frontend/src/components/ReplayFlowVersionHistory.test.tsx frontend/src/components/ReplayFlowDesigner.tsx frontend/src/components/ReplayFlowDesigner.css
git commit -m "feat: publish and inspect replay flow versions"
```

### Task 4: P0 quality case bindings and result classification

**Files:**
- Modify: `backend/src/database/schema.sql`
- Create: `backend/src/services/DeviceReplayFlowQualityService.ts`
- Create: `backend/src/services/DeviceReplayFlowQualityService.test.ts`
- Create: `backend/src/services/ReplayFlowAccountResolver.ts`
- Create: `backend/src/services/ReplayFlowAccountResolver.test.ts`
- Modify: `backend/src/services/WorkflowService.ts`

**Interfaces:**
- Consumes: immutable version service, workflow tasks, and replay run status/error codes.
- Produces:

```ts
export type ReplayFlowQualityResult = 'passed' | 'failed' | 'infra_failed' | 'cancelled';

export interface ReplayFlowQualityCase {
  id: string;
  projectId: string;
  name: string;
  priority: 'P0';
  flowVersionId: string;
  environment: { id: string; baseUrl?: string; labels?: string[] };
  deviceTarget: { poolId: string; udid?: string };
  accountMapping: Record<string, { accountRef: string }>;
  inputMapping: Record<string, { source: 'literal' | 'account_field'; value?: string; accountKey?: string; field?: string }>;
  enabled: boolean;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

export function classifyReplayFlowQualityRun(run: ReplayFlowRun): ReplayFlowQualityResult;

export class ReplayFlowAccountResolver {
  constructor(vaultPath = process.env.QA_ACCOUNT_VAULT_PATH || '');
  resolve(accountRef: string, field: string): string;
}
```

- [ ] **Step 1: Add failing case/secret/category tests**

```ts
it('requires an existing published version', () => {
  expect(() => service.saveCase(caseInput({ flowVersionId: 'missing' }), 'tester', false))
    .toThrow(expect.objectContaining({ code: 'FLOW_VERSION_REQUIRED' }));
});

it('rejects inline password fields', () => {
  expect(() => service.saveCase(caseInput({ accountMapping: { primary: { accountRef: 'qa-user', password: 'secret' } } as any }), 'tester', false))
    .toThrow(expect.objectContaining({ code: 'FLOW_SECRET_INLINE_FORBIDDEN' }));
});

it.each([
  [{ status: 'succeeded', result: 'success' }, 'passed'],
  [{ status: 'cancelled', errorCode: 'RUN_CANCELLED' }, 'cancelled'],
  [{ status: 'failed', errorCode: 'WDA_SOURCE_TIMEOUT' }, 'infra_failed'],
  [{ status: 'failed', errorCode: 'NODE_TIMEOUT' }, 'failed'],
  [{ status: 'failed', errorCode: 'TARGET_NOT_FOUND' }, 'failed'],
])('classifies %o as %s', (run, expected) => expect(classifyReplayFlowQualityRun(run as ReplayFlowRun)).toBe(expected));
```

- [ ] **Step 2: Run tests and verify the red state**

Run: `cd backend && npm test -- DeviceReplayFlowQualityService.test.ts --runInBand`

Expected: FAIL because schema/service are absent.

- [ ] **Step 3: Add P0 case and case-run tables**

```sql
CREATE TABLE IF NOT EXISTS device_replay_quality_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  name TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P0' CHECK(priority = 'P0'),
  flow_version_id TEXT NOT NULL,
  environment_json TEXT NOT NULL,
  device_target_json TEXT NOT NULL,
  account_mapping_json TEXT NOT NULL,
  input_mapping_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  owner TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (flow_version_id) REFERENCES device_replay_flow_versions(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS device_replay_quality_case_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  workflow_task_id TEXT NOT NULL,
  replay_run_id TEXT,
  result_category TEXT CHECK(result_category IN ('passed','failed','infra_failed','cancelled')),
  duration_ms INTEGER,
  report_url TEXT,
  evidence_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (case_id) REFERENCES device_replay_quality_cases(id) ON DELETE RESTRICT,
  FOREIGN KEY (flow_version_id) REFERENCES device_replay_flow_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (workflow_task_id) REFERENCES workflow_tasks(id) ON DELETE RESTRICT
);
```

Add indexes on `(project_id, enabled, updated_at)` and `(flow_version_id, created_at)`.

- [ ] **Step 4: Implement strict case normalization**

Allow only `accountRef` in account mappings; reject keys matching `/password|passwd|token|secret|credential/i` anywhere in saved case input. Literal input mappings are allowed only for non-sensitive DSL inputs; input names matching the same sensitive pattern must use `account_field`. Verify every mapped input exists in the published DSL and every required input is mapped.

Implement `ReplayFlowAccountResolver` against a local JSON vault file configured by `QA_ACCOUNT_VAULT_PATH`:

```json
{
  "qa-primary": { "username": "local-test-user", "password": "local-secret" }
}
```

Require the file to be regular, owned by the current user, and mode `0400` or `0600`; otherwise throw `FLOW_ACCOUNT_VAULT_INSECURE`. Resolve only the exact `accountRef` and field requested by the case mapping. Never return the complete account object to API callers and never cache it beyond the current process run.

- [ ] **Step 5: Implement exact result classification**

Use this infrastructure set: `DEVICE_LOCKED`, `DEVICE_DISCONNECTED`, `DEVICE_NOT_CONNECTED`, `WDA_START_FAILED`, `WDA_SESSION_FAILED`, `WDA_SOURCE_TIMEOUT`, `WDA_REQUEST_FAILED`, `WDA_TRANSPORT_ERROR`, `RUNNER_INTERRUPTED`. `RUN_CANCELLED` maps to cancelled. All other failed runs, including assertion, target, condition, and timeout errors, map to product failed.

- [ ] **Step 6: Run quality service and workflow tests**

Run: `cd backend && npm test -- DeviceReplayFlowQualityService.test.ts ReplayFlowAccountResolver.test.ts WorkflowService.test.ts --runInBand && npm run typecheck`

Expected: PASS; no saved JSON contains the fixture password.

- [ ] **Step 7: Commit P0 case domain model**

```bash
git add backend/src/database/schema.sql backend/src/services/DeviceReplayFlowQualityService.ts backend/src/services/DeviceReplayFlowQualityService.test.ts backend/src/services/ReplayFlowAccountResolver.ts backend/src/services/ReplayFlowAccountResolver.test.ts backend/src/services/WorkflowService.ts
git commit -m "feat: bind p0 quality cases to replay flow versions"
```

### Task 5: Version-bound local WDA quality runner

**Files:**
- Create: `backend/src/services/WdaReplayRuntimeAdapter.ts`
- Create: `backend/src/services/WdaReplayRuntimeAdapter.test.ts`
- Create: `backend/src/cli/runReplayFlowVersion.ts`
- Create: `backend/src/cli/runReplayFlowVersion.test.ts`
- Modify: `backend/package.json`
- Modify: `backend/src/services/DeviceReplayFlowExecutionService.ts`

**Interfaces:**
- Consumes: published version service, replay engine, WDA URL/session, quality classifier.
- Produces:
  - npm script `quality:flow-version`: `tsx src/cli/runReplayFlowVersion.ts`.
  - CLI arguments `--flow-version-id`, `--quality-case-id`, `--workflow-task-id`, `--wda-url`, `--device-udid`, `--output`.
  - Result file:

```json
{
  "schemaVersion": "business-flow-report.v2",
  "name": "P0 登录流程",
  "status": "passed",
  "message": "流程执行通过",
  "flowVersionId": "flow_version_uuid",
  "qualityCaseId": "quality_case_uuid",
  "workflowTaskId": "task_uuid",
  "replayRunId": "run_uuid",
  "resultCategory": "passed",
  "durationMs": 1234,
  "reportUrl": "...",
  "evidenceUrl": "...",
  "totalSteps": 4,
  "passedSteps": 4,
  "failedSteps": 0,
  "skippedSteps": 0,
  "steps": [],
  "issues": []
}
```

- [ ] **Step 1: Write failing WDA adapter request tests**

Mock `global.fetch` and assert the adapter discovers a session, reads `/session/:id/source`, decodes `/screenshot`, and sends normalized tap/swipe/keys requests. A 5xx/timeout must throw a typed error code `WDA_TRANSPORT_ERROR`, not `TARGET_NOT_FOUND`.

- [ ] **Step 2: Write failing CLI exact-version tests**

```ts
it('ignores request-body dsl because the cli accepts only a version id', async () => {
  const result = await runReplayFlowVersionCli(['--flow-version-id', version.id, '--quality-case-id', qualityCase.id, '--workflow-task-id', 'task-1', '--wda-url', server.url, '--device-udid', 'udid-1', '--output', output]);
  expect(result.exitCode).toBe(0);
  expect(readResult(output)).toMatchObject({ flowVersionId: version.id, resultCategory: 'passed' });
});
```

- [ ] **Step 3: Run adapter/CLI tests and verify the red state**

Run: `cd backend && npm test -- WdaReplayRuntimeAdapter.test.ts runReplayFlowVersion.test.ts --runInBand`

Expected: FAIL because adapter and CLI do not exist.

- [ ] **Step 4: Implement WDA adapter with bounded fetches**

Use Node 20 `fetch` plus `AbortSignal.timeout(15000)`. Resolve/create the WDA session once, cache its ID, report `{ phase: 'connected', device }`, and implement the existing `DeviceReplayRuntimeAdapter` interface. The adapter must not implement additional action types beyond Tap, Swipe, Input, Keyboard, Source, Screenshot, and snapshot source lookup.

- [ ] **Step 5: Implement CLI load/execute/persist flow**

The CLI validates required args, loads the quality case and immutable version from SQLite, verifies their IDs match, resolves runtime inputs through `ReplayFlowAccountResolver` in memory, starts the replay engine with `{ runKind: 'quality', assetId, flowVersionId, workflowTaskId }`, waits for completion, classifies it, writes a backward-readable `business-flow-report.v2` atomically, and updates workflow task/case-run rows. The report retains the existing summary fields (`status`, `message`, step counts, `steps`, `issues`, `riskPolicy`, `stopOnFailure`, `targetDomains`) and adds exact version/case/run/category/evidence fields so current report readers continue working. Install `SIGINT`/`SIGTERM` handlers that stop the run and record `RUNNER_INTERRUPTED` as `infra_failed` unless a user cancellation flag is present.

Exit codes are `0=passed`, `10=failed`, `20=infra_failed`, `30=cancelled`, `40=invalid configuration`.

- [ ] **Step 6: Verify no secret persistence**

After a CLI test with an account password in the in-memory resolver, recursively scan `run.json`, SQLite `config_json/result_json`, CLI result JSON, and logs. Assert the secret string is absent while `inputNames` remain present.

- [ ] **Step 7: Run runner and replay-engine regressions**

Run: `cd backend && npm test -- WdaReplayRuntimeAdapter.test.ts runReplayFlowVersion.test.ts DeviceReplayFlowExecutionService.test.ts DeviceReplayFlowQualityService.test.ts --runInBand && npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the formal runner**

```bash
git add backend/src/services/WdaReplayRuntimeAdapter.ts backend/src/services/WdaReplayRuntimeAdapter.test.ts backend/src/cli/runReplayFlowVersion.ts backend/src/cli/runReplayFlowVersion.test.ts backend/package.json backend/src/services/DeviceReplayFlowExecutionService.ts
git commit -m "feat: run published replay flows for quality"
```

### Task 6: Jenkins trigger, report, and gate integration

**Files:**
- Modify: `backend/src/routes/quality.routes.ts`
- Modify: `backend/src/routes/jenkins.routes.ts`
- Create: `backend/src/routes/quality.routes.test.ts`
- Modify: `scripts/jenkins/nn-auto-quality-config.xml`
- Modify: `scripts/sonic/ios-quality.sh`
- Modify: `backend/src/services/QualityGateService.ts`
- Modify: `backend/src/services/WorkflowService.test.ts`

**Interfaces:**
- Consumes: Task 5 CLI/result and existing Jenkins quality job.
- Produces Jenkins parameters `FLOW_VERSION_ID`, `FLOW_QUALITY_CASE_ID`, `FLOW_VERSION_SHA256`; workflow task config/result contains exact identifiers and report/evidence URLs.

- [ ] **Step 1: Write failing formal-task validation tests**

```ts
it('requires flowVersionId for business_flow', async () => {
  const response = await request(app).post('/api/quality/tasks').send({ task_type: 'ios_business_flow', app: { build: '100' } });
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({ success: false, code: 'FLOW_VERSION_REQUIRED' });
});

it('rejects an inline business flow plan override', async () => {
  const response = await request(app).post('/api/quality/tasks').send({ task_type: 'ios_business_flow', flowVersionId: version.id, businessFlowPlan: { steps: [] }, app: { build: '100' } });
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('FLOW_DSL_OVERRIDE_FORBIDDEN');
});
```

- [ ] **Step 2: Run route tests and verify the red state**

Run: `cd backend && npm test -- quality.routes.test.ts --runInBand`

Expected: FAIL because current routes accept arbitrary business plans and return 502 for validation.

- [ ] **Step 3: Enforce exact version/case binding in both trigger routes**

For `business_flow`, require `flowVersionId` and `qualityCaseId`, load both from SQLite, ensure the case points at that version, and reject `businessFlowPlan`, `business_flow_plan`, or `businessFlow`. Store only identifiers and non-secret mappings in workflow task config. Pass the three new Jenkins parameters; set legacy `BUSINESS_FLOW_PLAN_JSON` to empty for formal tasks.

Keep old task/history reads working. A historical task containing only `businessFlowPlan` is labeled `executionSource: 'legacy_business_flow'`; no new UI call creates one.

- [ ] **Step 4: Add Jenkins parameters and delegate formal runs**

Add string parameters to the job XML. In `run_business_flow_test`, when `FLOW_VERSION_ID` is non-empty, call:

```bash
(cd "${PLATFORM_ROOT_DIR}/backend" && npm run quality:flow-version -- \
  --flow-version-id "${FLOW_VERSION_ID}" \
  --quality-case-id "${FLOW_QUALITY_CASE_ID}" \
  --workflow-task-id "${PLATFORM_TASK_ID}" \
  --wda-url "${MONKEY_RUNTIME_WDA_URL}" \
  --device-udid "${DEVICE_UDID}" \
  --output "${BUSINESS_FLOW_REPORT_FILE}")
```

Capture exit code without losing the result file. Keep the legacy Python feature-plan path only when reading a pre-change task with no `FLOW_VERSION_ID`; prefix its report with `executionSource: legacy_business_flow`.

- [ ] **Step 5: Normalize workflow result fields**

On quality sync, persist `resultCategory`, `flowVersionId`, `qualityCaseId`, `durationMs`, `reportUrl`, and `evidenceUrl`. Map terminal workflow status as: passed → `passed`, failed → `failed`, infra_failed → `failed` plus `result.resultCategory='infra_failed'`, cancelled → `canceled`. The category, not the generic status alone, drives gates.

- [ ] **Step 6: Add explicit gate policy for infrastructure failures**

Extend `GatePolicy` with `infraFailurePolicy: 'block' | 'warn' | 'ignore'`, default `block`. For required-suite latest task with `result.resultCategory === 'infra_failed'`, add `suite_infra_failed` to blockers/warnings/passed according to policy. Product `failed` always blocks. Add tests for all three policy values and include policy/resultCategory in gate signature hashing.

- [ ] **Step 7: Run backend, shell syntax, and job-config checks**

Run: `cd backend && npm test -- quality.routes.test.ts WorkflowService.test.ts DeviceReplayFlowQualityService.test.ts --runInBand && npm run typecheck`

Run: `zsh -n scripts/sonic/ios-quality.sh`

Run: `python3 -c "import xml.etree.ElementTree as ET; ET.parse('scripts/jenkins/nn-auto-quality-config.xml')"`

Expected: all commands exit 0; generated Jenkins parameters never contain serialized DSL.

- [ ] **Step 8: Commit Jenkins and gate integration**

```bash
git add backend/src/routes/quality.routes.ts backend/src/routes/jenkins.routes.ts backend/src/routes/quality.routes.test.ts scripts/jenkins/nn-auto-quality-config.xml scripts/sonic/ios-quality.sh backend/src/services/QualityGateService.ts backend/src/services/WorkflowService.test.ts
git commit -m "feat: gate quality runs by replay flow version"
```

### Task 7: P0 case and published-version quality UI

**Files:**
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/components/ReplayFlowQualityCasePanel.tsx`
- Create: `frontend/src/components/ReplayFlowQualityCasePanel.test.tsx`
- Modify: `frontend/src/pages/CICDPage.tsx`
- Create: `frontend/src/pages/CICDPage.quality-flow.test.tsx`

**Interfaces:**
- Consumes: P0 case CRUD/list API and formal quality trigger from Tasks 4 and 6.
- Produces: user-facing P0 case selector and `flowVersionId + qualityCaseId` quality request; no `businessFlowPlan` field.

- [ ] **Step 1: Add P0 case HTTP routes before UI work**

In `deviceControl.routes.ts` expose:

- `POST /replay-flow-quality-cases`
- `PUT /replay-flow-quality-cases/:caseId`
- `GET /replay-flow-quality-cases?projectId=nn-ios&enabled=true`
- `GET /replay-flow-quality-cases/:caseId`

Tester/developer/admin may create/update; version existence and secret checks remain in the service. Add route tests asserting inline password rejection.

- [ ] **Step 2: Write failing quality UI tests**

```tsx
it('submits the selected p0 case and exact published version', async () => {
  renderQualityModal({ cases: [p0Case] });
  await userEvent.click(screen.getByLabelText('业务编排'));
  await userEvent.selectOptions(screen.getByLabelText('P0 流程用例'), p0Case.id);
  await userEvent.click(screen.getByRole('button', { name: '开始质检' }));
  expect(jenkinsApi.triggerQuality).toHaveBeenCalledWith(expect.objectContaining({
    testSuite: 'business_flow', qualityCaseId: p0Case.id, flowVersionId: p0Case.flowVersionId,
  }));
  expect(jenkinsApi.triggerQuality.mock.calls[0][0]).not.toHaveProperty('businessFlowPlan');
});
```

- [ ] **Step 3: Run UI tests and verify the red state**

Run: `cd frontend && npm test -- ReplayFlowQualityCasePanel.test.tsx CICDPage.quality-flow.test.tsx`

Expected: FAIL because P0 case UI/types do not exist.

- [ ] **Step 4: Build P0 case editor**

The editor selects an immutable version, environment ID, device pool/optional UDID, account references, and input mappings. Sensitive input names only expose account-field mapping controls. Show version number, fingerprint prefix, publisher, and publish time. Save calls the P0 case endpoint; never load secret values into the form.

- [ ] **Step 5: Replace legacy business-feature checkboxes in CICD**

When suite is `business_flow`, load enabled P0 cases and show a required selector. Remove `qualityBusinessFlowFeatures`, `BUSINESS_FLOW_FEATURE_GROUPS` usage from the submission path, and the `businessFlowPlan` payload. Keep legacy report rendering for historical builds and add “历史功能清单执行” badge when `executionSource` is legacy.

- [ ] **Step 6: Display normalized result category and evidence**

Quality task/report UI renders four distinct states. `infra_failed` uses an infrastructure warning style and does not say “产品用例失败”. Link exact version detail, report URL, and evidence URL from the task drawer.

- [ ] **Step 7: Run frontend tests and build**

Run: `cd frontend && npm test -- ReplayFlowQualityCasePanel.test.tsx CICDPage.quality-flow.test.tsx ReplayFlowVersionHistory.test.tsx && npm run build`

Expected: PASS; `rg -n "businessFlowPlan:" frontend/src/pages/CICDPage.tsx` returns no formal submission payload.

- [ ] **Step 8: Commit formal quality UI**

```bash
git add frontend/src/services/api.ts frontend/src/components/ReplayFlowQualityCasePanel.tsx frontend/src/components/ReplayFlowQualityCasePanel.test.tsx frontend/src/pages/CICDPage.tsx frontend/src/pages/CICDPage.quality-flow.test.tsx backend/src/routes/deviceControl.routes.ts backend/src/routes/deviceControl.routes.test.ts
git commit -m "feat: select published p0 flows for quality"
```

### Task 8: Audit, legacy migration, and end-to-end acceptance

**Files:**
- Modify: `backend/src/services/DeviceReplayFlowExecutionService.ts`
- Modify: `backend/src/services/DeviceReplayFlowExecutionService.test.ts`
- Modify: `backend/src/services/DeviceReplayFlowAssetService.ts`
- Modify: `backend/src/services/DeviceReplayFlowVersionService.ts`
- Modify: `backend/src/services/DeviceReplayFlowQualityService.ts`
- Modify: `backend/src/database/init.ts`
- Modify: `backend/src/routes/deviceControl.routes.ts`
- Modify: `backend/src/routes/deviceControl.routes.test.ts`
- Create: `backend/src/services/DeviceReplayFlowMigration.test.ts`
- Create: `docs/superpowers/verification/2026-09-01-versioned-quality-flow-assets.md`
- Modify: `docs/INDEX.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: complete BRR-015..019 audit/migration proof and explicit BRR-020 boundary documentation.

- [ ] **Step 1: Write failing legacy-run and audit redaction tests**

```ts
it('labels an old run json as legacy without inventing a version', () => {
  writeOldRunJson({ id: 'old-run', status: 'succeeded', nodes: [] });
  expect(service.getRun('old-run', 'tester', false)).toMatchObject({ runKind: 'legacy' });
  expect(service.getRun('old-run', 'tester', false).flowVersionId).toBeUndefined();
});

it('audits lifecycle identifiers without runtime values', () => {
  executeLifecycleWithSecret('not-for-storage');
  expect(JSON.stringify(readAllFlowAudits())).not.toContain('not-for-storage');
  expect(readAllFlowAudits().map((row) => row.action)).toEqual(expect.arrayContaining([
    'asset.created', 'draft.saved', 'flow.published', 'flow.rollback_draft_created', 'draft.debug_run', 'flow.quality_run', 'flow.deleted',
  ]));
});
```

- [ ] **Step 2: Run migration tests and verify the red state**

Run: `cd backend && npm test -- DeviceReplayFlowMigration.test.ts --runInBand`

Expected: FAIL until legacy defaults and complete audits are implemented.

- [ ] **Step 3: Add admin-only recoverable flow deletion**

Add `DeviceReplayFlowAssetService.deleteAsset(assetId, actor, isAdmin)` and `DELETE /api/device-control/replay-flow-assets/:assetId`. Require admin; set `deleted_at` and `deleted_by` without deleting draft/version/run/evidence rows. Default asset/draft/version list/read operations return 404 for deleted assets unless `isAdmin && includeDeleted=true`. Insert `flow.deleted` audit in the same transaction. Route tests assert tester/developer 403, admin 204, versions remain in SQLite, and no physical row is removed.

- [ ] **Step 4: Complete audit coverage and redaction**

Audit create, save, publish, copy/rollback, soft deletion, debug run, and quality run. Audit metadata uses allowlisted identifiers, revisions, version numbers, device UDID, task/run IDs, result category, and input names. Recursively remove keys matching `/password|passwd|token|secret|credential|value/i` before serialization.

- [ ] **Step 5: Add idempotent migration and legacy defaults**

Initialize all new tables/indexes without rewriting recordings/evidence. When loading `run.json` without `runKind`, return `runKind: 'legacy'`; do not modify the historical file. If `device_replay_flow_run_bindings` lacks a row, leave draft/version IDs undefined. Run database initialization twice in the migration test.

- [ ] **Step 6: Run the complete automated suite**

Run: `cd backend && npm test -- DeviceReplayFlowVersionService.test.ts DeviceReplayFlowQualityService.test.ts WdaReplayRuntimeAdapter.test.ts runReplayFlowVersion.test.ts quality.routes.test.ts DeviceReplayFlowMigration.test.ts DeviceReplayFlowExecutionService.test.ts WorkflowService.test.ts --runInBand && npm run typecheck`

Run: `cd frontend && npm test -- ReplayFlowPublishModal.test.tsx ReplayFlowVersionHistory.test.tsx ReplayFlowQualityCasePanel.test.tsx CICDPage.quality-flow.test.tsx && npm run build`

Run: `zsh -n scripts/sonic/ios-quality.sh && python3 -c "import xml.etree.ElementTree as ET; ET.parse('scripts/jenkins/nn-auto-quality-config.xml')"`

Expected: all commands exit 0.

- [ ] **Step 7: Perform the unlocked-device end-to-end acceptance**

1. Open a persisted draft and publish version 1 as developer/admin.
2. Edit the draft and verify version 1 detail remains unchanged.
3. Create a P0 case bound to version 1, environment, device pool, account references, and required input mappings.
4. Trigger `business_flow` quality for an App build and verify Jenkins parameters include IDs but no DSL JSON/password.
5. Verify the report links version 1, case ID, replay run ID, duration, result category, and evidence.
6. Force a product assertion failure and verify `failed`.
7. Disconnect/lock the device or stop WDA before execution and verify `infra_failed`.
8. Evaluate gates with `infraFailurePolicy=block`, `warn`, and `ignore` and verify each result.
9. Open a pre-change run and verify `legacy` with original evidence intact.
10. As admin, soft-delete a disposable asset and verify its versions/audits remain recoverable with `includeDeleted=true`.

- [ ] **Step 8: Record evidence and Monkey boundary**

Write build/task/run/version IDs, redacted Jenkins parameters, result categories, gate decisions, and evidence URLs to `docs/superpowers/verification/2026-09-01-versioned-quality-flow-assets.md`. State explicitly that Monkey output still enters only the existing candidate/filter/annotation path and that automated Monkey-to-publish is outside this change. Link the verification file from `docs/INDEX.md`.

- [ ] **Step 9: Commit final verification**

```bash
git add backend/src/services/DeviceReplayFlowExecutionService.ts backend/src/services/DeviceReplayFlowExecutionService.test.ts backend/src/services/DeviceReplayFlowAssetService.ts backend/src/services/DeviceReplayFlowVersionService.ts backend/src/services/DeviceReplayFlowQualityService.ts backend/src/database/init.ts backend/src/routes/deviceControl.routes.ts backend/src/routes/deviceControl.routes.test.ts backend/src/services/DeviceReplayFlowMigration.test.ts docs/superpowers/verification/2026-09-01-versioned-quality-flow-assets.md docs/INDEX.md
git commit -m "docs: verify versioned replay flow quality lifecycle"
```

## Increment C Exit Criteria

- Publishing creates an immutable DSL + compiled-graph snapshot with a monotonic version and complete audit.
- Tester cannot publish or rollback; developer/admin can.
- Copy/rollback creates a new draft revision and never mutates history.
- Every formal P0 request identifies an existing case and `flowVersionId`; arbitrary request-body DSL/business plans are rejected.
- Jenkins resolves and executes that exact version through the shared replay engine.
- Reports and workflow tasks expose exact version, category, duration, and evidence URL.
- Product and infrastructure failures are distinct and release-gate policy handles `infra_failed` explicitly.
- Historical recordings/runs/evidence remain readable and unbound runs are labeled `legacy`.
- Flow deletion is admin-only and recoverable: it hides the asset without removing immutable versions, runs, evidence, or audit history.
- No secret runtime value appears in version, draft, audit, task config/result, run JSON, CLI output, or logs.
- Monkey remains exploratory and cannot automatically publish or satisfy the deterministic P0 gate.
