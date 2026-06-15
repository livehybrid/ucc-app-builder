/**
 * Canonical base system prompt for the UCC App Builder chat agent.
 *
 * The prompt text lives in `systemPrompt.md` (plain markdown — no escaping) so it
 * is a first-class, diff-friendly artifact the admin trace-analysis tool
 * (scripts/prompt-doctor.ts) can review and edit safely. It is imported here as a
 * raw string via Vite's `?raw` loader. Per-session CONTEXT (current file,
 * globalConfig, errors) is still appended in AIChatPanel.buildSystemMessage().
 */
import promptMarkdown from './systemPrompt.md?raw';

export const SYSTEM_PROMPT = promptMarkdown;
