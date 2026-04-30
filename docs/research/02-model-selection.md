# Q2 — Best LLMs for Planner / Executor / Router Roles (April 2026)

**Source:** Perplexity "Best" mode, Q2 thread.

---

## Model Comparison (April 2026)

Data drawn from public leaderboards (SWE-bench Verified, Terminal-bench, tau-bench, Aider polyglot), provider API docs, and pricing sheets. Scores for DeepSeek V3.5 / Qwen3-Coder 480B are partly proxied from nearest published variants (DeepSeek V3.2 at 74.2% Aider; Qwen3-Coder at 69.6% SWE-bench). tau-bench uses tau2/tau3 variants.

| Model | SWE-bench Verified | Terminal-bench | tau-bench (tau2/3) | Aider polyglot |
|---|---|---|---|---|
| **Claude Opus 4.5** | **80.9%** | 59.3% | ~70% (tau3) | ~72% (est.) |
| **Claude Sonnet 4.5** | 77.2% | 60%+ (TB2.0) | 70%+ (Airline/Retail) | 76% (est.) |
| **GPT-5** | 74.9% | 47.6% | ~60–65% (est.) | 88% |
| **GPT-5 Codex (5.x line, e.g. 5.3)** | **85%** (Pro: 56.8%) | **77.3% (TB2.0)** / 53% | ~65% (est.) | High (81% SWE-Lancer) |
| **Gemini 2.5 Pro** | 63.2% | ~54% (3 Pro; 78% 3.1) | ~65% (est.) | 76.5% |
| **Kimi K2.5** | 65.8% | N/A (strong agentic) | 66.1% (tau2) | ~65% (est.) |
| **DeepSeek V3.5** (V3.2 proxy) | ~74% (est.) | N/A | N/A | 74.2% |
| **Qwen3-Coder 480B** | 69.6% | N/A | 77.5% Retail / 60% Airline | 61.8% |
| **Grok 4 (SOTA add)** | ~80% (est.) | N/A | N/A | 79.6% |
| **GPT-5.3 Codex (SOTA add)** | 85% | 77.3% | ~65–70% (est.) | High |

> Newer SOTA emerging: **Claude Mythos** reportedly ~93.9% SWE, GPT-5.4 in pipeline — but Opus/Codex are currently the most stable for Splunk UCC (Python / .conf / JSON).

## Key Insights

- **Top coders:** Claude Opus 4.5 leads SWE-bench (80.9%), ideal for multi-file Python edits like UCC add-ons. GPT-5.3 Codex excels in terminal/agentic work (77.3%).
- **Tool-calling:** All models have native support; Claude and GPT-5 families shine in multi-step flows (90%+ on tau subsets).
- **Availability:** All listed models are available via OpenRouter except pure closed betas.

## Recommended Stack (for UCC App Builder)

- **PLANNER → Claude Opus 4.5** — Best decomposition/planning (SWE 80.9%, tau ~70%); handles complex tool sequences for UCC workflows.
- **EXECUTOR → GPT-5 Codex (5.3)** — Agentic code-writing leader (85% SWE, 77% Terminal-bench); precise for Python/JSON/conf edits.
- **ROUTER / CONTEXT-SELECTOR → Claude Sonnet 4.5** — Fast and cheap enough for lightweight dispatch (77% SWE, 1M context); strong tool use without Opus cost.

## Cost Estimate per Session (10–15 tool calls)

Assumptions: avg. 8K input / 4K output tokens per call (prompts + files + history); 12 calls total. Blended mix: ~50% Planner (Opus), 40% Executor (Codex), 10% Router (Sonnet).

| Role | Calls | Input price /M | Output price /M | Approx cost |
|---|---|---|---|---|
| Planner (Opus 4.5) | 6 | $5 | $25 | ~$0.36 |
| Executor (GPT-5 Codex) | 5 | $1.50 | $10 | ~$0.17 |
| Router (Sonnet 4.5) | 1 | $3 | $15 | ~$0.03 |
| **Total** |  |  |  | **~$0.56 / session** |

Prompt caching on Anthropic + OpenAI cuts this by 50–75% on repeat sessions.

## Takeaways for UCC App Builder

- **Opus-for-planning + Codex-for-execution + Sonnet-for-routing** is the right quality-tier default.
- **Swap candidates:** Grok 4 for speed-cost trade-offs; Qwen3-Coder 480B for a strong open-weight fallback (licence-friendly for on-prem self-host users).
- **Test on Splunk repos** to measure UCC-specific performance — benchmarks are general-purpose and may over- or under-represent our domain.
- All target models are on OpenRouter → our existing OpenRouter integration in `AIChatPanel.tsx` can support this stack without re-plumbing.
- Current default (`moonshotai/kimi-k2.5`) should move to `anthropic/claude-sonnet-4.5` for the single-model fallback path, with opt-in for the Opus+Codex+Sonnet hydration stack.

## Caveats

- DeepSeek V3.5 and Qwen3-Coder 480B numbers are partly inferred from nearest-version published results.
- Cost estimate excludes caching; real-world cost is lower for multi-turn sessions.
- Mythos / GPT-5.4 should be re-evaluated quarterly — this space moves fast.
