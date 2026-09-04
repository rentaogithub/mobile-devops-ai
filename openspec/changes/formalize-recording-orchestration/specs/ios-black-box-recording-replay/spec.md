# Delta: iOS Black-box Recording and Replay

## MODIFIED Requirements

### Requirement BRR-005: Explicit Recording Source for Orchestration

THE System MAY load the active or most recent accessible recording for display, but it MUST NOT use a recording as the source of a new orchestration until the user explicitly confirms that recording.

#### Scenario: Confirm the stopped recording

- **GIVEN** the user has stopped a recording and selected replayable steps
- **WHEN** the user chooses “基于本次录制生成编排”
- **THEN** the System SHALL display the recording name, ID, stop time, device, and selected-step count
- **AND** SHALL display the ordered selected-step summary
- **AND** SHALL require confirmation before creating a flow draft

#### Scenario: Historical recording is only displayed

- **GIVEN** there is no active recording
- **AND** the device console displays the most recent accessible recording
- **WHEN** the user has not confirmed that recording as an orchestration source
- **THEN** the System MUST NOT create or overwrite a flow draft from it

### Requirement BRR-006: Confirmed Recording-to-Draft Generation

THE System SHALL convert a confirmed recording's `ready` and selected steps into a deterministic DSL v1 draft and SHALL persist the source recording identity and fingerprint.

#### Scenario: Create a draft from selected steps

- **GIVEN** a stopped recording with two selected ready steps
- **AND** the user confirms the orchestration preview
- **WHEN** the System creates the draft
- **THEN** the draft SHALL contain Start, the two ordered action nodes, Success End, and Failure End
- **AND** action failures SHALL route to Failure End
- **AND** the draft SHALL persist `sourceRecordingId` and `sourceFingerprint`

#### Scenario: Recording has no selected steps

- **GIVEN** a stopped recording with no `ready && included` steps
- **WHEN** the user requests orchestration preview or draft creation
- **THEN** the System SHALL reject the request with `RECORDING_HAS_NO_SELECTED_STEPS`

## ADDED Requirements

### Requirement BRR-012: Recording Source Preview and Fingerprint

THE System SHALL provide an orchestration preview for a recording and SHALL calculate a stable SHA-256 fingerprint over the normalized selected-step generation input.

The fingerprint SHALL include recording ID, ordered selected step IDs, action payloads, and target payloads. It MUST NOT include screenshot or Source file binary content.

#### Scenario: Fingerprint remains stable

- **GIVEN** a recording whose selected steps and annotations have not changed
- **WHEN** the preview is requested multiple times
- **THEN** the System SHALL return the same `sourceFingerprint`

#### Scenario: Annotation changes the fingerprint

- **GIVEN** an existing preview fingerprint
- **WHEN** the user changes the target annotation of a selected step
- **THEN** the next preview SHALL return a different `sourceFingerprint`

#### Scenario: Source changed after draft creation

- **GIVEN** a draft created from a recording fingerprint
- **AND** the recording selection or annotation later changes
- **WHEN** the user opens the draft
- **THEN** the System SHALL indicate that the recording source has changed
- **AND** MUST NOT automatically rewrite the draft

### Requirement BRR-013: Persistent Flow Draft

THE System SHALL persist each editable flow draft with its DSL, source identity, source fingerprint, validation state, revision, editor, and update time.

#### Scenario: Reopen a draft

- **GIVEN** a user edits and saves a flow draft
- **WHEN** the page or backend is restarted
- **THEN** the user SHALL be able to reopen the draft with the saved DSL and revision

#### Scenario: Autosave a visual edit

- **GIVEN** an open draft in the visual editor
- **WHEN** the user changes a node or transition
- **THEN** the client SHALL schedule save after a 1-second debounce
- **AND** SHALL flush pending changes before closing the workspace

#### Scenario: Reject a stale save

- **GIVEN** draft revision 8 is stored
- **AND** a client attempts to save with `expectedRevision = 7`
- **WHEN** the save request is processed
- **THEN** the System SHALL reject it with HTTP 409 and `FLOW_DRAFT_CONFLICT`
- **AND** SHALL return the current revision
- **AND** MUST NOT overwrite revision 8

#### Scenario: Reset from the source recording

