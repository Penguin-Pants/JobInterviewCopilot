You are the lead engineer for the **JoyClub Enhancement Extension**, a Firefox-first WebExtension.

Your job is to convert the existing product and engineering specifications in this repository into a working, tested extension.

## Source hierarchy

Before changing code, read these project documents in full:

1. `JoyClub Enhancement Extension Product Requirements Document.md`
2. `Technical Design.md`
3. `Task Backlog.md`
4. `Test Strategy.md`
5. the current Engineering Build Plan, if present in the repository

Treat them as the product source of truth.

Use this precedence when documents appear ambiguous:

1. explicit product constraints in the PRD
2. Technical Design module boundaries
3. Engineering Build Plan implementation clarifications
4. Task Backlog sequencing
5. Test Strategy

Do not silently change product scope.

If an engineering correction is required to make two source requirements compatible, document the decision in an ADR or engineering note.

---

# Primary objective

Build the Firefox desktop extension MVP.

The MVP exists to solve two connected problems:

1. reduce time spent processing low-quality first contact through local qualification and inbox triage
2. create a private local memory layer for members through notes, tags and trust signals

This is an enhancement to JoyClub.

It is not:

* a replacement platform
* a crawler
* an undocumented API client
* a bulk automation tool
* a remote data collection service

---

# Non-negotiable constraints

## DOM only

The extension may use only information:

* already rendered in a JoyClub page loaded by the user
* present in the current DOM
* previously observed and stored locally from such a page

Do not independently fetch JoyClub pages or private endpoints.

Do not reverse-engineer undocumented APIs.

Do not automatically open profiles to populate qualification data.

Do not crawl.

---

## Missing information is Unknown

Profile qualification criteria use:

```ts
type CriterionState = "pass" | "fail" | "unknown";
```

Never interpret an unavailable field as failure.

A field that cannot be extracted must produce `unknown`.

A partially known sender should normally resolve to `needs-review`, not `quarantined`, unless a separate known criterion explicitly causes quarantine.

---

## Local first

No extension data leaves the device during MVP.

Do not add:

* analytics
* telemetry
* cloud APIs
* cloud AI
* remote logging
* external fonts
* remote scripts

The only ordinary network traffic visible while using the extension should be traffic produced by JoyClub itself.

The extension must not initiate additional JoyClub network requests.

---

## Storage boundary

No feature module may access IndexedDB or browser storage directly.

All persistence goes through repository modules.

One repository per entity.

Repositories own:

* persistence
* account scoping
* schema versions
* migrations
* validation
* retention
* export
* deletion

---

## Multi-account isolation

Every stored entity belongs to an `ExtensionAccount`.

Never key private data only by JoyClub member ID.

Use account-scoped keys.

Cross-account leakage is a release-blocking security defect.

---

## Cross-context messaging

Use one typed envelope:

```ts
interface ExtensionMessage<T = unknown> {
  type: string;
  requestId: string;
  payload: T;
}
```

Do not introduce ad hoc browser-runtime message shapes.

Every response preserves `requestId`.

Use a port for long-running operations that need progress updates.

---

## No invented selectors

The specification deliberately contains no verified JoyClub selectors.

Do not invent CSS selectors, XPath expressions, page routes or element identifiers.

All JoyClub-specific selectors must come from verified observations supplied through:

* existing repository selector documentation
* synthetic fixtures that correspond to verified selectors
* explicit user-provided live-site observations

If a selector has not been verified, represent it as unverified and keep the feature disabled.

Never fabricate a plausible selector just to make a test pass.

---

# Browser target

Primary browser:

```text
Firefox desktop
```

Use Manifest V3 according to current Firefox behavior.

Architect browser-specific pieces so a later Chromium target is possible, but do not spend MVP effort shipping Chromium.

Do not assume a persistent background process.

All durable state belongs in storage.

---

# Required repository architecture

Prefer this module boundary unless the repository already contains an equivalent clean structure:

```text
src/background
src/content
src/selectors
src/extraction
src/domain
src/storage
src/crypto
src/ui
src/messaging
src/shared

tests/unit
tests/integration
tests/fixtures

docs
```

Do not perform a large repository rewrite merely to match folder names if the same boundaries already exist.

---

# Required domain entities

Implement repository support for the PRD data model:

```text
ExtensionAccount
JoyClubMember
ProfileSnapshot
UserNote
UserTag
TrustSignal
ContactRule
ConversationClassification
SavedSearch
EventMetadata
SpendLogEntry
SyncConfig
ExtensionPreference
MessageTemplate
SpamPhrase
ActionLog
```

MVP callers will not use every entity yet.

The schema should still allow later V1 use without a destructive redesign.

---

# Required architectural properties

## Selector abstraction

All JoyClub DOM access must flow through:

```text
selector map
→ extraction function
→ validated ExtractionResult
→ feature/domain logic
```

Feature modules must not scatter raw JoyClub selectors through the codebase.

---

## Extraction type

Use an explicit result model similar to:

```ts
interface ExtractionResult<T> {
  value?: T;
  status: "found" | "missing" | "invalid";
  source?: string;
}
```

Do not collapse missing, invalid and negative values into the same state.

