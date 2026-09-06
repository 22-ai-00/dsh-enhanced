# Task 1 report: canonical canary evidence and promotion fence

Status: DONE

## Changes

- `assistant-evaluation` now exposes an exact Host-only canonical learning projection lookup by automation run id. It reuses the existing task projection and trusted projection receipt instead of defining a second success rule.
- `assistant-automations` canary inspection now requires the exact production run's ready/upsert canonical projection with trusted execution `succeeded` and objective `achieved`.
- Automation schema v11 persists the complete canonical proof, including task revision/digest and the inspection-time scope watermark. The v10 migration adds the proof column; legacy proof rows fail closed.
- Promotion rereads current canonical evidence and commits activation under Evaluation's existing synchronous writer fence. The canary task revision/digest/disposition must still match the saved inspection proof. The fence uses the freshly read scope watermark so unrelated canonical progress in the same scope does not permanently poison a legitimate inspection receipt.
- Canary inspection and completed promotion remain durably replayable. A replayed passed inspection revalidates its saved proof; a completed promotion replays its committed receipt.
- README contracts describe the exact-run canonical proof and fence behavior.

## Behavioral coverage

`plugins/assistant-automations/tests/canary-proof.spec.ts` covers:

- conflicting owner judgements before inspection;
- same-task evidence changing between inspection and promotion;
- restart replay of a saved success after correction;
- writer-lock exclusion during activation;
- a correction committed immediately before fence acquisition;
- v10 legacy proof migration and rejection;
- unchanged restart replay and promotion idempotence;
- wrong run/scope rejection;
- pending trusted projection rejection;
- unrelated task progress refreshing the scope watermark while preserving the exact saved canary identity.

The test uses real `GrowthAutomationStore`, `EvaluationStore`, SQLite migrations/outbox/projection views, and `AssistantEvaluationService` Host methods. Only the surrounding Cordis construction and automation activation seam are isolated.

## Verification

- `pnpm --filter @dsh-enhanced/assistant-automations test -- canary-proof.spec.ts`
  - exit 0; Vitest ran the package suite: 14 files passed, 208 tests passed.
- `pnpm --filter @dsh-enhanced/assistant-evaluation test`
  - exit 0; 6 files passed, 36 tests passed.
- `pnpm --filter @dsh-enhanced/assistant-automations typecheck`
  - exit 0; `tsc -p tsconfig.json --noEmit`.
- `pnpm --filter @dsh-enhanced/assistant-evaluation typecheck`
  - exit 0; `tsc -p tsconfig.json --noEmit`.
- `pnpm --filter @dsh-enhanced/assistant-automations build`
  - exit 0; `tsc -p tsconfig.build.json`.
- `pnpm --filter @dsh-enhanced/assistant-evaluation build`
  - exit 0; `tsc -p tsconfig.build.json`.
- `git diff --check` and `git diff --cached --check`
  - exit 0; no whitespace errors.

Node printed only its expected experimental SQLite warning during tests.

## Commits

- `6b82214` `fix: fence canary promotion on canonical evidence`
- This report is committed separately so it can record the implementation commit exactly.

## Concerns

- The repository-wide `pnpm check` is intentionally left to the root task's independent verification, per task coordination.
- `docs/agent-autonomy-implementation.md` was already dirty and is unrelated; it was neither staged nor modified by this task.