- **GIVEN** a draft has user edits
- **WHEN** the user requests reset from the source recording
- **THEN** the System SHALL display that current edits will be replaced
- **AND** SHALL require explicit confirmation
- **AND** SHALL save the newly generated DSL as a new draft revision

### Requirement BRR-014: Safe Low-code Round Trip

THE System SHALL provide a YAML low-code representation of the same DSL used by the visual editor and SHALL preserve DSL semantics when switching editing modes.

#### Scenario: Visual-to-YAML-to-visual round trip

- **GIVEN** a valid visual flow
- **WHEN** the user switches to YAML and back without semantic edits
- **THEN** the compiled execution graph SHALL remain equivalent

#### Scenario: YAML parse error

- **GIVEN** invalid YAML in the low-code editor
- **WHEN** the user validates or switches to the visual editor
- **THEN** the System SHALL display the parse error with line and column
- **AND** SHALL retain the invalid editor text
- **AND** MUST NOT overwrite the last valid DSL

#### Scenario: Reject unsafe YAML features

- **GIVEN** YAML containing a custom tag, anchor, alias, executable expression, or environment-variable expansion
- **WHEN** the YAML is parsed
- **THEN** the System SHALL reject it
- **AND** SHALL report `FLOW_DSL_PARSE_ERROR`

#### Scenario: Preserve a non-visual structure

- **GIVEN** a valid DSL structure that the first visual editor cannot fully decompose
- **WHEN** the user opens the visual editor
- **THEN** the System SHALL represent it as a low-code node
- **AND** MUST NOT drop or silently rewrite the structure

### Requirement BRR-015: Immutable Publish and History

THE System SHALL allow a valid draft to be published as an immutable, monotonically versioned flow snapshot containing both DSL and compiled execution graph.

#### Scenario: Publish a valid draft

- **GIVEN** a draft whose Schema validation and static flow validation pass
- **WHEN** an authorized user publishes it with a release note
- **THEN** the System SHALL atomically create the next flow version
- **AND** SHALL store the DSL, compiled graph, source fingerprint, publisher, publish time, and release note

#### Scenario: Publish validation fails

- **GIVEN** a draft with a validation error
- **WHEN** a user attempts to publish
- **THEN** the System SHALL reject the publish with `FLOW_VALIDATION_FAILED`
- **AND** MUST NOT allocate a version number or save a partial version

#### Scenario: Edit a published flow

- **GIVEN** a published version
- **WHEN** the user wants to modify it
- **THEN** the System SHALL create a new draft from that version
- **AND** MUST NOT mutate the published version

#### Scenario: Roll back

- **GIVEN** an older published version
- **WHEN** an authorized user selects rollback
- **THEN** the System SHALL create a new draft copied from the selected version
- **AND** SHALL require a new publish to make it current

### Requirement BRR-016: Version-bound Execution

THE System SHALL distinguish draft debug runs from formal quality runs and SHALL bind every run to an exact editable revision or immutable version.

#### Scenario: Debug a draft

- **GIVEN** a saved draft revision
- **WHEN** an authorized user starts a debug run
- **THEN** the run SHALL store the draft ID and revision
- **AND** SHALL execute the DSL saved at that revision

#### Scenario: Start a formal quality run

- **GIVEN** a published flow version
- **WHEN** a quality run starts
- **THEN** the request SHALL identify `flowVersionId`
- **AND** the server SHALL load the stored published DSL and compiled graph
- **AND** MUST NOT accept a request-body DSL override

#### Scenario: Missing version

- **GIVEN** a formal quality-run request without `flowVersionId`
- **WHEN** the server validates the request
- **THEN** it SHALL reject the request with `FLOW_VERSION_REQUIRED`

### Requirement BRR-017: P0 Quality and Jenkins Gate Integration

THE System SHALL allow a P0 quality case to bind a published flow version together with App build, environment, device target, account mapping, and input mapping.

#### Scenario: Execute a P0 case

- **GIVEN** a P0 case bound to a published flow version and a test environment
- **WHEN** the quality task is executed
- **THEN** the System SHALL run that exact version on the assigned device
- **AND** SHALL produce a result and evidence link for the case

#### Scenario: Classify a product failure

- **GIVEN** WDA and the device session are healthy
- **WHEN** an assertion or required product state fails
- **THEN** the case result SHALL be `failed`

#### Scenario: Classify an infrastructure failure

