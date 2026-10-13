# Lingxi V7 Local Validation Plan

This document lists the remaining local-only work after the V7 memory fixes and user-model implementation.

## Current Completed Scope

- V7 long-term memory lifecycle is implemented.
- Fragment hourglass moves stale memories through `active`, `warm`, `archived`, and `cold`.
- Recalled memories are reactivated through `recordRecall(...)`.
- `user_memory_models` now supports evidence-driven user modeling.
- User models are scoped by `project_id` and `profile_id`.
- User models support `fingerprint`, `status`, `priority`, `superseded_by`, evidence counts, source session counts, and conflict timestamps.
- Maintenance-time internalization supports cross-session reinforcement, supersede chains, and user-deleted evidence rollback.
- Runtime recall reads only active, non-superseded user models.
- Regression evals cover V5-style user model behavior and core user-model lifecycle risks.

## Implemented Code

- `src/db/schema.ts`
- `src/db/connection.ts`
- `src/core/v7-long-term-memory.ts`
- `src/tools/eval-user-model-v5-compat.ts`
- `src/tools/eval-user-model-regression.ts`

## Verified Commands

```bash
npm run build
node --import tsx src/tools/eval-user-model-regression.ts
node --import tsx src/tools/eval-user-model-v5-compat.ts
node --import tsx src/tools/eval-long-memory-lifecycle.ts
```

Expected result:

- all commands complete successfully
- each eval prints `PASS`

## Remaining Local Work

### 1. Validate real embedding mode

Current cloud validation still uses hash fallback unless a real embedding endpoint is configured locally.

Required environment:

```bash
export AGENTMEMORY_EMBEDDING_URL="<real embedding endpoint>"
export AGENTMEMORY_API_KEY="<real api key if required>"
export AGENTMEMORY_EMBEDDING_MODEL="<embedding model>"
export AGENTMEMORY_SEMANTIC=1
```

Validation commands:

```bash
npm run build
node --import tsx src/tools/eval-retrieval-zh.ts
node --import tsx src/tools/eval-user-model-v5-compat.ts
node --import tsx src/tools/eval-user-model-regression.ts
```

Acceptance criteria:

- `eval-retrieval-zh.ts` completes without falling back to hash-only vector behavior.
- `benchmark-results/v7-memory-benchmark-zh.json` reports a real vector index mode when available.
- `Recall@1` does not regress below the current hash-fallback baseline by more than 2 percentage points.
- `eval-user-model-v5-compat.ts` still prints `PASS`.
- `eval-user-model-regression.ts` still prints `PASS`.

### 2. Validate reflection with real model credentials

Reflection remains blocked in environments without valid model credentials.

Required environment:

```bash
export OPENAI_API_KEY="<real key>"
# or
export DEEPSEEK_API_KEY="<real key>"
```

If a custom provider is used, also configure the matching base URL variable documented in `docs/reflection-api-key-runbook.md`.

Validation commands:

```bash
npm run build
node --import tsx src/test-reflection.ts
node --import tsx src/tools/eval-long-memory-lifecycle.ts
```

Acceptance criteria:

- reflection no longer reports missing or invalid credentials
- reflection failures remain non-fatal
- reflection-generated memories do not bypass `project_id/profile_id` isolation
- `eval-long-memory-lifecycle.ts` still prints `PASS`

### 3. Run extended long-run stability locally

The current long-run script covers a bounded stability case. Local validation should run it together with the new user-model regression checks after real credentials and embedding are configured.

Validation commands:

```bash
npm run build
node --import tsx src/tools/eval-longrun-stability.ts
node --import tsx src/tools/eval-profile-isolation.ts
node --import tsx src/tools/eval-user-model-regression.ts
```

Acceptance criteria:

- long-run stability prints `PASS`
- profile isolation reports `top1PassRate = 100%`
- profile isolation reports `noLeakRate = 100%`
- user-model regression prints `PASS`

### 4. Decide whether to wire evals into CI

The repository currently runs eval scripts manually. CI integration is optional but recommended before treating V7 as a release candidate.

Suggested package scripts:

```json
{
  "eval:user-model": "node --import tsx src/tools/eval-user-model-regression.ts && node --import tsx src/tools/eval-user-model-v5-compat.ts",
  "eval:v7-memory": "node --import tsx src/tools/eval-long-memory-lifecycle.ts && node --import tsx src/tools/eval-profile-isolation.ts"
}
```

Acceptance criteria:

- CI runs `npm run build`
- CI runs user-model evals on every memory-related change
- generated `benchmark-results/` files remain uncommitted artifacts

## Release Readiness Gate

V7 can be considered locally validated when all of the following are true:

- TypeScript build passes.
- Long-memory lifecycle eval passes.
- V5-compatible user-model eval passes.
- User-model regression eval passes.
- Profile isolation eval passes.
- Long-run stability eval passes.
- Real embedding mode has been validated or explicitly deferred.
- Reflection has been validated with real credentials or explicitly deferred.

## Known Deferred Risks

- Conflict detection is currently lexical and conservative. Real semantic conflict detection should use embedding or model-assisted checks after the embedding path is validated.
- Reflection behavior cannot be fully validated without real API credentials.
- Large-scale production-like stress testing is still local-only because it depends on runtime environment and credentials.