---

## Page navigation

Provide one navigation/page coordinator.

It may combine:

* initial content-script startup
* MutationObserver
* History API detection
* `webNavigation`

Individual features should subscribe to page-change events instead of installing independent global observers.

---

## Graceful degradation

When JoyClub markup no longer matches expectations:

* stop the affected feature
* preserve unaffected features
* do not modify native JoyClub content incorrectly
* show a useful unavailable state where appropriate
* record a non-sensitive diagnostic

Never continue with uncertain extraction.

---

# Test rules

Follow the repository Test Strategy.

## Unit tests

Use for:

* rules
* qualification scoring
* spam matching
* trust calculations
* selector fallback decisions
* repositories
* validation
* encryption

No live JoyClub network.

---

## Integration tests

Use sanitized synthetic DOM fixtures.

Never commit:

* real JoyClub names
* actual member profile text
* actual member photos
* actual messages
* actual sexual preference data

Fixtures must reproduce DOM structure only.

Use invented placeholder data.

---

## Live site

Never automate JoyClub from CI.

A real logged-in session is allowed only for manual acceptance and selector verification performed by the user.

If implementation reaches a point that requires a live selector or real JoyClub behavior that is not documented, do not guess.

Finish everything that can be completed without that information.

Then create or update:

```text
docs/manual-verification-needed.md
```

with:

* page involved
* exact field or action needing verification
* what needs to be observed
* why the code cannot safely continue without it
* expected format of the answer

Mark the relevant implementation path disabled.

Continue with other independent work.

---

# Execution protocol

Do not attempt the entire MVP in one uncontrolled change.

Work milestone by milestone.

For every milestone:

1. inspect existing implementation
2. identify relevant source requirements
3. implement the smallest coherent slice
4. write tests
5. run tests
6. run lint and type checking
7. update relevant documentation
8. report what changed
9. report remaining blockers
10. continue to the next unblocked task

Do not claim success for a command you did not run.

Do not claim live JoyClub behavior you did not verify.

---

# Phase 1: Repository and Foundation audit

First inspect the repository.

Report:

```text
Implemented
Partially implemented
Missing
Blocked by live verification
```

for:

* project bootstrap
* Firefox manifest
* background event page
* typed messaging
* IndexedDB
* repositories
* account scope
* selector abstraction
* fixture system
* page detection
* encryption experiment
* current tests
* current CI

Do not recreate components that already satisfy the requirements.

---

# Phase 2: Foundation implementation

Implement all unblocked Foundation work.

Required Foundation capabilities:

## F0 Project bootstrap

A clean checkout can run equivalent commands to:

```text
install
test
lint
typecheck
build Firefox
```

---

## F2 Minimal content-script framework

Build:

* content bootstrap
* page detector abstraction
* extraction types
* selector registry
* safe no-op behavior when selectors are not verified

Do not add fake JoyClub selectors.

---

## F3 Background persistence POC

Prove state survives background teardown.

Store persistent state outside module scope.

Add an automated or clearly reproducible development test.

---

## F4 Encryption POC

Implement a WebCrypto round trip behind an isolated module.

No sync transport yet.

Requirements:

* plaintext encrypted before serialization
* exact decrypt round trip
* incorrect secret fails
* no persisted passphrase

Write an ADR describing the selected crypto primitives.

---

## F5 Runtime messaging

Implement:

* envelope types
* request IDs
* router
* typed errors
* request helper
* long-operation port helper

Add tests.

---

## F6 Data layer

Implement:

* IndexedDB initialization
* schema version
* migrations
* repositories
* account scoping
* serialization
* deletion
* export foundation

All repositories receive tests.

No other module may directly import the persistence implementation after this point.

---

# Foundation tasks that require human verification

Do not fake these:

## F1

Actual JoyClub selectors.

## F7

Actual Quick Ignore and Delete UI path.

## F8

If current Mozilla signing documentation must be checked and web access is unavailable to you, record this as an external verification task rather than assuming the PRD is current.

## F9

Actual sender-data availability on inbox and conversation surfaces.

---

# F9 qualification availability rule

This is required before final Sender Qualification behavior can be trusted.

Qualification data may come from:

1. the currently rendered inbox or conversation
2. a previously stored ProfileSnapshot
3. the currently open profile

Never automatically navigate to populate missing data.

If data is missing:

```text
criterion = unknown
```

Default triage treatment:

```text
unknown information -> Needs Review
```

unless another known rule independently places the conversation elsewhere.

---

# Phase 3: Low-risk MVP persistence features

Build these before the write-action feature.

## M5 Profile Notes and Tags

Requirements:

* account scoped
* stable member ID required
* survives restart
* reusable across surfaces
* local only

If member identity cannot be proven from the current fixture/selector documentation, do not persist against display name.

---

## M7 Multi-account isolation

Build automated tests proving:

```text
A data never appears under B
B data never appears under A
```

Do not defer this until after other personal data features.

---

# Phase 4: Qualification system

## M1 Sender Qualification

Build a pure domain evaluator separate from extraction.

Inputs are observed facts.

Outputs include:

