# Recording Source and Persistent Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace implicit “latest recording” orchestration with explicit source confirmation and a persistent, revisioned replay-flow draft that survives page and backend restarts.

**Architecture:** Recording evidence remains immutable input. A dedicated source module canonicalizes selected replayable steps and computes a SHA-256 fingerprint; a SQLite-backed asset service owns flow assets and their single editable draft. The device-control routes expose preview/create/read/save/reset operations, while the React console confirms the recording source and edits the persisted draft with debounced optimistic-lock saves.

**Tech Stack:** TypeScript 5.3, Node.js, Express 4, SQLite via `better-sqlite3`, Jest/ts-jest, React 18, Ant Design 5, Axios, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-01-ios-black-box-recording-orchestration-design.md`; OpenSpec delta: `openspec/changes/formalize-recording-orchestration/specs/ios-black-box-recording-replay/spec.md` (BRR-012, BRR-013).

## Global Constraints

- The tested iOS App remains a black box; do not add an App SDK, probe, or business instrumentation.
- DSL v1 is the only semantic source of truth; do not persist a second edge model for the canvas.
- Orchestration MUST NOT silently select the latest recording; creation requires an explicit recording confirmation.
- `sourceFingerprint` is SHA-256 over canonical JSON containing the recording ID and ordered `ready && included` steps; it excludes screenshot/source binary contents.
- Draft saves use a monotonically increasing integer `revision`; stale `expectedRevision` returns HTTP 409 with code `FLOW_DRAFT_CONFLICT`.
- Autosave is debounced by exactly 1000 ms and closing the designer flushes pending changes before dismissing it.
- Existing recording/template/replay endpoints remain available during migration, but new orchestration UI uses draft endpoints only.
- Persist actor and timestamp for create, save, reset, and debug actions; never persist runtime secret values.

---

## File Structure

- `backend/src/services/DeviceReplayFlowSource.ts`: canonical selected-step projection, stable JSON, SHA-256 fingerprint, and preview assembly.
- `backend/src/services/DeviceReplayFlowAssetService.ts`: flow asset/draft persistence, ownership checks, revision locking, reset, and audit events.
- `backend/src/services/DeviceReplayFlowAssetService.test.ts`: temporary-SQLite unit coverage for create, reopen, conflict, and reset.
- `backend/src/services/DeviceReplayFlowSource.test.ts`: fingerprint determinism and selected-step sensitivity.
- `backend/src/routes/deviceControl.routes.ts`: authenticated preview and draft HTTP endpoints plus structured errors.
- `backend/src/routes/deviceControl.routes.test.ts`: route contract tests with mocked recording/device dependencies.
- `backend/src/database/schema.sql`: durable flow asset, draft, version, run-binding, and audit tables used by all three implementation plans.
- `backend/src/database/init.ts`: idempotent index/column migration checks for existing local databases.
- `frontend/src/services/api.ts`: source-preview, asset, draft, save-conflict, and draft-run contracts.
- `frontend/src/components/RecordingSourceConfirmModal.tsx`: source identity/step confirmation before draft creation.
- `frontend/src/components/ReplayFlowDesigner.tsx`: load/save a draft instead of regenerating a template.
- `frontend/src/hooks/useReplayFlowDraft.ts`: draft state, 1000 ms autosave, flush, and conflict handling.
- `frontend/src/pages/DeviceConsolePage.tsx`: explicit orchestration entry and modal/designer state.
- `frontend/src/components/RecordingSourceConfirmModal.test.tsx`: confirmation and disabled-state tests.
- `frontend/src/hooks/useReplayFlowDraft.test.tsx`: debounce, flush, and 409 conflict tests.

### Task 1: Canonical recording source fingerprint

**Files:**
- Create: `backend/src/services/DeviceReplayFlowSource.ts`
- Create: `backend/src/services/DeviceReplayFlowSource.test.ts`
- Read: `backend/src/services/DeviceRecordingService.ts`
- Read: `backend/src/services/DeviceReplayFlow.ts`

**Interfaces:**
- Consumes: `DeviceRecording`, `RecordingStep`, `replayFlowTemplateFromRecording(recording, false)`, and `validateDeviceReplayFlow(flow)`.
- Produces:

```ts
export interface ReplayFlowSourceStep {
  id: string;
  index: number;
  type: 'tap' | 'swipe' | 'input';
  summary: string;
  action: Record<string, unknown>;
}