- **GIVEN** the device is locked, disconnected, WDA cannot start, or the runner process is interrupted
- **WHEN** the quality run cannot execute the product path
- **THEN** the case result SHALL be `infra_failed`
- **AND** MUST NOT be reported as a product assertion failure

#### Scenario: Jenkins consumes the result

- **GIVEN** a Jenkins pipeline waits for the quality task
- **WHEN** the task reaches a terminal state
- **THEN** Jenkins SHALL receive the version ID, result category, duration, and report URL
- **AND** SHALL apply the configured policy for `failed` and `infra_failed`

### Requirement BRR-018: Authorization and Audit

THE System SHALL enforce role-based authorization and SHALL audit flow creation, save, publish, rollback, deletion, debug execution, and quality execution.

#### Scenario: Unauthorized publish

- **GIVEN** a user without flow publish permission
- **WHEN** the user attempts to publish a draft
- **THEN** the System SHALL reject the request with HTTP 403
- **AND** MUST NOT create a version

#### Scenario: Audit a publish

- **GIVEN** an authorized user publishes a draft
- **WHEN** publishing succeeds
- **THEN** the System SHALL store the actor, flow, draft revision, version, timestamp, and action
- **AND** MUST NOT store passwords, tokens, or real runtime input values

### Requirement BRR-019: Backward Compatibility and Migration

THE System SHALL preserve access to existing recordings, DSL v1 templates, evidence files, and historical run records while introducing persistent flow assets.

#### Scenario: Generate an asset from an existing recording

- **GIVEN** a recording created before this change
- **WHEN** the user confirms it for orchestration
- **THEN** the System SHALL create a new Flow Asset and Draft without rewriting the recording evidence

#### Scenario: Read a legacy run

- **GIVEN** a run created before version-bound execution
- **WHEN** the user views the run
- **THEN** the System SHALL preserve its original status and evidence
- **AND** SHALL label its flow source as `legacy`
- **AND** MUST NOT invent a published version association

### Requirement BRR-020: Monkey Exploration Boundary

THE System SHALL treat Monkey output as exploratory evidence and candidates, not as automatically published deterministic flows.

#### Scenario: Complete a Monkey exploration

- **GIVEN** a bounded Monkey strategy with maximum steps and duration
- **WHEN** exploration completes
- **THEN** the System SHALL retain the action journey, screenshots, and WDA Source evidence as exploration candidates
- **AND** MUST NOT automatically publish the journey

#### Scenario: Promote a Monkey segment

- **GIVEN** a user selects a useful segment from an exploration journey
- **WHEN** the user sends it to flow creation
- **THEN** the segment SHALL enter the same filtering, annotation, and explicit source-confirmation process as a manual recording

### Requirement BRR-021: Composable Single-run Execution Chain

THE System SHALL allow a replay Flow Asset to reference an optional pre-flow and an optional post-flow and SHALL execute the resulting chain once in the deterministic order `pre -> main -> post`.

The references SHALL point to independent Flow Assets and MUST NOT copy their DSL nodes into the main flow. Loop count, concurrency, device-pool allocation, and Jenkins scheduling MUST remain Quality Task properties.

#### Scenario: Reject an invalid chain reference

- **GIVEN** a Flow Asset execution-chain configuration
- **WHEN** the pre-flow or post-flow references the main flow itself, creates a transitive cycle, belongs to another project, is archived, or has not completed creation
- **THEN** the System SHALL reject the configuration
- **AND** MUST NOT overwrite the previously saved execution chain

#### Scenario: Pre-flow fails

- **GIVEN** a chain with pre-flow, main flow, and post-flow
- **WHEN** the pre-flow fails
- **THEN** the System SHALL mark the main phase `skipped`
- **AND** SHALL still attempt the post-flow cleanup
- **AND** SHALL mark the chain run `failed`

#### Scenario: Main flow fails

- **GIVEN** a chain with a post-flow
- **WHEN** the main flow fails
- **THEN** the System SHALL still attempt the post-flow cleanup
- **AND** SHALL preserve independent phase run IDs, statuses, screenshots, and Source evidence

#### Scenario: Persist a single-run task

- **GIVEN** a user starts a Flow Asset once with runtime inputs
- **WHEN** the chain run is persisted
- **THEN** the System SHALL store the main asset, phase asset references, device, statuses, duration, and runtime input names
- **AND** MUST NOT persist runtime input values
