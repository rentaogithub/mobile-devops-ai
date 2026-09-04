# Replay Flow Low-code Round-trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe YAML low-code editor that round-trips with the visual replay-flow canvas through one DSL state without semantic loss.

**Architecture:** A backend codec is the authoritative parser/formatter and applies a JSON-compatible YAML subset before the existing DSL validator/compiler. The frontend embeds Monaco with schema completion for authoring, but commits parsed objects only through the backend codec; canvas and code modes both update the same draft controller from Increment A. Structures the canvas cannot edit remain visible and executable as low-code-only nodes rather than being rewritten.

**Tech Stack:** TypeScript 5.3, Express 4, existing replay-flow JSON Schema/compiler, backend `yaml`, Jest, React 18, Monaco Editor, `@monaco-editor/react`, `monaco-yaml`, Vitest, Testing Library, Vite 8.

**Spec:** `docs/superpowers/specs/2026-09-01-ios-black-box-recording-orchestration-design.md`; OpenSpec delta: `openspec/changes/formalize-recording-orchestration/specs/ios-black-box-recording-replay/spec.md` (BRR-014).

## Global Constraints

- DSL v1 remains the only source of truth for the sequence view, canvas, low-code editor, validation, and execution.
- YAML accepts only a JSON-compatible safe subset: no custom tags, anchors, aliases, merge keys, executable expressions, or environment interpolation.
- `${NAME}` is treated as inert DSL text and is resolved only by the existing bounded runtime input mechanism.
- A code edit updates the draft only after parse success and existing JSON Schema/static validation success.
- Parse failure preserves the exact user text, reports line/column diagnostics, and MUST NOT overwrite the last valid DSL.
- Switching away from code mode is blocked while the text is invalid.
- Formatting uses a stable field order and LF line endings so repeated formatting produces byte-identical output.
- Canvas-inexpressible but valid DSL must remain byte/semantic equivalent after visual inspection; it is rendered as low-code-only, not deleted or simplified.
- Do not add JavaScript, Python, Shell, template evaluation, unbounded loops, or plugin execution to the DSL.

---

## File Structure

- `backend/src/services/DeviceReplayFlowCodec.ts`: YAML AST security checks, parse diagnostics, canonical object ordering, and stable formatting.
- `backend/src/services/DeviceReplayFlowCodec.test.ts`: rejection, line/column, idempotence, and compiled-graph equivalence tests.
- `backend/src/routes/deviceControl.routes.ts`: authenticated parse/format endpoints.
- `backend/package.json` and `backend/package-lock.json`: pinned `yaml` runtime dependency.
- `frontend/src/components/ReplayFlowCodeEditor.tsx`: Monaco YAML editor, schema completion, diagnostics, parse/format actions.
- `frontend/src/components/ReplayFlowCodeEditor.test.tsx`: UI state and invalid-text preservation tests with Monaco mocked.
- `frontend/src/components/replayFlowMonaco.ts`: one-time Monaco/YAML language worker and schema configuration.
- `frontend/src/components/ReplayFlowDesigner.tsx`: canvas/code mode switch on the same flow state.
- `frontend/src/components/ReplayFlowDesigner.css`: split layout, diagnostics, and low-code-only badge styles.
- `frontend/src/services/api.ts`: codec contracts and JSON Schema retrieval typing.
- `frontend/package.json` and `frontend/package-lock.json`: pinned Monaco/YAML dependencies.

