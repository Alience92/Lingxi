# Changelog

## 2026-05-23 — MVP Validation & Integration Testing

### Features
- **Embedding persistence**: vectors stored as BLOB on write, read directly on search — reduces API calls from O(N) to O(1) per query
- **Server-side fragmentation**: DeepSeek API auto-fragments transcripts via `memory_remember` (falls back to prompt-mode without API key)
- **Separate API keys**: embeddings (MiniMax embo-01) and fragmentation (DeepSeek) use independent keys — both optional
- **Dynamic minScore**: automatically adjusts search threshold based on embedder mode (0.30 API / 0.12 hash)
- **SessionStart auto-scan**: detects unprocessed `.jsonl` transcripts across all projects, infers workspace_dir
- **UserPromptSubmit prefetch**: silent associative recall on every user message (disabled by default until vector persistence proven)
- **L0 distillation**: dreaming merges ≥3 same-label fragments into distilled rules, injected at session start

### Bug Fixes
- `runDecay` snake_case/camelCase mismatch (caused dreaming to delete all fragments)
- `DEFAULT_MIN_SCORE` too high for Chinese n-gram hash (0.35→0.18→now dynamic)
- `linkedTo` forward references failing FK constraint (two-phase persistence)
- `vectorSearch` not hydrating anchors/linkedIds (caused prefetch crash)
- `SessionStart` overwriting `pending_fragmentation=1` with `INSERT OR REPLACE`
- `persistFragments` snake_case column mapping in search path (caused confidence=NaN)
- `memory_recall` not bumping recalled_count on no-query path
- `deleteFragment` relying on CASCADE (now explicit child-record cleanup)
- MMR diversity too weak (added near-duplicate detection at sim>0.95)
- `@xenova/transformers` crash on Windows (replaced with API-based embedder)
- 1536-dim vs 384-dim hash mismatch (hash now matches API dimension)

### Architecture
- `Embedder` class replacing module-level singleton
- `runDistillation()` extracted from tools.ts to engine.ts
- `getCurrentEmbedder()` reads env vars for hook subprocesses
- Per-query embedding cache (`Map<fragmentId, vector>`) in retriever
- Schema migration: `vector BLOB` column on fragments, `fingerprint` on distilled_rules
- Bootstrap fallback: scans workspaceDir for `*.md` when `memory/*.md` path doesn't exist

### Tests
- 23 integration tests (up from 15)
- Coverage: L1-L4 recall, forward-ref links, distillation, adapters, decay, prefetch MMR

### Performance
- Search with persisted vectors: 1 API call (query only)
- Prefetch hook: ~500ms with cached vectors (previously 5-10s with N+1 API calls)
