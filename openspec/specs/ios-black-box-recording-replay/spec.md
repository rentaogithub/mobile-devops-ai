# iOS Black-box Recording and Replay Capability

## Purpose

定义 `nn-ios-platform` 当前已经具备的纯黑盒 iOS 真机录制、补标、流程生成、编排、执行和证据能力。本文件描述当前基线；后续目标行为通过 `openspec/changes` 中的 delta spec 管理。

## Requirements

### Requirement BRR-001: WDA Device Session

THE System SHALL allow an authorized user to discover a USB-connected iOS device, start or reconnect WebDriverAgent, obtain the logical window size, and receive actionable diagnostics when the session cannot start.

#### Scenario: Locked device diagnosis

- **GIVEN** an authorized user selects a connected iPhone
- **AND** the iPhone is locked
- **WHEN** the user starts WDA
- **THEN** the System SHALL stop waiting within the configured startup timeout
- **AND** SHALL report that the device must be unlocked before retrying

### Requirement BRR-002: Precise Platform Action Recording

THE System SHALL record each Tap, Swipe, or Input action issued from the platform together with its parameters and before/after evidence.

#### Scenario: Record a platform tap

- **GIVEN** an active recording and connected WDA session
- **WHEN** the user taps the mirrored device image
- **THEN** the System SHALL store a Tap step
- **AND** SHALL store its normalized coordinate
- **AND** SHALL capture before and after screenshot and WDA Source evidence

### Requirement BRR-003: External Change Candidate Capture

THE System SHALL treat page changes caused outside the platform as candidates rather than reconstructing them as precise WDA commands.

#### Scenario: Physical phone interaction

- **GIVEN** an active recording
- **WHEN** the user operates the physical phone and the page changes
- **THEN** the System SHALL create an external-change candidate
- **AND** SHALL capture before and after screenshot and Source evidence
- **AND** MUST NOT silently infer an exact Tap, Swipe, or Input command

### Requirement BRR-004: Candidate Filtering and Annotation

THE System SHALL allow users to exclude noise and manually promote an external-change candidate to a replayable Tap, Swipe, or Input step.

#### Scenario: Promote a candidate to Tap

- **GIVEN** a candidate with before and after evidence
- **WHEN** the user marks a target point and confirms Tap annotation
- **THEN** the System SHALL create a replayable Tap step linked to the candidate
- **AND** SHALL preserve the candidate evidence

### Requirement BRR-005: Current Recording Selection Behavior

THE System SHALL load the active recording when one exists; otherwise it SHALL load the most recent recording accessible to the user for display and template generation.

#### Scenario: No active recording

- **GIVEN** the user opens the device console without an active recording
- **WHEN** an accessible historical recording exists
- **THEN** the System SHALL display the most recent recording
- **AND** SHALL use that recording when the user opens the current orchestration entry

### Requirement BRR-006: Recording-to-DSL Template

THE System SHALL convert all `ready` and selected recording steps into a deterministic DSL v1 linear template.

#### Scenario: Generate a two-step template

- **GIVEN** a stopped recording with two selected ready steps
- **WHEN** the orchestration template is requested
- **THEN** the System SHALL generate Start followed by the two action nodes and Success End
- **AND** SHALL route action failures to Failure End
- **AND** SHALL reference the source recording ID

### Requirement BRR-007: DSL Validation and Compilation

THE System SHALL validate DSL structure and flow semantics before compilation or execution.

#### Scenario: Missing timeout branch

- **GIVEN** a Wait node that requires `onTimeout`
- **WHEN** the user validates the flow without that branch
- **THEN** the System SHALL reject the flow
- **AND** SHALL identify the node and missing transition

### Requirement BRR-008: State-driven Execution

THE System SHALL execute Start, action, wait, condition, assertion, and end nodes using explicit state transitions, bounded timeouts, bounded retries, and user cancellation.

#### Scenario: Wait for search results

- **GIVEN** an Input node followed by a keyboard Search action and a Wait node
- **WHEN** the flow runs
- **THEN** the System SHALL wait for the configured result condition
- **AND** SHALL continue only after the condition succeeds
- **AND** SHALL follow the timeout branch when the condition does not succeed in time

### Requirement BRR-009: Semantic and Geometric Targeting

THE System SHALL prefer semantic target matching and SHALL use normalized geometry only as a fallback.

#### Scenario: Semantic target is available

- **GIVEN** a Tap target with accessibility identity, label, and normalized coordinate
- **WHEN** a matching WDA element exists
- **THEN** the System SHALL tap the resolved element-relative point
- **AND** SHALL record the semantic locator strategy
- **AND** MUST NOT use the screen coordinate fallback

### Requirement BRR-010: Node Evidence and Run Recovery

THE System SHALL retain node execution results and before/after evidence, and SHALL allow completed runs to be read after backend restart.

#### Scenario: Read a failed run after restart

- **GIVEN** a completed failed run with captured node evidence
- **WHEN** the backend restarts and the user requests the run
- **THEN** the System SHALL return the run status, node results, branch decisions, and evidence URLs

### Requirement BRR-011: Visual DSL Projection

THE System SHALL project DSL nodes and transitions into a visual canvas without maintaining a separate semantic edge model.

#### Scenario: Connect a branch

- **GIVEN** a selected Wait node on the canvas
- **WHEN** the user connects its timeout output to Failure End
- **THEN** the System SHALL update the Wait node's `onTimeout` field in the DSL
- **AND** SHALL invalidate the previous validation result