### Task 1: Safe YAML codec dependency and parser

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`
- Create: `backend/src/services/DeviceReplayFlowCodec.ts`
- Create: `backend/src/services/DeviceReplayFlowCodec.test.ts`

**Interfaces:**
- Consumes: `DeviceReplayFlowDsl`, `ReplayFlowDiagnostic`, `validateDeviceReplayFlow`, and `compileDeviceReplayFlow` from `DeviceReplayFlow.ts`.
- Produces:

```ts
export interface ReplayFlowCodecDiagnostic extends ReplayFlowDiagnostic {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ReplayFlowYamlParseResult {
  valid: boolean;
  flow: DeviceReplayFlowDsl | null;
  diagnostics: ReplayFlowCodecDiagnostic[];
  compiled: CompiledDeviceReplayFlow | null;
}

export function parseReplayFlowYaml(text: string): ReplayFlowYamlParseResult;
export function formatReplayFlowYaml(flow: DeviceReplayFlowDsl): string;
```

- [ ] **Step 1: Install the backend YAML parser**

Run: `cd backend && npm install yaml`

Expected: `yaml` appears in `dependencies`, the lockfile changes, and `npm ls yaml` exits 0.

- [ ] **Step 2: Write failing security and diagnostic tests**

```ts
it.each([
  ['anchor', 'schemaVersion: "1.0"\nname: &name flow\nid: flow\nnodes: []'],
  ['alias', 'schemaVersion: "1.0"\nname: &name flow\nid: flow\ndescription: *name\nnodes: []'],
  ['merge key', 'base: &base { timeoutMs: 1000 }\nnode: { <<: *base }'],
  ['custom tag', 'schemaVersion: !env FLOW_SCHEMA'],
])('rejects %s syntax', (_kind, text) => {
  const result = parseReplayFlowYaml(text);
  expect(result.valid).toBe(false);
  expect(result.diagnostics[0]).toMatchObject({ code: 'FLOW_DSL_PARSE_ERROR', line: expect.any(Number), column: expect.any(Number) });
});

it('returns line and column for malformed YAML', () => {
  const result = parseReplayFlowYaml('schemaVersion: "1.0"\nnodes:\n  - id: [');
  expect(result.diagnostics[0]).toMatchObject({ code: 'FLOW_DSL_PARSE_ERROR', line: 3, column: expect.any(Number) });
});
```

- [ ] **Step 3: Run the codec test and verify the red state**

Run: `cd backend && npm test -- DeviceReplayFlowCodec.test.ts --runInBand`

Expected: FAIL because the codec module is missing.

- [ ] **Step 4: Parse a JSON-compatible YAML document and inspect its AST**

Use `parseDocument(text, { schema: 'json', uniqueKeys: true, maxAliasCount: 0, prettyErrors: true })`. Walk the document with `visit` and emit `FLOW_DSL_PARSE_ERROR` with `details.reason = 'unsafe_yaml_feature'` when a node is an alias, has a non-empty `anchor`, uses merge key `<<`, or has a tag outside the JSON scalar/container tags. Convert with `document.toJS({ maxAliasCount: 0 })` only after the AST passes.

```ts
const validation = validateDeviceReplayFlow(value);
if (!validation.valid) {
  return { valid: false, flow: null, diagnostics: validation.errors, compiled: null };
}
return { valid: true, flow: value, diagnostics: validation.warnings, compiled: compileDeviceReplayFlow(value) };
```

- [ ] **Step 5: Run security tests and typecheck**

Run: `cd backend && npm test -- DeviceReplayFlowCodec.test.ts --runInBand && npm run typecheck`

Expected: PASS; unsafe YAML never reaches `toJS` or compilation.

- [ ] **Step 6: Commit the parser boundary**

```bash
git add backend/package.json backend/package-lock.json backend/src/services/DeviceReplayFlowCodec.ts backend/src/services/DeviceReplayFlowCodec.test.ts
git commit -m "feat: parse replay flow yaml safely"
```

### Task 2: Canonical formatter and semantic round-trip

**Files:**
- Modify: `backend/src/services/DeviceReplayFlowCodec.ts`
- Modify: `backend/src/services/DeviceReplayFlowCodec.test.ts`
- Read: `backend/src/services/DeviceReplayFlow.ts`

**Interfaces:**
- Consumes: safe parser from Task 1 and compiled graph shape from `compileDeviceReplayFlow`.
- Produces: stable `formatReplayFlowYaml(flow)` and the canonical key-order constants used only by the codec.

- [ ] **Step 1: Write failing idempotence and compiled-equivalence tests**

```ts
it('formats byte-identically on repeated passes', () => {
  const once = formatReplayFlowYaml(branchingFlowFixture());
  const parsed = parseReplayFlowYaml(once);
  const twice = formatReplayFlowYaml(parsed.flow!);
  expect(twice).toBe(once);
  expect(once.endsWith('\n')).toBe(true);
  expect(once).not.toContain('\r');
});

it('preserves the compiled graph after yaml round trip', () => {
  const original = branchingFlowFixture();
  const parsed = parseReplayFlowYaml(formatReplayFlowYaml(original));
  expect(parsed.compiled).toEqual(compileDeviceReplayFlow(original));
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `cd backend && npm test -- DeviceReplayFlowCodec.test.ts --runInBand`

Expected: FAIL because formatter output/key ordering is not implemented.

- [ ] **Step 3: Implement explicit stable key order**

Use these orders before alphabetically appending unknown schema-compatible keys:

```ts
const ROOT_KEYS = ['schemaVersion', 'id', 'name', 'description', 'source', 'inputs', 'nodes'];
const NODE_KEYS = ['id', 'type', 'name', 'description', 'timeoutMs', 'retry', 'evidence', 'precondition', 'target', 'value', 'key', 'start', 'end', 'durationMs', 'startTarget', 'endTarget', 'condition', 'next', 'onFailure', 'onSuccess', 'onTimeout', 'onError', 'onTrue', 'onFalse', 'onPassed', 'onFailed', 'result', 'message'];
const TARGET_KEYS = ['accessibilityId', 'name', 'label', 'text', 'placeholder', 'type', 'contextLabels', 'coordinate', 'relativePoint'];
```

Format with `stringify(canonicalFlow, { schema: 'json', aliasDuplicateObjects: false, lineWidth: 0, indent: 2 })`, normalize to LF, and force exactly one trailing newline.

- [ ] **Step 4: Add fixtures covering every node and condition type**

The test fixture must include Start, Tap, Swipe, Input, Keyboard, Wait, Condition, Assertion, success End, failure End, `all`, `any`, `not`, element, text, keyboard, app, delay, page-stable, and snapshot-similarity conditions. Compare compiled objects, not YAML text alone.

- [ ] **Step 5: Run codec and existing DSL tests**

Run: `cd backend && npm test -- DeviceReplayFlowCodec.test.ts DeviceReplayFlow.test.ts --runInBand`

Expected: PASS and two formatting passes are byte-identical.

- [ ] **Step 6: Commit stable formatting**

```bash
git add backend/src/services/DeviceReplayFlowCodec.ts backend/src/services/DeviceReplayFlowCodec.test.ts
git commit -m "feat: format replay flow yaml canonically"
```

### Task 3: Authenticated parse and format endpoints

**Files:**
- Modify: `backend/src/routes/deviceControl.routes.ts`
- Modify: `backend/src/routes/deviceControl.routes.test.ts`

**Interfaces:**
- Consumes: `parseReplayFlowYaml(text)` and `formatReplayFlowYaml(flow)` from Tasks 1-2.
- Produces:
  - `POST /api/device-control/replay-flows/codec/parse` body `{ text }`.
  - `POST /api/device-control/replay-flows/codec/format` body `{ flow }`.

- [ ] **Step 1: Write failing endpoint tests**

```ts
it('does not return a flow when yaml is invalid', async () => {
  const response = await request(app).post('/api/device-control/replay-flows/codec/parse').send({ text: 'nodes: [' });
  expect(response.status).toBe(422);
  expect(response.body).toMatchObject({
    success: false,
    code: 'FLOW_DSL_PARSE_ERROR',
    details: { diagnostics: [expect.objectContaining({ line: 1, column: expect.any(Number) })] },
  });
});

it('returns canonical yaml for a valid flow', async () => {
  const response = await request(app).post('/api/device-control/replay-flows/codec/format').send({ flow });
  expect(response.status).toBe(200);
  expect(response.body.data.text).toContain('schemaVersion: "1.0"');
});
```

- [ ] **Step 2: Run the route test and verify 404 failures**

Run: `cd backend && npm test -- deviceControl.routes.test.ts --runInBand`

Expected: FAIL because codec endpoints are absent.

- [ ] **Step 3: Implement bounded request handling**

Reject missing/non-string text and text over 1 MiB with 413 `FLOW_DSL_TOO_LARGE`. For parse diagnostics choose the first error code for the response `code`, return all diagnostics in `details.diagnostics`, and return warnings with a successful flow. Format calls the same validator before emitting text.

- [ ] **Step 4: Run route and codec tests**

Run: `cd backend && npm test -- deviceControl.routes.test.ts DeviceReplayFlowCodec.test.ts --runInBand && npm run typecheck`

Expected: PASS; unsafe input returns 422 and never returns `data.flow`.

- [ ] **Step 5: Commit codec routes**

```bash
git add backend/src/routes/deviceControl.routes.ts backend/src/routes/deviceControl.routes.test.ts
git commit -m "feat: expose replay flow yaml codec"
```

### Task 4: Monaco YAML editor with schema completion

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/components/replayFlowMonaco.ts`
- Create: `frontend/src/components/ReplayFlowCodeEditor.tsx`
- Create: `frontend/src/components/ReplayFlowCodeEditor.test.tsx`
- Modify: `frontend/src/services/api.ts`

**Interfaces:**
- Consumes: codec endpoints from Task 3 and `GET /api/device-control/replay-flows/schema`.
- Produces:

```ts
export interface ReplayFlowCodeEditorProps {
  open: boolean;
  flow: DeviceReplayFlowDsl;
  dirty: boolean;
  onApply(flow: DeviceReplayFlowDsl): void;
  onValidityChange(valid: boolean): void;
}
```

- [ ] **Step 1: Install pinned frontend editor dependencies**

Run: `cd frontend && npm install @monaco-editor/react monaco-editor monaco-yaml`

Expected: all three packages appear in `dependencies`; `npm ls @monaco-editor/react monaco-editor monaco-yaml` exits 0.

- [ ] **Step 2: Write failing editor behavior tests with Monaco mocked**

```tsx
it('preserves invalid text and does not apply it', async () => {
  render(<ReplayFlowCodeEditor open flow={flow} dirty={false} onApply={onApply} onValidityChange={onValidityChange} />);
  await userEvent.clear(screen.getByRole('textbox', { name: '流程 YAML' }));
  await userEvent.type(screen.getByRole('textbox', { name: '流程 YAML' }), 'nodes: [');
  await userEvent.click(screen.getByRole('button', { name: '应用到流程' }));
  expect(onApply).not.toHaveBeenCalled();
  expect(screen.getByText(/第 1 行/)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '流程 YAML' })).toHaveValue('nodes: [');
});

it('applies the backend-parsed flow', async () => {
  mockParseSuccess(changedFlow);
  render(...);
  await userEvent.click(screen.getByRole('button', { name: '应用到流程' }));
  expect(onApply).toHaveBeenCalledWith(changedFlow);
});
```

- [ ] **Step 3: Run the editor test and verify the red state**

Run: `cd frontend && npm test -- ReplayFlowCodeEditor.test.tsx`

Expected: FAIL because the component and API methods are missing.

- [ ] **Step 4: Configure Monaco YAML once**

`replayFlowMonaco.ts` loads the backend JSON Schema and calls `configureMonacoYaml(monaco, { enableSchemaRequest: false, validate: true, completion: true, hover: true, format: true, schemas: [{ uri: 'https://nn-ios-platform.local/schemas/device-replay-flow-v1.json', fileMatch: ['replay-flow.yaml'], schema }] })`. Configure worker URLs through Vite-compatible `new Worker(new URL(...), { type: 'module' })`; do not fetch external schemas.

- [ ] **Step 5: Implement explicit format/apply actions**

When `open` changes from false to true, request canonical YAML for the current flow. Keep editor text local. “格式化” sends the last valid flow or parsed text to the backend formatter. “应用到流程” calls parse; only a successful response invokes `onApply`. Convert backend diagnostics to Monaco markers and an accessible Ant Design list containing line/column.

- [ ] **Step 6: Run tests and production build**

Run: `cd frontend && npm test -- ReplayFlowCodeEditor.test.tsx && npm run build`

Expected: PASS; Vite emits Monaco worker chunks without unresolved worker imports.

- [ ] **Step 7: Commit the low-code editor**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/replayFlowMonaco.ts frontend/src/components/ReplayFlowCodeEditor.tsx frontend/src/components/ReplayFlowCodeEditor.test.tsx frontend/src/services/api.ts
git commit -m "feat: add replay flow yaml editor"
```

### Task 5: Single-state canvas/code switching and low-code-only preservation

**Files:**
- Modify: `frontend/src/components/ReplayFlowDesigner.tsx`
- Modify: `frontend/src/components/ReplayFlowDesigner.css`
- Create: `frontend/src/components/ReplayFlowDesigner.test.tsx`
- Modify: `frontend/src/hooks/useReplayFlowDraft.test.tsx`

**Interfaces:**
- Consumes: `ReplayFlowCodeEditor` from Task 4 and `useReplayFlowDraft` from Increment A.
- Produces:

```ts
type ReplayFlowEditorMode = 'canvas' | 'code';

export function canvasEditCapability(node: DeviceReplayFlowNode): {
  editable: boolean;
  reason?: string;
};
```

- [ ] **Step 1: Write failing mode-switch and preservation tests**

```tsx
it('shows the same changed DSL after code-to-canvas switching', async () => {
  renderDesignerWithDraft(flow);
  await userEvent.click(screen.getByRole('radio', { name: '低代码' }));
  applyCodeFlow({ ...flow, nodes: [...flow.nodes, compositeConditionNode] });
  await userEvent.click(screen.getByRole('radio', { name: '画布' }));
  expect(screen.getByTestId(`flow-node-${compositeConditionNode.id}`)).toHaveTextContent('仅低代码可编辑');
  expect(currentDraftFlow()).toEqual(expect.objectContaining({ nodes: expect.arrayContaining([compositeConditionNode]) }));
});

it('blocks leaving code mode when yaml is invalid', async () => {
  renderDesignerWithInvalidCode();
  await userEvent.click(screen.getByRole('radio', { name: '画布' }));
  expect(screen.getByRole('radio', { name: '低代码' })).toBeChecked();
  expect(screen.getByText('请先修复 YAML 错误')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and verify the red state**

Run: `cd frontend && npm test -- ReplayFlowDesigner.test.tsx`

Expected: FAIL because mode switching and capability badges do not exist.

- [ ] **Step 3: Add mode switching without a second flow store**

Keep exactly one `flow` from `useReplayFlowDraft`. The code editor receives that flow and calls the same `setFlow` used by canvas node edits. `ReplayFlowCodeEditor` owns only uncommitted text; it does not own a second accepted DSL.

- [ ] **Step 4: Define the canvas editing boundary**

Mark a node low-code-only when its editable property panel cannot faithfully round-trip one of its present fields, including nested `all/any/not` conditions deeper than the visual condition editor supports. Continue rendering its card and outgoing DSL-derived connections. Disable destructive property controls for that node and link directly to code mode with the node ID selected.

- [ ] **Step 5: Block invalid transitions and preserve unsaved text**

On an attempted switch from code to canvas, call the editor’s `apply()` handle. If parsing fails, remain in code mode. On success, update the shared flow once, then switch. Switching canvas to code formats the latest shared flow only when there is no preserved invalid buffer.

- [ ] **Step 6: Run frontend regression tests and build**

Run: `cd frontend && npm test -- ReplayFlowDesigner.test.tsx ReplayFlowCodeEditor.test.tsx useReplayFlowDraft.test.tsx && npm run build`

Expected: PASS; a composite condition remains in the saved draft after code → canvas → code.

- [ ] **Step 7: Commit the round-trip UI**

```bash
git add frontend/src/components/ReplayFlowDesigner.tsx frontend/src/components/ReplayFlowDesigner.css frontend/src/components/ReplayFlowDesigner.test.tsx frontend/src/hooks/useReplayFlowDraft.test.tsx
git commit -m "feat: round trip replay flows between canvas and yaml"
```

### Task 6: Increment B semantic acceptance

**Files:**
- Create: `docs/superpowers/verification/2026-09-01-replay-flow-low-code-roundtrip.md`
- Modify: `docs/INDEX.md`

**Interfaces:**
- Consumes: completed codec and UI from Tasks 1-5.
- Produces: checked evidence that BRR-014 is met without changing compiled semantics.

- [ ] **Step 1: Run the complete automated verification**

Run: `cd backend && npm test -- DeviceReplayFlowCodec.test.ts DeviceReplayFlow.test.ts deviceControl.routes.test.ts --runInBand && npm run typecheck`

Run: `cd frontend && npm test -- ReplayFlowCodeEditor.test.tsx ReplayFlowDesigner.test.tsx useReplayFlowDraft.test.tsx && npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Run a byte and semantic round-trip probe**

Use the codec test fixture to save canonical YAML to a temporary test artifact, parse it, reformat it, and assert both SHA-256 text hashes and `compileDeviceReplayFlow` outputs are equal. Keep the probe inside `DeviceReplayFlowCodec.test.ts`; do not add a production script.

- [ ] **Step 3: Perform manual editor acceptance**

1. Open an existing persisted draft.
2. Switch to low-code mode and add an `any` condition with two element branches.
3. Apply, switch to canvas, verify the node appears with “仅低代码可编辑”.
4. Move an unrelated canvas node and switch back to low-code.
5. Verify the `any` condition is unchanged.
6. Enter `nodes: [`, try to switch to canvas, and verify the invalid text remains with line/column feedback.
7. Enter anchor/alias YAML and verify it is rejected as `FLOW_DSL_PARSE_ERROR` with unsafe-feature detail.

- [ ] **Step 4: Record evidence and link it from the docs index**

Write commands, commit hash, codec hashes, and manual observations to `docs/superpowers/verification/2026-09-01-replay-flow-low-code-roundtrip.md`. Add one link under the automation recording/orchestration section of `docs/INDEX.md`.

- [ ] **Step 5: Commit Increment B verification**

```bash
git add docs/superpowers/verification/2026-09-01-replay-flow-low-code-roundtrip.md docs/INDEX.md backend/src/services/DeviceReplayFlowCodec.test.ts
git commit -m "docs: verify replay flow low-code round trip"
```

## Increment B Exit Criteria

- Unsafe YAML tags, anchors, aliases, and merge keys are rejected with line/column diagnostics.
- A valid DSL formats byte-identically on repeated passes.
- YAML round-trip preserves the compiled graph for every DSL node and condition type.
- Canvas and code mode update one accepted DSL state.
- Invalid code text is preserved and blocks mode switching without overwriting the draft.
- Canvas-inexpressible valid structures remain visible, saved, publishable, and executable as low-code-only nodes.
