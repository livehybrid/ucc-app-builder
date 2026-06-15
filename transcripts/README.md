# Transcripts — reproducibility evidence

Recorded artifacts proving the agentic AppInspect loop and the MCP server work
end-to-end on the real toolchain (`ucc-gen` 6.4.0 + `splunk-appinspect` 4.2.1).
All three runs are **deterministic and use NO LLM / no network** (`--no-llm` /
`useLlm:false`), so anyone can reproduce them.

| File | What it proves | Reproduce |
|---|---|---|
| `loop-config-only.CLEAN.txt` | A config-only add-on reaches **AppInspect-CLEAN** in 2 iterations (the loop sets `meta.checkForUpdates=false`, rebuilds, goes green). | `npm run loop -- --no-llm` |
| `loop-input-bearing.CLEAN.txt` | An **input-bearing** (modular-input) add-on — the case the §1 fix targets — reaches **CLEAN** in 2 iterations. | `npm run loop -- --no-llm fixtures/input-addon.project.json` |
| `mcp-session.txt` | A full **MCP-server JSON-RPC session**: `initialize` → `tools/list` (5 tools) → `create_addon` → `add_input` (with an encrypted `password` field) → `package_app` → **AppInspect-CLEAN** package. Proves an external agent can build a clean add-on conversationally. | `npx tsx tools/mcp-record.ts` |

Notes:
- Ephemeral build paths have been normalised to `<tmp>/` for stability.
- `future_failure: 2` in the summaries are AppInspect *advisories about a future*
  release (`python.required` on ucc-gen-emitted stanzas); they are not failures and
  do not block a clean package. They are reported honestly rather than suppressed.
