# ADR-002: Memory Ranking Formula

## Status
Accepted

## Context
The assistant needs to inject relevant memories into its system prompt each turn. With potentially hundreds of memories, we need to select the most useful subset without expensive semantic search on every request.

## Decision
Top N memories (default 10) are selected using a weighted score:
- **40% recency** — newer memories rank higher (exponential decay over 30 days)
- **30% access frequency** — frequently recalled memories are likely still relevant
- **30% confidence** — user-corrected or high-confidence memories rank higher

Deduplication uses bigram similarity (>80% threshold) against the last 30 memories to prevent near-duplicate storage.

## Key files
- `apps/core/src/db/memories.ts` — `getTopMemories()`, `writeMemory()`

## Consequences
- No embedding model or vector DB required — runs on SQLite
- Memories naturally age out if not accessed
- The 40/30/30 split was tuned empirically — may need adjustment as memory count grows
- FTS5 is used for `recall` search queries, with LIKE fallback