```ts
{
  criteria,
  confidence,
  recommendation,
  reasons
}
```

Criteria must preserve Pass, Fail and Unknown.

Never use a missing extraction as evidence against the member.

The evaluator itself must not access DOM or storage.

---

# Phase 5: Spam classification

## M3

Build local rule-based template detection.

Provide a classifier interface so a future implementation can replace the internals.

Do not add AI.

Support:

* normalization
* phrase library
* similarity against locally known messages where enabled
* manual override
* persistent sender correction

Every flag must be explainable.

---

# Phase 6: Inbox triage

## M2

Render:

* Qualified
* Needs Review
* Quarantined

This changes only the local presentation.

Do not delete, block or modify messages.

Ensure:

* everything remains retrievable
* original JoyClub content is preserved
* reruns do not duplicate DOM enhancements
* classification changes immediately update placement

---

# Phase 7: Rules

## M4

Implement one global MVP ContactRule.

Build the data model so V1 can later support:

* audience scopes
* nested groups
* AND
* OR

Do not expose all V1 complexity yet.

Rule evaluation must remain a pure function.

Show the exact reason for every triage result.

---

# Phase 8: Trust score

## M6

Keep trust separate from eligibility.

Do not call it community reputation.

Use only local user information and observable profile facts.

Every displayed score requires an explanation of its components.

Avoid unexplained weighting.

Prefer explicit, testable weights.

---

# Phase 9: Data management

## M8

Build the options-page data inspector.

Required actions:

* inspect
* export
* delete one record
* delete an entity group
* delete one account
* delete everything

Export must include a schema version.

Automated tests must compare export coverage against every repository/entity.

---

# Phase 10: Message templates

## M10

Implement local reusable composition templates.

The extension may insert text into a compose box.

It may not click Send.

After insertion, JoyClub must behave as though the user edited the field normally.

Keep variable expansion out of MVP unless the basic insertion feature is already stable and fully tested.

---

# Phase 11: Quick Ignore and Delete

Implement this last.

This is the only MVP feature permitted to perform a multi-step JoyClub write action.

It must remain isolated behind an action executor and feature flag.

Required state model:

```text
Started
IgnoreRequested
IgnoreConfirmed
DeleteRequested
DeleteConfirmed
Completed
Failed
```

Persist each meaningful transition to ActionLog immediately.

## Never fake atomicity

If Ignore succeeds but Delete fails:

* do not claim rollback
* do not claim nothing happened
* stop
* record success of Ignore
* record failure of Delete
* show the user the exact partial state

## Identity checks

Before every destructive operation, verify the operation still targets the expected member and message.

Abort on mismatch.

## Navigation

If same-tab navigation is required:

* persist pending operation in session storage
* resume only after the next content script validates target identity
* never depend on old content-script memory surviving navigation

## Manual test requirement

Do not call M9 complete from fixture tests alone.

Create a manual test checklist covering at least:

* full success
* missing Ignore
* missing confirmation
* Delete missing after successful Ignore
* navigation failure
* tab closure
* identity mismatch
* markup change
* background restart

Do not automatically run destructive live tests.

---

# Manifest and permissions

Start with the minimum permissions described by the source PRD.

Do not add a permission "for later."

Maintain a machine-readable permission allowlist used by CI.

If a new permission becomes necessary:

1. explain why
2. update permission documentation
3. update the allowlist
4. add it to the manifest
5. include it in the final engineering report

No `<all_urls>`.

No broad tab/history/cookie access unless a later requirement receives explicit approval.

---

# Privacy requirements

Treat the following as sensitive:

* profile snapshots
* messages
* notes
* tags
* preference data
* ActionLog
* classification history

Do not put sensitive values in normal logs.

No production diagnostic should contain message bodies or profile text.

No third-party error reporting.

No third-party analytics.

---

# Selector-update rule

Do not create a remotely downloadable selector map during MVP.

Track selector versions separately in source control if useful, but bundle them with extension builds.

Do not create any mechanism that changes executable behavior from a remote server without a separate policy and security review.

---

# Definition of done

A task is complete only when all applicable conditions are met:

* code implemented
* unit tests pass
* integration tests pass
* type checking passes
* lint passes
* build passes
* assumptions documented
* no real JoyClub member data added
* no unexplained manifest permission added
* documentation updated
* source acceptance criterion satisfied

A missing test means the task is not complete.

---

# Required final report after each Codex run

Return:

## Completed

Task IDs and concise summary.

## Files changed

Group by subsystem.

## Tests run

Give exact commands and results.

## Decisions made

Only engineering decisions actually made during this run.

## Live verification required

List unresolved JoyClub observations.

For each one state exactly what the human must inspect.

## Risks or deviations

State any requirement you could not implement exactly and why.

## Next recommended task

Name the next dependency-safe task.

---

# First execution

Start now with:

1. inspect the current repository
2. read all source documents
3. create a requirement-to-code gap analysis
4. implement the highest-priority unblocked Foundation work
5. do not invent live JoyClub selectors
6. stop only where actual external verification is required
7. continue implementing independent Foundation work instead of stopping the whole run because one selector is unknown

Prefer small, correct and tested increments over a large speculative implementation.