export interface ReplayFlowSourcePreview {
  recording: {
    id: string;
    title: string;
    owner: string;
    deviceUdid?: string;
    createdAt: string;
    stoppedAt?: string;
  };
  selectedSteps: ReplayFlowSourceStep[];
  sourceFingerprint: string;
  flow: DeviceReplayFlowDsl;
  validation: ReplayFlowValidationResult;
}

export class ReplayFlowSourceError extends Error {
  constructor(public code: 'RECORDING_HAS_NO_SELECTED_STEPS', message: string, public statusCode = 409);
}

export function canonicalReplayFlowSource(recording: DeviceRecording): ReplayFlowSourceStep[];
export function replayFlowSourceFingerprint(recording: DeviceRecording): string;
export function replayFlowSourcePreview(recording: DeviceRecording): ReplayFlowSourcePreview;
```

- [ ] **Step 1: Write failing fingerprint tests**

```ts
it('keeps the fingerprint stable when evidence file paths change', () => {
  const first = recordingFixture({ screenshotPath: '/tmp/a.png' });
  const second = recordingFixture({ screenshotPath: '/tmp/b.png' });
  expect(replayFlowSourceFingerprint(first)).toBe(replayFlowSourceFingerprint(second));
});

it('changes the fingerprint when selected replay input changes', () => {
  const first = recordingFixture({ tapX: 0.25 });
  const second = recordingFixture({ tapX: 0.26 });
  expect(replayFlowSourceFingerprint(first)).not.toBe(replayFlowSourceFingerprint(second));
});

it('changes the fingerprint for a different recording id with identical steps', () => {
  const first = recordingFixture({ id: 'recording-a' });
  const second = recordingFixture({ id: 'recording-b' });
  expect(replayFlowSourceFingerprint(first)).not.toBe(replayFlowSourceFingerprint(second));
});

