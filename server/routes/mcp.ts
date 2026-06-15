/**
 * HTTP MCP-dispatch routes (EXPOSE side, for the Splunk MCP Server).
 *
 * The Splunk MCP Server registers API-execution tools (in the app's
 * tool signatures file) that POST here, so the Splunk AI Assistant can build a
 * UCC add-on by calling our tools — the same engine the in-app chat uses.
 *
 *   GET  /api/mcp/ping            → health
 *   GET  /api/mcp/tools           → tool catalogue (names + schemas)
 *   POST /api/mcp/dispatch        → { tool, args } → runs the tool
 *   POST /api/mcp/:tool           → args in the body → runs the tool (convenience)
 *
 * State is a single in-memory session per server process (one build at a time),
 * matching the in-app builder and the stdio MCP server.
 */
import { Router, Request, Response } from 'express';
import { BuilderSession, BUILDER_TOOLS, handleBuilderTool } from '../mcp/core.js';

const router = Router();

// One shared session for the sidecar process (the Monaco UI reads/writes the
// same files via these endpoints).
const session = new BuilderSession();

router.get('/mcp/ping', async (_req: Request, res: Response) => {
  const result = await handleBuilderTool(session, 'ucc_ping', {});
  res.json(result.data ?? { ok: true });
});

router.get('/mcp/tools', (_req: Request, res: Response) => {
  res.json({ tools: BUILDER_TOOLS });
});

async function run(tool: string, args: Record<string, unknown>, res: Response) {
  if (!BUILDER_TOOLS.some((t) => t.name === tool)) {
    res.status(404).json({ error: `Unknown tool: ${tool}` });
    return;
  }
  try {
    const result = await handleBuilderTool(session, tool, args ?? {});
    res.status(result.isError ? 400 : 200).json({
      tool,
      text: result.text,
      data: result.data ?? null,
      isError: Boolean(result.isError),
    });
  } catch (e) {
    res.status(500).json({ tool, error: (e as Error).message });
  }
}

router.post('/mcp/dispatch', async (req: Request, res: Response) => {
  const { tool, args } = req.body ?? {};
  await run(String(tool ?? ''), (args ?? {}) as Record<string, unknown>, res);
});

/**
 * Build-engine endpoint the Splunk app's ucc_build_and_inspect/ucc_package handlers
 * proxy to. The Splunk side owns the project files (KV) and posts them here; this
 * runs the ucc-gen + AppInspect self-correct loop and returns the trace + any
 * corrected files. Stateless (files in, result out) — distinct from the session-
 * based /mcp/:tool surface used by the standalone UI.
 */
router.post('/mcp/build_engine', async (req: Request, res: Response) => {
  const { appId, version, files, maxIterations, includeWarnings, fixerModel, package: pkg } =
    req.body ?? {};
  if (!appId || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'appId and a non-empty files[] are required' });
    return;
  }
  try {
    const { runAgentLoop } = await import('../services/agentLoop.js');
    const result = await runAgentLoop({
      sessionId: `splunk-${appId}-${Date.now()}`,
      appId: String(appId),
      version: version ? String(version) : '1.0.0',
      files: files.map((f: { path: string; content: string }) => ({ path: f.path, content: f.content })),
      maxIterations: Number.isFinite(Number(maxIterations)) ? Number(maxIterations) : 4,
      includeWarnings: includeWarnings === undefined ? true : Boolean(includeWarnings),
      // Build-loop fixer model from the Configuration → AI Provider tab (build_model).
      fixerModel: fixerModel ? String(fixerModel) : undefined,
    });
    res.json({
      clean: result.clean,
      iterations: result.iterations,
      tarball: pkg ? result.tarball : undefined,
      summary: result.finalSummary,
      trace: result.events.map((e) => `[it${e.iteration}] ${e.kind}: ${e.message}`),
      files: result.files,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post('/mcp/:tool', async (req: Request, res: Response) => {
  await run(req.params.tool, (req.body ?? {}) as Record<string, unknown>, res);
});

export { router as mcpRouter, session as builderSession };
