import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';

export const lintRouter = Router();

/**
 * Python syntax checker for the Monaco editor.
 *
 * Parses the submitted source with `ast.parse` in a python3 subprocess — pure
 * parsing, nothing is executed — and returns the SyntaxError position so the
 * editor can render a squiggle. Free (no LLM involved) and fast (<100ms).
 */
const CHECKER = `
import ast, json, sys
src = sys.stdin.read()
try:
    ast.parse(src)
    print(json.dumps({"ok": True}))
except SyntaxError as e:
    print(json.dumps({
        "ok": False,
        "line": e.lineno or 1,
        "col": e.offset or 1,
        "endLine": getattr(e, "end_lineno", None) or e.lineno or 1,
        "endCol": getattr(e, "end_offset", None) or (e.offset or 1) + 1,
        "msg": e.msg or "invalid syntax",
    }))
`;

const MAX_SOURCE_BYTES = 512 * 1024; // generous for helper scripts
const TIMEOUT_MS = 5000;

lintRouter.post('/lint/python', (req: Request, res: Response) => {
  const code = (req.body as { code?: unknown })?.code;
  if (typeof code !== 'string') {
    res.status(400).json({ error: 'Expected JSON body { code: string }.' });
    return;
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) {
    res.status(413).json({ error: 'Source too large to lint.' });
    return;
  }

  const py = spawn('python3', ['-c', CHECKER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
  });

  let stdout = '';
  let stderr = '';
  py.stdout.on('data', (d) => (stdout += String(d)));
  py.stderr.on('data', (d) => (stderr += String(d)));

  py.on('error', () => {
    // python3 missing — degrade silently; the editor just gets no diagnostics.
    if (!res.headersSent) res.json({ ok: true, unavailable: true });
  });

  py.on('close', () => {
    if (res.headersSent) return;
    try {
      res.json(JSON.parse(stdout.trim()));
    } catch {
      res.json({ ok: true, unavailable: true, detail: stderr.slice(0, 200) });
    }
  });

  py.stdin.write(code);
  py.stdin.end();
});