it('excludes unselected and non-ready steps', () => {
  const recording = recordingFixtureWithNoise();
  expect(canonicalReplayFlowSource(recording).map((step) => step.id)).toEqual(['step-ready-selected']);
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run: `cd backend && npm test -- DeviceReplayFlowSource.test.ts --runInBand`

Expected: FAIL because `DeviceReplayFlowSource` and its exports do not exist.

- [ ] **Step 3: Implement canonical projection and SHA-256**

```ts
import { createHash } from 'crypto';

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableObject(item)]));
}

export function replayFlowSourceFingerprint(recording: DeviceRecording) {
  const canonical = {
    recordingId: recording.id,
    selectedSteps: canonicalReplayFlowSource(recording),
  };
  return createHash('sha256').update(JSON.stringify(stableObject(canonical))).digest('hex');
}
```

Throw `RECORDING_HAS_NO_SELECTED_STEPS` when the selected-step array is empty. The canonical payload includes the recording ID plus replay semantics (`id`, stable order/index, type, summary, action parameters and semantic target) and excludes evidence URLs, local file paths, capture timestamps, selection UI metadata, and screenshot/source bytes.

- [ ] **Step 4: Assemble preview from the existing template generator**

```ts
export function replayFlowSourcePreview(recording: DeviceRecording): ReplayFlowSourcePreview {
  const flow = replayFlowTemplateFromRecording(recording, false);
  return {
    recording: recordingIdentity(recording),
    selectedSteps: canonicalReplayFlowSource(recording),
    sourceFingerprint: replayFlowSourceFingerprint(recording),
    flow,
    validation: validateDeviceReplayFlow(flow),
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd backend && npm test -- DeviceReplayFlowSource.test.ts DeviceReplayFlow.test.ts --runInBand && npm run typecheck`

Expected: both suites PASS and TypeScript exits 0.

- [ ] **Step 6: Commit the source boundary**

```bash
git add backend/src/services/DeviceReplayFlowSource.ts backend/src/services/DeviceReplayFlowSource.test.ts
git commit -m "feat: fingerprint replay flow recording sources"
```

### Task 2: SQLite flow asset and draft persistence

**Files:**
- Modify: `backend/src/database/schema.sql`
- Modify: `backend/src/database/init.ts`
- Create: `backend/src/services/DeviceReplayFlowAssetService.ts`
- Create: `backend/src/services/DeviceReplayFlowAssetService.test.ts`

**Interfaces:**
- Consumes: `replayFlowSourcePreview(recording)`, `validateDeviceReplayFlow(flow)`, `compileDeviceReplayFlow(flow)`, `getDatabase()`.
- Produces:

```ts
export type ReplayFlowAuditAction = 'asset.created' | 'draft.saved' | 'draft.reset' | 'draft.debug_run';

export interface ReplayFlowAsset {
  id: string;
  projectId: string;
  name: string;
  owner: string;
  sourceRecordingId: string;
  currentDraftId: string;
  latestPublishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReplayFlowDraft {
  id: string;
  assetId: string;
  revision: number;
  sourceRecordingId: string;
  sourceFingerprint: string;
  flow: DeviceReplayFlowDsl;
  validation: ReplayFlowValidationResult;
  sourceChanged?: boolean;
  currentSourceFingerprint?: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export class ReplayFlowAssetError extends Error {
  constructor(public code: string, message: string, public statusCode: number, public details?: unknown);
}

export class DeviceReplayFlowAssetService {
  createFromRecording(input: { recording: DeviceRecording; name?: string; projectId?: string; actor: string }): { asset: ReplayFlowAsset; draft: ReplayFlowDraft };
  getAsset(assetId: string, actor: string, isAdmin: boolean): ReplayFlowAsset;
  getDraft(draftId: string, actor: string, isAdmin: boolean): ReplayFlowDraft;
  saveDraft(input: { draftId: string; expectedRevision: number; flow: DeviceReplayFlowDsl; actor: string; isAdmin: boolean }): ReplayFlowDraft;
  resetDraftFromRecording(input: { draftId: string; expectedRevision: number; expectedSourceFingerprint: string; recording: DeviceRecording; actor: string; isAdmin: boolean }): ReplayFlowDraft;
}
```

- [ ] **Step 1: Add failing persistence and conflict tests**

```ts
it('reopens a created draft from sqlite', () => {
  const created = service.createFromRecording({ recording, actor: 'tester' });
  expect(new DeviceReplayFlowAssetService().getDraft(created.draft.id, 'tester', false))
    .toMatchObject({ revision: 1, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it('rejects a stale revision without overwriting the winner', () => {
  const created = service.createFromRecording({ recording, actor: 'tester' });
  service.saveDraft({ draftId: created.draft.id, expectedRevision: 1, flow: renamedFlow('winner'), actor: 'tester', isAdmin: false });
  expect(() => service.saveDraft({ draftId: created.draft.id, expectedRevision: 1, flow: renamedFlow('stale'), actor: 'tester', isAdmin: false }))
    .toThrow(expect.objectContaining({ code: 'FLOW_DRAFT_CONFLICT', statusCode: 409 }));
  expect(service.getDraft(created.draft.id, 'tester', false).flow.name).toBe('winner');
});
```

- [ ] **Step 2: Run the service test and verify it fails**

Run: `cd backend && npm test -- DeviceReplayFlowAssetService.test.ts --runInBand`

Expected: FAIL because the database tables and service are absent.

- [ ] **Step 3: Add the durable tables and indexes**

Add these tables to `schema.sql` with foreign keys and the named indexes:

```sql
CREATE TABLE IF NOT EXISTS device_replay_flow_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'nn-ios',
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  source_recording_id TEXT NOT NULL,
  current_draft_id TEXT,
  latest_published_version INTEGER,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_replay_flow_drafts (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  source_recording_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  dsl_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES device_replay_flow_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_replay_flow_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  source_recording_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  dsl_json TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  release_notes TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE(asset_id, version_number),
  FOREIGN KEY (asset_id) REFERENCES device_replay_flow_assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_replay_flow_run_bindings (
  run_id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK(run_kind IN ('legacy', 'debug', 'quality')),
  asset_id TEXT,
  draft_id TEXT,
  draft_revision INTEGER,
  flow_version_id TEXT,
  workflow_task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_replay_flow_audits (
  id TEXT PRIMARY KEY,
  asset_id TEXT,
  draft_id TEXT,
  flow_version_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
```

Create indexes `idx_replay_flow_assets_owner`, `idx_replay_flow_versions_asset`, `idx_replay_flow_run_bindings_version`, and `idx_replay_flow_audits_asset`. Keep `initializeDatabase()` idempotent by using `CREATE TABLE/INDEX IF NOT EXISTS`; add `PRAGMA table_info` guards only if an already-released table needs a new column.

- [ ] **Step 4: Implement transactions and compare-and-swap save**

```ts
const update = db.prepare(`
  UPDATE device_replay_flow_drafts
  SET revision = revision + 1,
      dsl_json = @dslJson,
      validation_json = @validationJson,
      updated_by = @actor,
      updated_at = @updatedAt
  WHERE id = @draftId AND revision = @expectedRevision
`).run(params);

if (update.changes !== 1) {
  throw new ReplayFlowAssetError('FLOW_DRAFT_CONFLICT', '草稿已被其他修改覆盖，请重新加载后合并', 409, {
    expectedRevision: input.expectedRevision,
    actualRevision: current?.revision,
  });
}
```

Create asset + draft + `asset.created` audit in one SQLite transaction. Validate before save; invalid DSL throws `FLOW_VALIDATION_FAILED` with status 422 and diagnostics. Reset recomputes the source fingerprint and fails with `RECORDING_SOURCE_CHANGED` only when a caller supplies an expected fingerprint that differs.

- [ ] **Step 5: Run persistence tests and database regression tests**

Run: `cd backend && npm test -- DeviceReplayFlowAssetService.test.ts WorkflowService.test.ts --runInBand && npm run typecheck`

Expected: PASS; a second `initializeDatabase()` call leaves all rows intact.

- [ ] **Step 6: Commit the persistence model**

```bash
git add backend/src/database/schema.sql backend/src/database/init.ts backend/src/services/DeviceReplayFlowAssetService.ts backend/src/services/DeviceReplayFlowAssetService.test.ts
git commit -m "feat: persist replay flow assets and drafts"
```

### Task 3: Preview and draft HTTP contracts

**Files:**
- Modify: `backend/src/routes/deviceControl.routes.ts`
- Create: `backend/src/routes/deviceControl.routes.test.ts`
- Modify: `backend/src/index.ts` only if the route test needs an exported Express app factory.

**Interfaces:**
- Consumes: `deviceRecordingService.getRecording`, `replayFlowSourcePreview`, `DeviceReplayFlowAssetService` methods from Tasks 1-2.
- Produces:
  - `GET /api/device-control/recordings/:recordingId/orchestration-preview`
  - `POST /api/device-control/replay-flow-assets`
  - `GET /api/device-control/replay-flow-assets/:assetId`
  - `GET /api/device-control/replay-flow-drafts/:draftId`
  - `PUT /api/device-control/replay-flow-drafts/:draftId`
  - `POST /api/device-control/replay-flow-drafts/:draftId/reset-from-recording`

- [ ] **Step 1: Write failing route contract tests**

```ts
it('requires a recording id when creating an asset', async () => {
  const response = await request(app).post('/api/device-control/replay-flow-assets').send({ name: 'P0 登录' });
  expect(response.status).toBe(422);
  expect(response.body).toMatchObject({ success: false, code: 'RECORDING_SOURCE_REQUIRED' });
});

it('returns structured draft conflicts', async () => {
  const response = await request(app)
    .put(`/api/device-control/replay-flow-drafts/${draft.id}`)
    .send({ expectedRevision: 0, flow: draft.flow });
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({ success: false, code: 'FLOW_DRAFT_CONFLICT' });
});
```

Build the test app with JSON middleware and a deterministic auth stub that supplies `{ username: 'tester', role: 'tester' }`; mock recording lookup instead of starting WDA.

- [ ] **Step 2: Run the route test and verify the red state**

Run: `cd backend && npm test -- deviceControl.routes.test.ts --runInBand`

Expected: FAIL with 404 for the new endpoints.

- [ ] **Step 3: Extend the route wrapper to preserve error codes**

```ts
if (error instanceof ReplayFlowAssetError) {
  res.status(error.statusCode).json({ success: false, code: error.code, error: error.message, details: error.details });
  return;
}
```

Handle `ReplayFlowSourceError` with the same structured `{ code, error }` response contract. Keep the existing `DeviceControlError` behavior for WDA/session failures.

- [ ] **Step 4: Implement request validation and response shapes**

```ts
router.post('/replay-flow-assets', route(async (req, res) => {
  const recordingId = String(req.body?.recordingId || '').trim();
  if (!recordingId) throw new ReplayFlowAssetError('RECORDING_SOURCE_REQUIRED', '请选择录制来源', 422);
  const recording = deviceRecordingService.getRecording(recordingId, actorOf(req), isAdmin(req));
  const result = replayFlowAssetService.createFromRecording({
    recording,
    name: String(req.body?.name || '').trim() || recording.title,
    projectId: String(req.body?.projectId || 'nn-ios'),
    actor: actorOf(req),
  });
  res.status(201).json({ success: true, data: result });
}));
```

`PUT` requires both `expectedRevision: integer >= 1` and `flow`. Reset requires `expectedRevision`, `recordingId`, and `expectedSourceFingerprint`; return 422 for malformed bodies before accessing SQLite.

For `GET /replay-flow-drafts/:draftId`, load its source recording, recompute the current fingerprint, and return `sourceChanged: currentFingerprint !== draft.sourceFingerprint` plus `currentSourceFingerprint`. If historical recording data is unavailable, return `sourceChanged: false` and a non-blocking `SOURCE_RECORDING_UNAVAILABLE` warning; never rewrite the draft while reading it.

- [ ] **Step 5: Run route, service, and type tests**

Run: `cd backend && npm test -- deviceControl.routes.test.ts DeviceReplayFlowAssetService.test.ts --runInBand && npm run typecheck`

Expected: PASS and response bodies contain `code` for all domain errors.

- [ ] **Step 6: Commit the API boundary**

```bash
git add backend/src/routes/deviceControl.routes.ts backend/src/routes/deviceControl.routes.test.ts backend/src/index.ts
git commit -m "feat: expose replay flow draft APIs"
```

### Task 4: Frontend API types and explicit source confirmation

**Files:**
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/components/RecordingSourceConfirmModal.tsx`
- Create: `frontend/src/components/RecordingSourceConfirmModal.test.tsx`
- Modify: `frontend/src/pages/DeviceConsolePage.tsx`

**Interfaces:**
- Consumes: HTTP endpoints from Task 3 and the existing `DeviceRecording` frontend type.
- Produces:

```ts
export interface ReplayFlowSourcePreview { recording: {...}; selectedSteps: ReplayFlowSourceStep[]; sourceFingerprint: string; flow: DeviceReplayFlowDsl; validation: DeviceReplayFlowValidation }
export interface ReplayFlowAsset { id: string; name: string; currentDraftId: string; sourceRecordingId: string; latestPublishedVersion: number | null; ... }
export interface ReplayFlowDraft { id: string; assetId: string; revision: number; sourceFingerprint: string; currentSourceFingerprint?: string; sourceChanged?: boolean; flow: DeviceReplayFlowDsl; validation: DeviceReplayFlowValidation; ... }

deviceControlApi.getOrchestrationPreview(recordingId: string)
deviceControlApi.createReplayFlowAsset(input: { recordingId: string; name: string; projectId?: string })
deviceControlApi.getReplayFlowDraft(draftId: string)
deviceControlApi.saveReplayFlowDraft(draftId: string, expectedRevision: number, flow: DeviceReplayFlowDsl)
deviceControlApi.resetReplayFlowDraft(draftId: string, input: { expectedRevision: number; recordingId: string; expectedSourceFingerprint: string })
```

- [ ] **Step 1: Write failing confirmation modal tests**

```tsx
it('shows recording identity and selected steps before creation', async () => {
  render(<RecordingSourceConfirmModal open recording={recording} onCancel={vi.fn()} onCreated={vi.fn()} />);
  expect(await screen.findByText(recording.id)).toBeInTheDocument();
  expect(screen.getByText('点击取消')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建草稿并进入编排' })).toBeEnabled();
});

it('does not create a draft when no replayable step exists', async () => {
  mockPreview({ selectedSteps: [] });
  render(...);
  expect(await screen.findByRole('button', { name: '创建草稿并进入编排' })).toBeDisabled();
});
```

- [ ] **Step 2: Run the component test and verify the red state**

Run: `cd frontend && npm test -- RecordingSourceConfirmModal.test.tsx`

Expected: FAIL because the component and API methods do not exist.

- [ ] **Step 3: Add typed API methods and error-code propagation**

Preserve backend `code` and `details` in the rejected value so `FLOW_DRAFT_CONFLICT` can be handled without matching Chinese text.

```ts
export interface ApiErrorPayload {
  success: false;
  code?: string;
  error: string;
  details?: unknown;
}
```

- [ ] **Step 4: Build the confirmation modal**

The modal loads preview only when opened, displays title, ID, owner, device, start/stop time, SHA-256 prefix, and the full selected-step list. The primary button calls `createReplayFlowAsset` and returns `{ assetId, draftId }` through `onCreated`. It never calls `latestRecording()`.

- [ ] **Step 5: Replace the direct designer open action**

```tsx
const [sourceConfirmOpen, setSourceConfirmOpen] = useState(false);
const [activeDraftId, setActiveDraftId] = useState('');

<Button onClick={() => setSourceConfirmOpen(true)}>基于本次录制生成编排</Button>
<RecordingSourceConfirmModal
  open={sourceConfirmOpen}
  recording={recording}
  onCancel={() => setSourceConfirmOpen(false)}
  onCreated={({ draftId }) => {
    setSourceConfirmOpen(false);
    setActiveDraftId(draftId);
    setFlowDesignerOpen(true);
  }}
/>
```

`loadCurrentRecording()` may continue loading latest history for display per BRR-005, but no orchestration function may run until this confirmation completes.

- [ ] **Step 6: Run frontend tests and typecheck**

Run: `cd frontend && npm test -- RecordingSourceConfirmModal.test.tsx && npm run typecheck`

Expected: PASS; TypeScript reports no implicit `any` in new API types.

- [ ] **Step 7: Commit the explicit source UX**

```bash
git add frontend/src/services/api.ts frontend/src/components/RecordingSourceConfirmModal.tsx frontend/src/components/RecordingSourceConfirmModal.test.tsx frontend/src/pages/DeviceConsolePage.tsx
git commit -m "feat: confirm recording before orchestration"
```

### Task 5: Draft autosave, flush, and conflict recovery

**Files:**
- Create: `frontend/src/hooks/useReplayFlowDraft.ts`
- Create: `frontend/src/hooks/useReplayFlowDraft.test.tsx`
- Modify: `frontend/src/components/ReplayFlowDesigner.tsx`
- Modify: `frontend/src/pages/DeviceConsolePage.tsx`

**Interfaces:**
- Consumes: `getReplayFlowDraft`, `saveReplayFlowDraft`, and `ReplayFlowDraft` from Task 4.
- Produces:

```ts
export interface ReplayFlowDraftController {
  draft: ReplayFlowDraft | null;
  flow: DeviceReplayFlowDsl | null;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  conflict: { localFlow: DeviceReplayFlowDsl; remote: ReplayFlowDraft } | null;
  setFlow(next: DeviceReplayFlowDsl | ((current: DeviceReplayFlowDsl) => DeviceReplayFlowDsl)): void;
  flush(): Promise<boolean>;
  reloadRemote(): Promise<void>;
  retryAgainstRemote(): Promise<void>;
  resetFromRecording(): Promise<void>;
}

export function useReplayFlowDraft(draftId: string, open: boolean): ReplayFlowDraftController;
```

- [ ] **Step 1: Write failing fake-timer tests**

```tsx
it('saves once after 1000 ms and advances revision from the server response', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useReplayFlowDraft('draft-1', true));
  await waitFor(() => expect(result.current.draft?.revision).toBe(1));
  act(() => result.current.setFlow((flow) => ({ ...flow, name: 'changed' })));
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(api.saveReplayFlowDraft).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(api.saveReplayFlowDraft).toHaveBeenCalledWith('draft-1', 1, expect.objectContaining({ name: 'changed' }));
});

it('flushes a pending edit before close', async () => {
  act(() => result.current.setFlow(changedFlow));
  await act(() => result.current.flush());
  expect(api.saveReplayFlowDraft).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run hook tests and verify the red state**

Run: `cd frontend && npm test -- useReplayFlowDraft.test.tsx`

Expected: FAIL because the hook is absent.

- [ ] **Step 3: Implement a serialized save queue**

Use refs for `revision`, latest `flow`, debounce timer, in-flight promise, and generation number. Never issue parallel saves for the same draft. A successful response replaces local revision; a `FLOW_DRAFT_CONFLICT` fetches the remote draft and stores `{ localFlow, remote }` without overwriting either side.

```ts
const scheduleSave = () => {
  window.clearTimeout(timerRef.current);
  timerRef.current = window.setTimeout(() => void persistLatest(), 1000);
};
```

- [ ] **Step 4: Refactor the designer to accept `draftId`**

Change props to:

```ts
interface ReplayFlowDesignerProps {
  open: boolean;
  draftId: string;
  connected: boolean;
  onClose: () => void;
}
```

Remove `loadTemplate()` and all calls to `replayFlowTemplate(recording.id)`. Derive `flow`, `setFlow`, loading, saving, and conflict state from `useReplayFlowDraft`. Keep canvas positions as a projection of `flow.nodes`; do not persist positions as flow semantics.

- [ ] **Step 5: Add conflict actions and guarded close**

Show an Ant Design `Modal` with:

- “加载服务器版本”: discard local conflict copy and call `reloadRemote()`.
- “以服务器版本为基线重试”: keep the local flow, set expected revision to `remote.revision`, and call `retryAgainstRemote()`.
- “取消”: leave the designer open.

The close handler awaits `flush()` and only invokes `onClose()` when it returns `true`; conflicts keep the drawer open.

When `draft.sourceChanged` is true, show a persistent warning containing the saved and current fingerprint prefixes. “从录制重新生成” opens a destructive confirmation explaining that current edits will be replaced; confirmation calls `resetReplayFlowDraft` with the current revision and `currentSourceFingerprint`. Cancel leaves the DSL untouched. The reset response becomes the new shared flow/revision and clears the source-changed warning.

- [ ] **Step 6: Run hook, component, and build checks**

Run: `cd frontend && npm test -- useReplayFlowDraft.test.tsx RecordingSourceConfirmModal.test.tsx && npm run build`

Expected: PASS; production bundle builds; no call to `replayFlowTemplate` remains in `ReplayFlowDesigner.tsx`.

- [ ] **Step 7: Commit the persistent designer**

```bash
git add frontend/src/hooks/useReplayFlowDraft.ts frontend/src/hooks/useReplayFlowDraft.test.tsx frontend/src/components/ReplayFlowDesigner.tsx frontend/src/pages/DeviceConsolePage.tsx
git commit -m "feat: autosave replay flow drafts"
```

### Task 6: Draft-bound debug execution and Increment A acceptance

**Files:**
- Modify: `backend/src/services/DeviceReplayFlowExecutionService.ts`
- Modify: `backend/src/services/DeviceReplayFlowExecutionService.test.ts`
- Modify: `backend/src/services/DeviceReplayFlowAssetService.ts`
- Modify: `backend/src/routes/deviceControl.routes.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/components/ReplayFlowDesigner.tsx`
- Create: `docs/superpowers/verification/2026-09-01-recording-source-and-drafts.md`

**Interfaces:**
- Consumes: persisted drafts and `device_replay_flow_run_bindings` from Tasks 2-5.
- Produces:
  - `POST /api/device-control/replay-flow-drafts/:draftId/debug-runs` body `{ revision, inputs }`.
  - `ReplayFlowRun` fields `runKind: 'debug'`, `draftId`, `draftRevision`, `assetId`.
  - `DeviceReplayFlowExecutionService.start(flow, inputs, actor, isAdmin, binding?)` where `binding` is `{ runKind: 'legacy' | 'debug' | 'quality'; assetId?: string; draftId?: string; draftRevision?: number; flowVersionId?: string; workflowTaskId?: string }`.

- [ ] **Step 1: Write failing binding tests**

```ts
it('binds a debug run to the exact saved draft revision', async () => {
  const run = service.start(flow, {}, 'tester', false, {
    runKind: 'debug', assetId: 'asset-1', draftId: 'draft-1', draftRevision: 3,
  });
  await service.waitForCompletion(run.id);
  expect(service.getRun(run.id, 'tester', false)).toMatchObject({
    runKind: 'debug', assetId: 'asset-1', draftId: 'draft-1', draftRevision: 3,
  });
});
```

- [ ] **Step 2: Run the execution test and verify it fails**

Run: `cd backend && npm test -- DeviceReplayFlowExecutionService.test.ts --runInBand`

Expected: FAIL because run binding metadata is not accepted or persisted.

- [ ] **Step 3: Persist non-secret run binding metadata**

Extend `run.json` public data with binding IDs and insert the same IDs into `device_replay_flow_run_bindings`. Continue persisting only `inputNames`; do not write `inputs` values to `run.json`, SQLite, logs, or audit metadata.

- [ ] **Step 4: Add draft debug route with revision guard**

Load the draft and require `body.revision === draft.revision`; otherwise return `FLOW_DRAFT_CONFLICT`. Start the saved DSL, not a DSL supplied by the request body. Record `draft.debug_run` audit with run ID, device UDID, draft revision, and input names.

- [ ] **Step 5: Point the designer Run button at the draft route**

Replace `startReplayFlow(flow, inputs)` with `startReplayFlowDraftDebug(draftId, draft.revision, inputs)`. Disable Run while dirty or saving; call `flush()` first, then execute the returned saved revision.

- [ ] **Step 6: Run all Increment A automated checks**

Run: `cd backend && npm test -- DeviceReplayFlowSource.test.ts DeviceReplayFlowAssetService.test.ts deviceControl.routes.test.ts DeviceReplayFlowExecutionService.test.ts --runInBand && npm run typecheck`

Run: `cd frontend && npm test -- RecordingSourceConfirmModal.test.tsx useReplayFlowDraft.test.tsx && npm run build`

Expected: all commands exit 0.

- [ ] **Step 7: Perform the unlocked-device acceptance and record evidence**

Use one stopped recording with at least one selected step:

1. Click “基于本次录制生成编排”.
2. Verify modal identity, selected steps, and fingerprint.
3. Confirm and rename one node.
4. Wait 1 second, close, reopen using the returned asset/draft entry, and verify the edit remains.
5. Start a debug run and verify the run response contains the exact `draftId` and `draftRevision`.
6. Paste request/response IDs and PASS/FAIL observations into `docs/superpowers/verification/2026-09-01-recording-source-and-drafts.md` without credentials or runtime input values.

- [ ] **Step 8: Commit Increment A verification**

```bash
git add backend/src/services/DeviceReplayFlowExecutionService.ts backend/src/services/DeviceReplayFlowExecutionService.test.ts backend/src/services/DeviceReplayFlowAssetService.ts backend/src/routes/deviceControl.routes.ts frontend/src/services/api.ts frontend/src/components/ReplayFlowDesigner.tsx docs/superpowers/verification/2026-09-01-recording-source-and-drafts.md
git commit -m "feat: run persisted replay flow drafts"
```

## Increment A Exit Criteria

- Opening orchestration always shows the recording confirmation modal first.
- The modal identifies the recording and exact selected steps used for the fingerprint.
- A recording with no selected ready steps is rejected as `RECORDING_HAS_NO_SELECTED_STEPS`.
- A created draft survives browser refresh and backend restart.
- Reopening a draft after source selection/annotation changes displays a warning and does not rewrite it; reset requires explicit confirmation and creates a new revision.
- Two saves with the same expected revision produce one success and one `409 FLOW_DRAFT_CONFLICT` without data loss.
- Closing the designer flushes a pending edit.
- Debug execution binds to a saved `draftId + revision` and persists no secret input values.
