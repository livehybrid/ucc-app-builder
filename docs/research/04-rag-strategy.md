# Q4 — RAG / Knowledge-Injection Strategy for Splunk UCC

**Source:** Perplexity "Best" mode, Q4 thread.

---

## 1. Large-Context Window vs. On-Demand RAG (`consult_docs` tool)

For an agent generating Splunk UCC add-ons — deep recall of structured specs (`globalConfig.json` schema, `.conf` spec files, splunklib SDK, Splunk REST, example repos) — **pure 1M-token context stuffing fails at scale**. These docs total thousands of lines across hundreds of stanzas, far exceeding effective utilisation due to:

- "Lost in the middle" degradation (~30%+ accuracy drop for mid-context info).
- Rereading tax: high cost/latency per query (30–60s at scale vs. RAG's ~1s).

### Trade-offs

| Option | Wins | Loses |
|---|---|---|
| **Large context** | Static, small corpora (single schema analysis); low setup. | High per-query cost (scales with full corpus); poor freshness/citations/access control; context rot in 1M+ prompts. |
| **On-demand RAG** | Dynamic, large domain (updating .conf specs); lower cost; built-in citations (audit UCC validity); agentic iteration (re-retrieve for multi-hop). | Setup complexity; embedding quality matters. |

**Hybrid is 2026 best practice** — RAG narrows, long-context reasons.

**Recommendation:** On-demand RAG via `consult_docs` tool for production. Fits agentic workflows, handles Splunk's structured knowledge.

## 2. Best Embedding Model + Chunking for `.conf` Specs

### Embedding Models (2026)

| Model | MTEB | Dims | Max tokens | Notes |
|---|---|---|---|---|
| **Voyage voyage-3-large** | **67.1** | 2048 | 32K | **Top choice.** Excels on code/finance/law-like specs. |
| OpenAI text-embedding-3-large | 64.6 | 3072 | 8K | Solid baseline. |
| Cohere embed-v4 | 66.2 | — | — | Multilingual/code-strong. |
| Jina v4 | — | — | — | Visual/doc retrieval; skip unless multimodal. |

### Chunking Strategy for `.conf` Specs

**Structure-first** — extract per stanza as a chunk (e.g. `modinput://foo` + its keys/validators/types), with metadata:

```json
{ "file": "inputs.conf.spec", "stanza": "modinput", "param": "name" }
```

- Preserves hierarchy; beats fixed-size chunking (which splits validators).
- Retain comments and examples intact for context.
- Stanza-level chunks are naturally self-contained thanks to the `[stanza_name]` + key=value layout.

## 3. Domain-Specific `fact_retrieval` Tool vs. Generic Vector Search

**Yes — build domain-specific tools** like `get_stanza_spec(file, stanza_name)` or `get_param_validator(conf_file, stanza, param)`.

- `.conf` files are structured (stanzas = entities, keys = attributes) → **exact lookup beats fuzzy vectors** for known queries.
- Vector search risks noise on repetitive specs.
- **Hybrid (structured first, vector fallback)** boosts precision **10–20%** per domain-RAG papers (mirrors SMART-SLIC: KG for facts + vector store for unstructured).

## 4. How Cursor / Cody / Claude Code Handle Library API Knowledge

- **Cursor:** Codebase indexing + semantic RAG (background embed entire repo/docs for retrieval); docs injected via `.txt`/help dumps or URL mappings. Not pure training — dynamic RAG.
- **Cody (Sourcegraph):** Explicit RAG — retrieves codebase context on query, injects into LLM.
- **Claude Code (Anthropic):** Large-context reasoning over docs/codebases + tool integration; extracts knowledge from repos (no fine-tuning; relies on prompt injection / self-correction). Anthropic blogs emphasise *context navigation over training*.

**All three use injected docs / RAG, not training-only.** This scales to proprietary APIs like splunklib.

## Key Takeaways

- **Favour agentic RAG + structured tools** for Splunk UCC (cost + accuracy wins). Combine with long-context for synthesis.
- **Voyage-3-large** + stanza-level chunking is the best 2026 embedding stack.
- Add a `get_stanza_spec` fact-retrieval tool **alongside** (not instead of) a vector `consult_docs` tool.
- Cursor/Cody/Claude Code all validate injected-docs-beats-training for API knowledge.

## Implications for UCC App Builder

1. **Three-tier knowledge layer:**
   - **Tier 1 (system prompt):** Short, curated — UCC architecture overview, naming conventions, our tool contract (< 5K tokens).
   - **Tier 2 (structured fact tools):** `get_stanza_spec`, `get_entity_type_info`, `get_splunklib_method`, `get_validator_spec` — fast exact lookups against a SQLite or JSON index built at startup.
   - **Tier 3 (vector RAG via `consult_docs`):** For fuzzy / worked-examples / how-do-I queries, over chunked `.conf` specs, splunklib docstrings, REST API pages, and example add-on READMEs.
2. **Build a one-time ingestion pipeline** (`server/ingestion/`):
   - Parse all `.conf.spec` files from Splunk Enterprise install → stanza-level chunks.
   - Index splunklib docstrings from source.
   - Ingest globalConfig JSON schema fields as facts.
   - Crawl 3–5 Splunk-maintained reference add-on repos for example chunks.
3. **Embedding choice:** Voyage 3 Large for quality tier (matches our cost posture in Q2). Fallback: OpenAI `text-embedding-3-large` for organisations that prohibit Voyage.
4. **Vector store:** Start with **Pinecone** (consistent with aios memory layer) or **sqlite-vec** for self-hosted deployments.
5. **Inject citations into the agent UI** — when the agent uses `consult_docs` or `get_stanza_spec`, surface the source spec/file in the chat. Essential for Splunk-admin trust.
