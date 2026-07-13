import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { resolveModelProfile } from '../../src/lib/ai/modelProfile.js';
import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { sessionState, type Todo, type Decision } from '../../src/lib/ai/sessionState.js';
import { localDocsIndex } from '../services/localDocsIndex.js';
import {
  applyPatch as applyParsedPatch,
  parsePatch,
  PatchApplyError,
  PatchParseError,
} from '../../src/lib/ai/patch.js';
import {
  formatSplunkSdkEntries,
  searchSplunkSdkReference,
} from '../../src/lib/splunkSdkReference.js';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import uccSchema from '../../src/lib/uccSchema.json' with { type: 'json' };
import { v4 as uuidv4 } from 'uuid';
import { jsonrepair } from 'jsonrepair';
import path from 'path';
import { UCCGenService } from '../services/uccGen.js';
import { FileHandler } from '../utils/fileHandler.js';

const router = Router();
const uccGenForValidation = new UCCGenService();
const fileHandlerForValidation = new FileHandler();

/**
 * Validates a globalConfig.json string against the UCC framework schema.
 * Returns null on success, or a human-readable error message describing the
 * first few violations so the AI can fix them in the next iteration.
 *
 * Why server-side: Monaco's inline validator only flags problems for users
 * looking at the editor — the agent loop never sees those errors. Validating
 * here closes that loop: invalid JSON or schema-violating structure causes
 * write_file/apply_patch to return a clear error string back to the model.
 */
const ajv = new Ajv({ allErrors: true, strict: false });
let uccValidator: ValidateFunction | null = null;
function getUccValidator(): ValidateFunction {
  if (!uccValidator) uccValidator = ajv.compile(uccSchema as Record<string, unknown>);
  return uccValidator;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '';
  return errors
    .slice(0, 8)
    .map((e) => `  - ${e.instancePath || '(root)'}: ${e.message ?? 'invalid'}`)
    .join('\n');
}

function validateGlobalConfigJson(content: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (e: unknown) {
    return `globalConfig.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const validate = getUccValidator();
  const ok = validate(parsed);
  if (!ok) {
    return `globalConfig.json failed UCC schema validation:\n${formatAjvErrors(validate.errors)}\n\nFix the structure and write again.`;
  }

  // Additional checks the schema doesn't enforce
  const namePattern = /^[a-zA-Z0-9_]+$/;
  const errors: string[] = [];
  const pages = parsed.pages as Record<string, unknown> | undefined;
  const services = (pages?.inputs as Record<string, unknown>)?.services;
  if (Array.isArray(services)) {
    for (const svc of services) {
      const s = svc as Record<string, unknown>;
      if (typeof s.name === 'string' && !namePattern.test(s.name)) {
        errors.push(
          `Input service name "${s.name}" is invalid — must match /^[a-zA-Z0-9_]+$/ (no spaces, hyphens, or special chars). Use snake_case like "${s.name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase()}".`
        );
      }
    }
  }
  const tabs = (pages?.configuration as Record<string, unknown>)?.tabs;
  if (Array.isArray(tabs)) {
    for (const tab of tabs) {
      const t = tab as Record<string, unknown>;
      if (typeof t.name === 'string' && !namePattern.test(t.name)) {
        errors.push(
          `Configuration tab name "${t.name}" is invalid — must match /^[a-zA-Z0-9_]+$/.`
        );
      }
    }
  }
  const alerts = parsed.alerts;
  if (Array.isArray(alerts)) {
    for (const alert of alerts) {
      const a = alert as Record<string, unknown>;
      if (typeof a.name === 'string' && !namePattern.test(a.name)) {
        errors.push(
          `Alert name "${a.name}" is invalid — must match /^[a-zA-Z0-9_]+$/.`
        );
      }
    }
  }
  if (errors.length) {
    return `globalConfig.json naming violations:\n${errors.map((e) => '  - ' + e).join('\n')}\n\nFix these names and write again.`;
  }

  return null;
}

function isGlobalConfigPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === 'globalConfig.json' || normalized.endsWith('/globalConfig.json');
}

/**
 * Static guards for AI-generated Python (modular input scripts and helpers).
 * These catch the two most-reported runtime crashes from the AI assistant:
 *
 *   1. `stream_events() takes 2 positional arguments but 3 were given`
 *      — Splunk's Script.run_script calls self.stream_events(input_definition, event_writer).
 *        The AI sometimes writes `def stream_events(self, ew)` with just two params.
 *
 *   2. `'NoneType' object has no attribute 'get_proxy_settings'`
 *      — Setup_util is None because the helper class extends UCC's BaseModInput but
 *        either skips super().__init__() or doesn't extend it at all while still
 *        calling helper.send_http_request / helper.get_proxy.
 *
 * Returns a list of human-readable error strings (empty = pass). Run only on .py
 * files. Designed to be cheap (regex-based, no real Python parsing).
 */
function validatePythonForUccPitfalls(filePath: string, content: string): string[] {
  if (!filePath.endsWith('.py')) return [];
  const errors: string[] = [];

  // Guard 1: stream_events signature on CLASS METHODS must accept three params
  // (self, input_definition, event_writer). We only check class methods — first
  // arg is `self` — because helper modules also define `stream_events(helper, ew)`
  // at module level with a different (correct, two-arg) convention.
  const streamEventsRe = /def\s+stream_events\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = streamEventsRe.exec(content)) !== null) {
    const params = m[1].split(',').map((p) => p.trim()).filter(Boolean);
    const isMethod = params[0] === 'self';
    if (isMethod && params.length < 3) {
      errors.push(
        `\`stream_events\` (class method) must accept three parameters: (self, input_definition, event_writer). ` +
        `Found: \`stream_events(${m[1].trim()})\`. ` +
        `Splunk's modularinput.Script.run_script() calls \`self.stream_events(self._input_definition, event_writer)\` — a 2-arg signature crashes with "takes 2 positional arguments but 3 were given".`,
      );
    }
  }

  // Guard 2: when a script CALLS UCC helper methods through `helper.foo(...)`,
  // the BaseModInput class needs to be wired up SOMEWHERE in the project. We
  // only enforce the BaseModInput import on files that look like main input
  // scripts, NOT helper modules — UCC helpers (`*_helper.py`) are plain
  // function modules that receive `helper` as an argument and forward to it.
  // Forcing them to import BaseModInput causes false-positives that block
  // legitimate writes (the import lives in the matching main script).
  //
  // Heuristic: skip this guard if the file looks like a helper module
  // (filename ends with `_helper.py` OR the file defines no class at all).
  const isHelperModuleFile = /_helper\.py$/.test(filePath);
  const definesAnyClass = /^\s*class\s+\w+\s*\(/m.test(content);
  const isHelperModuleByShape = !definesAnyClass;
  const skipHelperImportCheck = isHelperModuleFile || isHelperModuleByShape;

  // Match `helper.send_http_request(`, requiring the function-call paren so
  // mentions in comments / docstrings don't trip the guard.
  const usesHelperHttpCall = /\bhelper\.(send_http_request|get_proxy|get_proxy_settings|get_arg|new_event)\s*\(/.test(content);
  if (usesHelperHttpCall && !skipHelperImportCheck) {
    const importsBaseModInput = /from\s+splunktaucclib\.modinput_wrapper(\.\w+)?\s+import|import\s+splunktaucclib\.modinput_wrapper/.test(content);
    if (!importsBaseModInput) {
      errors.push(
        `Uses \`helper.send_http_request\` / \`helper.get_proxy\` but doesn't import \`splunktaucclib.modinput_wrapper.base_modinput.BaseModInput\`. ` +
        `These helper methods rely on UCC's setup_util — without the BaseModInput class hierarchy, \`self.setup_util\` is None at runtime ` +
        `("'NoneType' object has no attribute 'get_proxy_settings'"). ` +
        `Add: \`from splunktaucclib.modinput_wrapper.base_modinput import BaseModInput\` and have your input class extend BaseModInput.`,
      );
    }
  }

  // Guard 3: when extending BaseModInput, __init__ must call super().__init__()
  const classExtendsBaseRe = /class\s+(\w+)\s*\(\s*[\w.]*BaseModInput[^)]*\)\s*:/;
  const baseMatch = classExtendsBaseRe.exec(content);
  if (baseMatch) {
    const className = baseMatch[1];
    // Look for a custom __init__ in this class
    const initRe = new RegExp(`class\\s+${className}\\b[\\s\\S]*?def\\s+__init__\\s*\\(([^)]*)\\)\\s*:([\\s\\S]*?)(?=\\n\\s{0,4}def\\s|\\nclass\\s|$)`);
    const initMatch = initRe.exec(content);
    if (initMatch) {
      const initBody = initMatch[2];
      if (!/super\s*\(\s*\)\s*\.\s*__init__\s*\(/.test(initBody)) {
        errors.push(
          `Class \`${className}\` extends BaseModInput and defines \`__init__\` but never calls \`super().__init__(...)\`. ` +
          `That leaves UCC internals (\`setup_util\`, \`_input_definition\`, etc.) uninitialized — \`helper.send_http_request\` and friends will crash with NoneType errors. ` +
          `Either remove the custom \`__init__\` and let it inherit, or call \`super().__init__(*args, **kwargs)\` as the first line.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Extract the app ID (meta.name) from the VFS files. Used by the post-agent
 * build validator to know what to feed ucc-gen. Returns null if globalConfig
 * isn't present or doesn't have a usable name — the validator just no-ops.
 */
function detectAppId(files: Array<{ path: string; content: string }>): string | null {
  const cfg = files.find((f) => f.path.endsWith('globalConfig.json'));
  if (!cfg) return null;
  try {
    const parsed = JSON.parse(cfg.content);
    const name = parsed?.meta?.name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Run python3 to check whether Python source code is syntactically valid.
 * Returns null on success, or the first error line on failure.
 * Silently passes when python3 is not available (ENOENT → null).
 */
async function checkPythonSyntax(filePath: string, content: string): Promise<string | null> {
  if (!filePath.endsWith('.py')) return null;
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      proc.kill();
      resolve(null); // timeout — skip rather than block
    }, 5_000);

    const proc = spawn('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(null);
      } else {
        const msg = stderr.trim() || 'Python syntax error';
        // Return the most informative line — typically the "SyntaxError: ..." or "IndentationError: ..."
        const errorLine = msg.split('\n').find((l) => /Error:/.test(l)) ?? msg.split('\n')[0];
        resolve(errorLine);
      }
    });
    proc.on('error', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(null); // python3 not available — skip check
    });
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

/**
 * Run a real ucc-gen build against the current VFS state and return a
 * structured result. Used as a post-agent validation pass: when the AI loop
 * naturally ends (no more tool calls), we try to actually build the app and
 * surface failures back to the model so it can fix them in additional
 * iterations.
 *
 * Quietly no-ops on environments where ucc-gen isn't installed (returns ok+skipped).
 */
async function runBuildValidation(
  files: Array<{ path: string; content: string }>,
  appId: string,
): Promise<{ ok: boolean; skipped?: boolean; errorSummary: string; logsTail: string[] }> {
  const logs: string[] = [];
  let workDir: string | null = null;
  try {
    workDir = await fileHandlerForValidation.createTempDirectory(`ai-validate-${uuidv4()}`);
    const tmpBase = path.dirname(workDir);
    // Redact tmp paths from logs that the AI will see — prevents the model
    // from trying to write to host filesystem locations later.
    const log = (line: string) =>
      logs.push(line.split(workDir as string).join(appId).split(tmpBase).join('<tmp>'));

    await fileHandlerForValidation.writeFiles(workDir, files);
    await uccGenForValidation.init(workDir, appId, log);
    const version = (() => {
      const cfg = files.find((f) => f.path.endsWith('globalConfig.json'));
      if (!cfg) return '1.0.0';
      try {
        return JSON.parse(cfg.content)?.meta?.version ?? '1.0.0';
      } catch {
        return '1.0.0';
      }
    })();
    await uccGenForValidation.build(workDir, log, version);
    return { ok: true, errorSummary: '', logsTail: logs.slice(-15) };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // ucc-gen missing → skip rather than treat as fail
    if (/ENOENT|not found|no such file|spawn .* ENOENT/i.test(message)) {
      return { ok: true, skipped: true, errorSummary: '', logsTail: [] };
    }
    const errorLogs = logs.filter((l) => /error|fail|invalid|missing/i.test(l)).slice(-10);
    return {
      ok: false,
      errorSummary: errorLogs.length ? errorLogs.join('\n') : message,
      logsTail: logs.slice(-20),
    };
  }
}

/**
 * Last-resort extractor for write_file/create_file tool calls whose JSON is so
 * broken that jsonrepair can't fix it.  Regex-locates the path value, then
 * char-by-char re-escapes the content blob to produce a valid JSON object.
 */
function tryExtractWriteArgs(raw: string): string | null {
  const pathMatch = raw.match(/"(?:path|file_path|filepath)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!pathMatch) return null;
  const pathValue = pathMatch[1];

  const contentKeyRe = /"(?:content|body|text|data)"\s*:\s*"/;
  const contentKeyMatch = contentKeyRe.exec(raw);
  if (!contentKeyMatch || contentKeyMatch.index === undefined) return null;

  const contentValueStart = contentKeyMatch.index + contentKeyMatch[0].length;
  const rawSuffix = raw.slice(contentValueStart);

  // The content value must end with `"` followed by optional whitespace then `}`
  if (!rawSuffix.match(/"\s*}\s*$/)) return null;
  const rawContent = rawSuffix.replace(/"\s*}\s*$/, '');

  let escaped = '';
  for (let i = 0; i < rawContent.length; i++) {
    if (rawContent[i] === '\\' && i + 1 < rawContent.length) {
      escaped += rawContent[i] + rawContent[i + 1];
      i++;
    } else if (rawContent[i] === '"') {
      escaped += '\\"';
    } else {
      escaped += rawContent[i];
    }
  }

  const candidate = `{"path":"${pathValue}","content":"${escaped}"}`;
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Repair malformed tool-call argument JSON from LLMs. Common failures:
 *   - Unquoted property names: {path: "x"} instead of {"path": "x"}
 *   - Invalid escape sequences: \w, \d from Python regex literals
 *   - Embedded raw newlines inside string values
 *   - Markdown fencing: ```json ... ```
 *   - Single quotes instead of double quotes
 *   - Trailing commas
 *
 * Falls back to tryExtractWriteArgs for write_file payloads, then '{}' as a
 * safe sentinel so callers never receive un-parseable JSON (which would cause
 * the provider to reject the next request with a 400).
 */
function repairJsonArguments(raw: string): string {
  if (!raw) return '{}';
  try {
    JSON.parse(raw);
    return raw;
  } catch (originalError) {
    try {
      const repaired = jsonrepair(raw);
      JSON.parse(repaired); // verify it's actually valid
      console.log(
        `[ai] repaired malformed tool-call JSON (${(originalError as Error).message})`
      );
      return repaired;
    } catch {
      const extracted = tryExtractWriteArgs(raw);
      if (extracted) {
        console.log(`[ai] extracted write_file args from broken JSON`);
        return extracted;
      }
      console.error(
        `[ai] tool-call JSON repair failed — original error: ${(originalError as Error).message}`,
        `\n[ai] raw args (first 500 chars): ${raw.slice(0, 500)}`
      );
      return '{}';
    }
  }
}

type OpenAIMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};

type ToolCallChunk = {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  index: number;
};

type AgentTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, vfs: VirtualFileSystem) => Promise<string>;
};

function validatePath(pathValue: string): string | null {
  const path = pathValue.replace(/\\/g, '/');
  const blocked = ['/etc/', '/usr/', '/var/', '/bin/', '/sbin/', '/tmp/', '/home/', '/root/'];
  if (blocked.some((p) => path.startsWith(p))) {
    return 'Security Error: access to system paths is not allowed.';
  }
  if (path.includes('..') || path.includes('.git/') || path.includes('node_modules/')) {
    return 'Security Error: path traversal or hidden/system folders are not allowed.';
  }
  return null;
}

function validateWritePath(pathValue: string): string | null {
  const err = validatePath(pathValue);
  if (err) return err;
  const path = pathValue.replace(/\\/g, '/');
  const isInPackage = path.startsWith('package/') || path.startsWith('/package/') || path.includes('/package/');
  const isGlobalConfig = path === 'globalConfig.json' || path.endsWith('/globalConfig.json');
  if (!isInPackage && !isGlobalConfig) {
    return 'Security Error: write operations are only allowed within package/ or to globalConfig.json.';
  }
  return null;
}

const SPLUNK_HELP: Record<string, string> = {
  modular_inputs:
    'Use splunklib.modularinput Script/Scheme/Argument/Event for modular inputs. Prefer UCC helper modules in package/bin/*_helper.py.',
  accounts:
    'Store API keys and credentials as entity fields in globalConfig.json under pages.inputs.services[].entity. Use type "text" for plain API keys. Access them in the Python helper via input_item["api_key"] or similar.',
  credentials:
    'Same as accounts — store API keys as plain "text" entity fields in globalConfig.json. For OAuth2 use type "oauth". Access from Python via the helper input_item dict.',
  http:
    'Use the requests library for HTTP calls: import requests; resp = requests.get(url, headers={"x-api-key": key}). Add "requests" to requirements.txt. Handle errors with resp.raise_for_status().',
  http_requests:
    'Use requests.get(url, headers={"x-api-key": key}, timeout=30). Add "requests" to requirements.txt. Check resp.status_code and call resp.json() for JSON responses.',
  globalconfig:
    'globalConfig.json structure: {"meta":{...},"pages":{"inputs":{"title":"Inputs","services":[{"name":"my_input","title":"My Input","entity":[{"field":"api_key","label":"API Key","type":"text","required":true}]}]}}}. Write the full updated JSON to globalConfig.json.',
  globalconfig_json:
    'To add a modular input service: set pages.inputs.services to an array with one entry per input type. Each service has name, title, entity (array of field definitions). Field types: text, checkbox, interval, index, singleSelect.',
  validation:
    'Validate in two places: UI schema validators in globalConfig.json and runtime checks in validate_input/stream helper logic.',
  logging:
    'Use Splunk-friendly logging helpers, include actionable context, and never log secrets.',
  error_handling:
    'Wrap network/parse operations with retries and clear logs; fail per-stanza without crashing the whole input.',
  entity_types:
    'Common UCC field types: text, textarea, checkbox, singleSelect, multipleSelect, oauth, interval, index.',
  validators:
    'Common validators: string length, regex, number range, url/email/ipv4/date.',
};

const SERVER_TOOLS: AgentTool[] = [
  {
    name: 'list_files',
    description: 'List files from the current VFS, optionally filtered by directory prefix.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Optional prefix (e.g. package/bin).' },
      },
    },
    execute: async (args, vfs) => {
      const dir = String(args.directory ?? '');
      const files = vfs.listAllFiles().map((f) => f.path).filter((p) => p.startsWith(dir));
      return JSON.stringify(files.slice(0, 500), null, 2);
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the current VFS.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validatePath(path);
      if (err) return err;
      const content = vfs.readFile(path);
      if (content === null) return `Error: File not found: ${path}`;
      return content.length > 20000
        ? `${content.slice(0, 20000)}\n\n... (truncated ${content.length - 20000} chars)`
        : content;
    },
  },
  {
    name: 'write_file',
    description: 'Write full content to a file under package/.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validateWritePath(path);
      if (err) return err;
      const newContent = String(args.content ?? '');
      // Reject schema-invalid globalConfig.json BEFORE writing, so the agent
      // gets actionable feedback (and the file isn't left in a broken state).
      if (isGlobalConfigPath(path)) {
        const schemaErr = validateGlobalConfigJson(newContent);
        if (schemaErr) return `Refused write to ${path}: ${schemaErr}`;
      }
      // Catch the two recurring AI-generated Python bugs (wrong stream_events
      // signature, missing UCC base class) before the user has to discover them
      // at install time.
      const pyErrors = validatePythonForUccPitfalls(path, newContent);
      if (pyErrors.length) {
        return `Refused write to ${path}:\n${pyErrors.map((e) => '  - ' + e).join('\n')}\n\nFix these and retry.`;
      }
      const syntaxErr = await checkPythonSyntax(path, newContent);
      if (syntaxErr) {
        return `Refused write to ${path}: Python syntax error — ${syntaxErr}\n\nFix the indentation/syntax and retry.`;
      }
      vfs.writeFile(path, newContent, 'user');
      return `Successfully wrote to ${path}`;
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file under package/; fails if file exists.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, vfs) => {
      const path = String(args.path ?? '');
      const err = validateWritePath(path);
      if (err) return err;
      if (vfs.readFile(path) !== null) return `Error: ${path} already exists. Use apply_patch to edit it.`;
      const newContent = String(args.content ?? '');
      if (isGlobalConfigPath(path)) {
        const schemaErr = validateGlobalConfigJson(newContent);
        if (schemaErr) return `Refused create of ${path}: ${schemaErr}`;
      }
      const pyErrors = validatePythonForUccPitfalls(path, newContent);
      if (pyErrors.length) {
        return `Refused create of ${path}:\n${pyErrors.map((e) => '  - ' + e).join('\n')}\n\nFix these and retry.`;
      }
      const syntaxErr = await checkPythonSyntax(path, newContent);
      if (syntaxErr) {
        return `Refused create of ${path}: Python syntax error — ${syntaxErr}\n\nFix the indentation/syntax and retry.`;
      }
      vfs.writeFile(path, newContent, 'user');
      return `Created ${path}`;
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply unified-diff style patch envelope to one or more files.',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
    execute: async (args, vfs) => {
      try {
        const parsed = parsePatch(String(args.patch ?? ''));
        for (const op of parsed.files) {
          const err = op.kind === 'delete' ? validatePath(op.path) : validateWritePath(op.path);
          if (err) return err;
        }
        const outcome = applyParsedPatch(parsed, (p) => vfs.readFile(p));
        // Schema-validate any globalConfig.json writes BEFORE committing them.
        // If validation fails, abort the entire patch so we never leave a
        // broken globalConfig in the VFS.
        for (const w of outcome.writes) {
          if (isGlobalConfigPath(w.path)) {
            const schemaErr = validateGlobalConfigJson(w.content);
            if (schemaErr) return `Patch refused: ${schemaErr}`;
          }
          const pyErrors = validatePythonForUccPitfalls(w.path, w.content);
          if (pyErrors.length) {
            return `Patch refused — Python pitfalls in ${w.path}:\n${pyErrors.map((e) => '  - ' + e).join('\n')}`;
          }
          const syntaxErr = await checkPythonSyntax(w.path, w.content);
          if (syntaxErr) {
            return `Patch refused — Python syntax error in ${w.path}: ${syntaxErr}\n\nFix the indentation/syntax and retry.`;
          }
        }
        for (const w of outcome.writes) vfs.writeFile(w.path, w.content, 'user');
        for (const d of outcome.deletes) vfs.delete(d);
        return `Patch applied: ${outcome.summary.join('; ')}`;
      } catch (e: unknown) {
        if (e instanceof PatchParseError || e instanceof PatchApplyError) {
          return `Patch error: ${e.message}`;
        }
        return `Patch error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: 'get_splunklib_help',
    description: 'Get concise Splunk/UCC implementation guidance by topic.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    execute: async (args) => {
      const topic = String(args.topic ?? '').trim().toLowerCase().replace(/[\s-]/g, '_');
      if (SPLUNK_HELP[topic]) return SPLUNK_HELP[topic];
      // Fuzzy: return first entry whose key appears in the query or vice versa
      for (const [key, value] of Object.entries(SPLUNK_HELP)) {
        if (topic.includes(key) || key.split('_').some((w) => topic.includes(w) && w.length > 3)) {
          return `Help for "${key}":\n${value}`;
        }
      }
      const available = Object.keys(SPLUNK_HELP).join(', ');
      return `No help entry for "${topic}". Available topics: ${available}.`;
    },
  },
  {
    name: 'get_splunk_sdk_reference',
    description: 'Search curated Splunk SDK/UCC symbol reference and signatures.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const query = String(args.query ?? '').trim();
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 8)));
      const matches = searchSplunkSdkReference(query, limit);
      if (!matches.length) return `No SDK reference matches found for "${query}".`;
      return `Splunk SDK reference matches for "${query}":\n\n${formatSplunkSdkEntries(matches)}`;
    },
  },
  {
    name: 'validate_ucc_conformance',
    description: 'Validate key UCC structure conventions against current VFS.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, vfs) => {
      const files = vfs.listAllFiles().map((f) => f.path);
      const globalConfigPath =
        files.find((p) => p.endsWith('/globalConfig.json')) || files.find((p) => p === 'globalConfig.json');
      if (!globalConfigPath) return 'UCC conformance: FAIL\n- [ERROR] Missing globalConfig.json';
      const appConfExists = files.some((p) => p.endsWith('/package/default/app.conf'));
      const hasAnyInputScript = files.some((p) => p.endsWith('.py') && p.includes('/package/bin/'));
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!appConfExists) errors.push('Missing package/default/app.conf');
      if (!hasAnyInputScript) warnings.push('No Python scripts under package/bin detected');
      if (errors.length === 0 && warnings.length === 0) return 'UCC conformance: PASS. No issues detected.';
      return [
        `UCC conformance: ${errors.length ? 'FAIL' : 'PASS WITH WARNINGS'}`,
        ...errors.map((e) => `- [ERROR] ${e}`),
        ...warnings.map((w) => `- [WARNING] ${w}`),
      ].join('\n');
    },
  },
  {
    name: 'todo_write',
    description: 'Create/update the agent todo list for progress tracking.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['id', 'content', 'status'],
          },
        },
        merge: { type: 'boolean' },
      },
      required: ['todos'],
    },
    execute: async (args) => {
      const incoming = Array.isArray(args.todos) ? (args.todos as Todo[]) : [];
      const merge = Boolean(args.merge);
      const next = merge ? sessionState.mergeTodos(incoming) : sessionState.setTodos(incoming);
      return `Todo list updated (${next.length} items).`;
    },
  },
  {
    name: 'record_decision',
    description: 'Persist an architectural/user decision for session consistency.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        question: { type: 'string' },
        decision: { type: 'string' },
        rationale: { type: 'string' },
      },
      required: ['id', 'question', 'decision'],
    },
    execute: async (args) => {
      const rec = sessionState.recordDecision({
        id: String(args.id),
        question: String(args.question),
        decision: String(args.decision),
        rationale: String(args.rationale ?? ''),
      });
      return `Decision recorded: (${rec.id}) ${rec.question} -> ${rec.decision}`;
    },
  },
  {
    name: 'read_memory',
    description: 'Read session memory by key or dump a summary.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
    },
    execute: async (args) => {
      const key = String(args.key ?? '');
      if (key) {
        const val = sessionState.getMemory(key);
        return val ?? `No memory entry for "${key}".`;
      }
      return sessionState.summary();
    },
  },
  {
    name: 'write_memory',
    description: 'Write a key/value memory fact for this session.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['key', 'value'],
    },
    execute: async (args) => {
      const key = String(args.key ?? '');
      const value = String(args.value ?? '');
      if (!key) return 'Error: key is required.';
      sessionState.setMemory(key, value);
      return `Saved memory["${key}"] (${value.length} chars).`;
    },
  },
  {
    name: 'run_ucc_gen_build',
    description:
      'Run a real ucc-gen build against the current VFS files and return the result. ' +
      'Use this after completing your changes to verify the app builds without errors before declaring done. ' +
      'Returns "Build succeeded" on success or a detailed error (including IndentationError / SyntaxError lines) on failure.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, vfs) => {
      const allFiles = vfs.getAllFiles();
      const appId = detectAppId(allFiles);
      if (!appId) return 'Error: Cannot determine app ID — globalConfig.json is missing or has no meta.name.';
      const result = await runBuildValidation(allFiles, appId);
      if (result.skipped) return 'ucc-gen is not installed in this environment — build check skipped.';
      if (result.ok) return `Build succeeded.\n\nLast build logs:\n${result.logsTail.join('\n')}`;
      return `Build FAILED.\n\nErrors:\n${result.errorSummary}\n\nBuild logs (last 20 lines):\n${result.logsTail.join('\n')}`;
    },
  },
  {
    name: 'suggest_actions',
    description:
      'Surface 1-3 suggested next-step actions as clickable buttons in the chat UI. ' +
      'Call this at the END of a response (never mid-task) when there are clear follow-on actions the user might want. ' +
      'Each action needs a short button label (≤8 words) and the full prompt to send when clicked.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Suggested next actions to show as buttons.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button label (≤8 words).' },
              prompt: { type: 'string', description: 'Message to send when clicked.' },
            },
            required: ['label', 'prompt'],
          },
          minItems: 1,
          maxItems: 3,
        },
      },
      required: ['actions'],
    },
    execute: async (args) => {
      const actions = Array.isArray(args.actions) ? args.actions : [];
      return JSON.stringify(actions);
    },
  },
  {
    name: 'validate_python_syntax',
    description:
      'Check a Python script for syntax errors using the Python AST parser BEFORE writing it to the VFS. ' +
      'Returns "OK" or a detailed error with the line number. Always call this before write_file for any .py file.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Python source to validate.' },
        filename: { type: 'string', description: 'Filename shown in error messages.' },
      },
      required: ['content'],
    },
    execute: async (args) => {
      const content = String(args.content ?? '');
      const filename = String(args.filename ?? '<string>');
      if (!content.trim()) return 'OK (empty file)';
      const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const py = spawn('python3', ['-c', `import ast, sys; ast.parse(sys.stdin.read(), ${JSON.stringify(filename)})`]);
        let stderr = '';
        py.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        py.stdin.write(content);
        py.stdin.end();
        py.on('close', (code: number) => {
          resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() });
        });
        py.on('error', () => resolve({ ok: false, error: 'python3 not available on this server.' }));
      });
      return result.ok ? `OK — no syntax errors in ${filename}` : `SyntaxError in ${filename}:\n${result.error}`;
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents across the VFS using a regex pattern. Returns matching files with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex or plain-text pattern.' },
        path_filter: { type: 'string', description: 'Optional path substring filter.' },
        case_sensitive: { type: 'boolean', description: 'Default true.' },
      },
      required: ['pattern'],
    },
    execute: async (args, vfs) => {
      const rawPattern = String(args.pattern ?? '');
      if (!rawPattern) return 'Error: pattern is required.';
      const pathFilter = String(args.path_filter ?? '');
      const flags = args.case_sensitive === false ? 'gim' : 'gm';
      let regex: RegExp;
      try { regex = new RegExp(rawPattern, flags); } catch { return `Error: invalid regex "${rawPattern}".`; }
      const results: Array<{ path: string; matches: Array<{ line: number; content: string }> }> = [];
      for (const file of vfs.listAllFiles()) {
        if (pathFilter && !file.path.includes(pathFilter)) continue;
        const content = vfs.readFile(file.path);
        if (!content) continue;
        const lines = content.split('\n');
        const matches: Array<{ line: number; content: string }> = [];
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) { matches.push({ line: i + 1, content: lines[i].trimEnd() }); if (matches.length >= 20) break; }
        }
        if (matches.length > 0) { results.push({ path: file.path, matches }); if (results.length >= 30) break; }
      }
      if (results.length === 0) return `No matches for: ${rawPattern}`;
      const total = results.reduce((s, r) => s + r.matches.length, 0);
      return `Found ${total} match(es) in ${results.length} file(s):\n\n` +
        results.map((r) => `${r.path}:\n${r.matches.map((m) => `  L${m.line}: ${m.content}`).join('\n')}`).join('\n\n');
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file within the VFS. Source is deleted after copy.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
    },
    execute: async (args, vfs) => {
      const src = String(args.source ?? '').trim();
      const dst = String(args.destination ?? '').trim();
      if (!src || !dst) return 'Error: source and destination are required.';
      if (src === dst) return 'Error: source and destination are the same.';
      const content = vfs.readFile(src);
      if (content === null) return `Error: source file not found: ${src}`;
      if (vfs.exists(dst)) return `Error: destination already exists: ${dst}`;
      vfs.writeFile(dst, content, 'user');
      vfs.delete(src);
      return `Moved ${src} → ${dst}`;
    },
  },
  {
    name: 'checkpoint_vfs',
    description: 'Save a named snapshot of the VFS before making large changes.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async (args, vfs) => {
      const name = String(args.name ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!name) return 'Error: name is required.';
      vfs.checkpoint(name);
      return `Checkpoint "${name}" saved (${vfs.listAllFiles().length} files).`;
    },
  },
  {
    name: 'restore_checkpoint',
    description: 'Restore the VFS to a previously saved checkpoint.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    execute: async (args, vfs) => {
      const name = String(args.name ?? '').trim();
      const ok = vfs.restoreCheckpoint(name);
      if (!ok) {
        const avail = vfs.listCheckpoints();
        return avail.length > 0 ? `Checkpoint "${name}" not found. Available: ${avail.join(', ')}` : 'No checkpoints saved.';
      }
      return `Restored checkpoint "${name}" (${vfs.listAllFiles().length} files).`;
    },
  },
];

interface PersistedAgentState {
  todos: Todo[];
  decisions: Decision[];
  memory: Record<string, string>;
}

const AGENT_STATES = new Map<string, PersistedAgentState>();

function loadSessionState(sessionId: string) {
  const current = AGENT_STATES.get(sessionId);
  sessionState.clear();
  if (!current) return;
  sessionState.setTodos(current.todos);
  for (const d of current.decisions) {
    sessionState.recordDecision({
      id: d.id,
      question: d.question,
      decision: d.decision,
      rationale: d.rationale,
    });
  }
  for (const [k, v] of Object.entries(current.memory)) {
    sessionState.setMemory(k, v);
  }
}

function saveSessionState(sessionId: string) {
  AGENT_STATES.set(sessionId, {
    todos: sessionState.getTodos(),
    decisions: sessionState.getDecisions(),
    memory: sessionState.dumpMemory(),
  });
}

function toOpenAIToolFormat(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function writeSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_APIKEY;
}

/**
 * Map common parameter aliases the AI invents to their canonical schema names.
 * Kimi K2 in particular often uses `file_path` where our `read_file` /
 * `write_file` / `create_file` tools declare `path`. Rather than hard-fail and
 * burn an iteration on retry, normalize before executing.
 *
 * Per-tool entries override the generic fallback. Generic aliases (applied to
 * every tool) catch the most common cases.
 */
const ARG_ALIASES: Record<string, Record<string, string>> = {
  read_file:    { file_path: 'path', filepath: 'path', filename: 'path', name: 'path' },
  write_file:   { file_path: 'path', filepath: 'path', filename: 'path', body: 'content', text: 'content', data: 'content' },
  create_file:  { file_path: 'path', filepath: 'path', filename: 'path', body: 'content', text: 'content', data: 'content' },
  list_files:   { path: 'directory', dir: 'directory', folder: 'directory', prefix: 'directory' },
  apply_patch:  { diff: 'patch', changes: 'patch' },
};

function normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const aliases = ARG_ALIASES[toolName];
  if (!aliases) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [from, to] of Object.entries(aliases)) {
    if (out[from] !== undefined && out[to] === undefined) {
      out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}

/**
 * Kimi K2 sometimes emits its native tool-call markup as plain text content
 * instead of using OpenAI's `tool_calls` field. The markup looks like:
 *
 *   <|tool_calls_section_begin|>
 *     <|tool_call_begin|>functions.NAME:IDX<|tool_call_argument_begin|>{...json...}<|tool_call_end|>
 *   <|tool_calls_section_end|>
 *
 * If we send the raw content back to OpenRouter on the next iteration, the
 * provider (e.g. Novita) returns a 400 "invalid request" error. So we:
 *  1. Extract any Kimi tool-call blocks into proper structured tool_calls
 *  2. Strip the markup from the content before storing it in apiMessages
 */
function extractKimiToolCalls(content: string): {
  cleanContent: string;
  extracted: Array<{ id: string; function: { name: string; arguments: string } }>;
} {
  const extracted: Array<{ id: string; function: { name: string; arguments: string } }> = [];
  const callRegex = /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z_][A-Za-z0-9_]*)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
  let match: RegExpExecArray | null;
  let counter = 0;
  while ((match = callRegex.exec(content)) !== null) {
    const name = match[1];
    const args = match[2].trim();
    extracted.push({
      id: `kimi_inline_${Date.now()}_${counter++}`,
      function: { name, arguments: args },
    });
  }
  // Strip ALL Kimi markup so the next provider call doesn't choke.
  const cleanContent = content
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '')
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g, '')
    .replace(/<\|tool_call_argument_begin\|>/g, '')
    .replace(/<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>|<\|tool_call_begin\|>|<\|tool_call_end\|>/g, '')
    .trim();
  return { cleanContent, extracted };
}

async function readOpenRouterStream(
  response: globalThis.Response,
  onDelta: (content: string) => void,
): Promise<{ content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }> {
  if (!response.body) throw new Error('OpenRouter response body is null.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls: Record<number, { id: string; function: { name: string; arguments: string } }> = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls as ToolCallChunk[]) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tc.id || '', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Ignore malformed stream chunks.
      }
    }
  }

  // If Kimi K2 emitted its native tool-call markup as content text instead of
  // using OpenAI's tool_calls field, recover those calls and strip the markup.
  const structuredCalls = Object.values(toolCalls);
  if (structuredCalls.length === 0 && content.includes('<|tool_call')) {
    const { cleanContent, extracted } = extractKimiToolCalls(content);
    return { content: cleanContent, toolCalls: extracted };
  }
  // Always strip Kimi markup from content (even if structured calls were also
  // emitted) so it doesn't poison the next iteration's request payload.
  if (content.includes('<|tool_call')) {
    const { cleanContent } = extractKimiToolCalls(content);
    return { content: cleanContent, toolCalls: structuredCalls };
  }
  return { content, toolCalls: structuredCalls };
}

async function callOpenRouter(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<globalThis.Response> {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://splunk.engineer',
      'X-Title': 'UCCBuilder',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Strip tool-role messages and tool_calls fields from client-supplied history.
 *
 * The client only receives assistant text deltas (assistant_delta SSE), never
 * the full tool_calls blocks that the server maintains internally. As a result,
 * its history contains orphaned `tool` role messages (tool results without a
 * matching assistant tool_use block), which providers reject with a 400.
 * Removing them is safe because the server rebuilds the tool exchange from
 * scratch on every request.
 */
function sanitizeIncomingMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  // Collect IDs of tool_calls that actually appear in assistant messages.
  const knownToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of (msg.tool_calls as Array<{ id: string }> )) {
        if (tc.id) knownToolCallIds.add(tc.id);
      }
    }
  }

  return messages
    .filter((msg) => {
      // Drop tool-result messages whose call ID has no matching assistant tool_call.
      if (msg.role === 'tool') {
        const id = (msg as unknown as { tool_call_id?: string }).tool_call_id ?? '';
        return knownToolCallIds.has(id);
      }
      return true;
    })
    .map((msg) => {
      // Strip tool_calls from assistant messages that have no subsequent tool results.
      // (Leaves well-paired exchanges intact.)
      if (msg.role === 'assistant' && msg.tool_calls) {
        const ids = (msg.tool_calls as Array<{ id: string }>).map((t) => t.id);
        const allResultsPresent = ids.every((id) => {
          // Check if a tool message for this ID exists anywhere in the list
          // (we already filtered orphaned tool messages above).
          return messages.some(
            (m) =>
              m.role === 'tool' &&
              (m as unknown as { tool_call_id?: string }).tool_call_id === id,
          );
        });
        if (!allResultsPresent) {
          const { tool_calls: _dropped, ...rest } = msg as typeof msg & { tool_calls: unknown };
          return rest as OpenAIMessage;
        }
      }
      return msg;
    });
}

/**
 * GET /api/ai/config
 * Returns AI configuration to the frontend.
 * If OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set, the server will proxy requests.
 */
router.get('/ai/config', (_req: Request, res: Response) => {
  const serverManaged = !!openRouterApiKey();
  const profile = resolveModelProfile();
  res.json({
    serverManaged,
    profile: profile.name,
    models: profile.models,
    // Back-compat: the current AIChatPanel still reads `defaultModel`.
    defaultModel: profile.models.executor,
    notes: profile.notes,
    capabilities: {
      dockerToolsEnabled: envFlag('UCC_ENABLE_DOCKER_TOOLS', false),
      browserCheckEnabled: envFlag('UCC_ENABLE_BROWSER_CHECK', false),
      localDocsIndexEnabled: envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true),
    },
  });
});

/**
 * POST /api/ai/chat
 * Proxies chat completion requests to OpenRouter using the server-side API key.
 * Only available when OPENROUTER_API_KEY (or legacy OPENROUTER_APIKEY) is set.
 */
router.post('/ai/chat', async (req: Request, res: Response) => {
  const apiKey = openRouterApiKey();

  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_API_KEY env variable.',
    });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://splunk.engineer',
        'X-Title': 'UCCBuilder',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('AI Proxy Error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/ai/agent/stream
 * Server-side planner/executor loop with SSE streaming.
 */
router.post('/ai/agent/stream', async (req: Request, res: Response) => {
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_API_KEY env variable.',
    });
  }

  const profile = resolveModelProfile();
  const {
    sessionId,
    model,
    system,
    messages,
    files,
    maxIterations,
    autoValidate,
  } = req.body ?? {};

  // The client sends UI messages that include `tool` role results from previous
  // server-side agent loops, but the client never has the matching assistant
  // `tool_calls` blocks (those only live in the server's internal apiMessages).
  // Passing orphaned tool_result messages to the provider causes a 400.
  // Fix: strip all tool-role messages and tool_calls fields from initialMessages;
  // the server rebuilds the tool exchange from scratch each request anyway.
  const initialMessages = sanitizeIncomingMessages(
    Array.isArray(messages) ? (messages as OpenAIMessage[]) : [],
  );
  const systemPrompt = typeof system === 'string' ? system : '';
  const sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId : 'default';
  const selectedModel = typeof model === 'string' && model.trim() ? model : profile.models.executor;
  const plannerModel = profile.models.planner || selectedModel;
  const iterationsLimit = Number.isFinite(Number(maxIterations))
    ? Math.max(1, Math.min(30, Number(maxIterations)))
    : 20;

  // Post-agent build validation: when the AI naturally finishes, run a real
  // ucc-gen build against the resulting VFS and feed any errors back to the
  // agent for up to N fix attempts. Defaults ON in interactive use; the e2e
  // tests set the env flag false (or send autoValidate=false in the body) so
  // the test suite doesn't gain a 30-60s build per run.
  const autoValidateBuild =
    autoValidate === false
      ? false
      : envFlag('UCC_AGENT_AUTO_VALIDATE', true);
  const MAX_BUILD_FIX_ATTEMPTS = 2;
  let buildFixAttempts = 0;
  let agentDidWrite = false;

  const vfs = new VirtualFileSystem();
  const incomingFiles = Array.isArray(files) ? files : [];
  for (const file of incomingFiles) {
    const path = String(file?.path || '');
    const content = String(file?.content || '');
    if (!path) continue;
    vfs.writeFile(path, content, 'user');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    loadSessionState(sid);

    // Planner seam: quick non-tool planning turn.
    const plannerResp = await callOpenRouter(apiKey, {
      model: plannerModel,
      messages: [
        {
          role: 'system',
          content:
            `${systemPrompt}\n\nYou are the planning phase. Produce a concise 2-3 step action plan. ` +
            'Prefer immediate action over exploration. Do NOT include documentation lookup steps unless absolutely necessary. ' +
            'Do not call tools; this is planning only.',
        },
        ...initialMessages,
      ],
      stream: false,
      max_tokens: 400,
    });
    const plannerJson = await plannerResp.json();
    const rawPlannerText = plannerJson?.choices?.[0]?.message?.content || '';
    // Strip Kimi inline tool-call markup BEFORE emitting — the planner model
    // (e.g. kimi-k2) sometimes emits <|tool_call…|> blocks as plain text.
    // We must clean before both displaying to the user and embedding in the executor.
    const { cleanContent: plannerText } = rawPlannerText.includes('<|tool_call')
      ? extractKimiToolCalls(rawPlannerText)
      : { cleanContent: rawPlannerText };
    if (plannerText.trim()) writeSse(res, 'planner', { content: plannerText });

    const apiMessages: OpenAIMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(plannerText
        ? [{ role: 'system', content: `Planner output (follow this unless contradicted by user):\n${plannerText}` }]
        : []),
      ...initialMessages,
    ];

    const openAiTools = toOpenAIToolFormat(SERVER_TOOLS);
    const toolMap = new Map(SERVER_TOOLS.map((t) => [t.name, t]));

    let keepGoing = true;
    let iterations = 0;
    while (keepGoing && iterations < iterationsLimit) {
      iterations++;
      writeSse(res, 'iteration', { index: iterations });

      const execResp = await callOpenRouter(apiKey, {
        model: selectedModel,
        messages: apiMessages,
        stream: true,
        max_tokens: 4096,
        tools: openAiTools,
      });

      if (!execResp.ok) {
        const err = await execResp.text();
        // Provider returns a 400 when the conversation history has a `tool_result`
        // block whose `tool_use_id` doesn't match a `tool_use` in the previous
        // assistant message. This usually means the prior assistant message
        // dropped its tool_calls field (e.g., Kimi inline-tool extraction left
        // empty IDs, or content sanitization removed something it shouldn't have).
        // Recovery: drop the dangling tool messages from history and retry once.
        const isToolUseMismatch =
          execResp.status === 400 &&
          /tool_use_id|tool_use.*tool_result|each .* tool_result block must have/i.test(err);
        if (isToolUseMismatch && apiMessages.length > 1) {
          // Find and prune any orphaned tool messages whose IDs don't appear in
          // the previous assistant message's tool_calls list.
          const lastAssistantIdx = (() => {
            for (let i = apiMessages.length - 1; i >= 0; i--) {
              if (apiMessages[i].role === 'assistant') return i;
            }
            return -1;
          })();
          if (lastAssistantIdx >= 0) {
            const lastAssistant = apiMessages[lastAssistantIdx] as {
              tool_calls?: Array<{ id: string }>;
            };
            const validIds = new Set((lastAssistant.tool_calls ?? []).map((t) => t.id));
            const before = apiMessages.length;
            for (let i = apiMessages.length - 1; i > lastAssistantIdx; i--) {
              const msg = apiMessages[i] as { role: string; tool_call_id?: string };
              if (msg.role === 'tool' && msg.tool_call_id && !validIds.has(msg.tool_call_id)) {
                apiMessages.splice(i, 1);
              }
            }
            if (apiMessages.length < before) {
              writeSse(res, 'warning', {
                message: `Recovered from a provider tool-call linkage error by pruning ${before - apiMessages.length} dangling tool result(s). Retrying.`,
              });
              iterations--; // Don't burn an iteration on the failed call.
              continue;
            }
          }
        }
        const friendly = isToolUseMismatch
          ? `The model provider rejected the conversation because an assistant tool_use block had no matching tool_result (or vice versa). This is usually transient — try again, or use the "Clear Chat" button if it persists. (raw: ${err.slice(0, 300)}...)`
          : `Executor model error (${execResp.status}): ${err}`;
        writeSse(res, 'error', { error: friendly });
        break;
      }

      const { content, toolCalls } = await readOpenRouterStream(execResp, (delta) => {
        writeSse(res, 'assistant_delta', { content: delta });
      });

      apiMessages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls.length
          ? toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                // Repair invalid escape sequences so the stored history stays
                // valid JSON — malformed args cause Novita/other providers to
                // reject the next request with a 400 "invalid_request_error".
                arguments: repairJsonArguments(tc.function.arguments),
              },
            }))
          : undefined,
      });

      if (!toolCalls.length) {
        // Natural end of the agent loop. Before fully exiting, optionally
        // run a real ucc-gen build against the VFS and surface any errors
        // back to the agent for up to MAX_BUILD_FIX_ATTEMPTS more iterations.
        if (
          autoValidateBuild &&
          agentDidWrite &&
          buildFixAttempts < MAX_BUILD_FIX_ATTEMPTS
        ) {
          buildFixAttempts++;
          const filesForBuild = vfs.getAllFiles();
          const detectedAppId = detectAppId(filesForBuild);
          if (!detectedAppId) {
            // Can't validate without an appId — end normally.
            keepGoing = false;
            break;
          }
          writeSse(res, 'build_validation_start', { attempt: buildFixAttempts });
          const result = await runBuildValidation(filesForBuild, detectedAppId);
          if (result.skipped) {
            // ucc-gen not installed — silently skip and end.
            writeSse(res, 'build_validation', { ok: true, skipped: true });
            keepGoing = false;
            break;
          }
          if (result.ok) {
            writeSse(res, 'build_validation', { ok: true, logs: result.logsTail });
            keepGoing = false;
            break;
          }
          // Build failed — feed errors back to the agent for one more pass.
          writeSse(res, 'build_validation', { ok: false, errorSummary: result.errorSummary, logs: result.logsTail });
          apiMessages.push({
            role: 'system',
            content:
              `The build failed (attempt ${buildFixAttempts}/${MAX_BUILD_FIX_ATTEMPTS}). ` +
              `Read these errors carefully and fix the relevant file(s) using write_file or apply_patch. ` +
              `Do NOT re-explore the project — go straight to fixing.\n\n` +
              `Build errors:\n${result.errorSummary}`,
          });
          // Reset write tracker so we don't loop unbounded if the next pass writes nothing.
          agentDidWrite = false;
          continue;
        }
        keepGoing = false;
        break;
      }

      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        const tool = toolMap.get(toolName);
        writeSse(res, 'tool_call', {
          id: toolCall.id,
          name: toolName,
          arguments: toolCall.function.arguments,
        });
        if (!tool) {
          const message = `Tool ${toolName} not available in server loop.`;
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: message,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
          continue;
        }

        let argsObj: Record<string, unknown> = {};
        try {
          const rawArgs = toolCall.function.arguments;
          argsObj = rawArgs ? JSON.parse(repairJsonArguments(rawArgs)) : {};
        } catch (e: unknown) {
          const message = `Invalid tool arguments for ${toolName}: ${e instanceof Error ? e.message : String(e)}`;
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: message,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
          continue;
        }

        // Normalize common parameter aliases the AI sometimes invents
        // (e.g. Kimi K2 uses `file_path` where the schema declares `path`).
        // Without this the tool call hard-fails on a Zod-style key check and
        // the agent burns iterations retrying with the same wrong key.
        argsObj = normalizeToolArgs(toolName, argsObj);

        try {
          const result = await tool.execute(argsObj, vfs);
          saveSessionState(sid);
          // Mark whenever the agent successfully wrote/patched files so the
          // post-loop build validation only runs when there's something to validate.
          if (
            (toolName === 'write_file' || toolName === 'create_file' || toolName === 'apply_patch') &&
            !result.startsWith('Refused') &&
            !result.startsWith('Error') &&
            !result.startsWith('Patch error') &&
            !result.startsWith('Security Error')
          ) {
            agentDidWrite = true;
          }
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: result,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: result });
          if (toolName === 'todo_write') {
            writeSse(res, 'todos', { items: sessionState.getTodos() });
          }
          if (toolName === 'record_decision') {
            writeSse(res, 'decisions', { items: sessionState.getDecisions() });
          }
          if (toolName === 'suggest_actions') {
            const actions = Array.isArray(argsObj.actions) ? argsObj.actions : [];
            writeSse(res, 'suggest_actions', { actions });
          }
        } catch (e: unknown) {
          const message = `Tool ${toolName} failed: ${e instanceof Error ? e.message : String(e)}`;
          apiMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: message,
          });
          writeSse(res, 'tool_result', { id: toolCall.id, name: toolName, content: message });
        }
      }
    }

    if (iterations >= iterationsLimit) {
      writeSse(res, 'warning', { message: `Reached max iterations (${iterationsLimit}).` });
    }

    saveSessionState(sid);
    writeSse(res, 'todos', { items: sessionState.getTodos() });
    writeSse(res, 'decisions', { items: sessionState.getDecisions() });
    writeSse(res, 'files', { files: vfs.getAllFiles() });
    writeSse(res, 'done', { ok: true });
    res.end();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    writeSse(res, 'error', { error: message });
    res.end();
  }
});

/**
 * POST /api/ai/validate-python
 * Run Python's AST parser against submitted source code and return OK or a syntax error.
 */
router.post('/ai/validate-python', async (req: Request, res: Response) => {
  const content = String(req.body?.content ?? '');
  const filename = String(req.body?.filename ?? '<string>');

  if (!content.trim()) {
    res.json({ ok: true });
    return;
  }

  try {
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const py = spawn('python3', ['-c', `import ast, sys; ast.parse(sys.stdin.read(), ${JSON.stringify(filename)})`]);
      let stderr = '';
      py.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      py.stdin.write(content);
      py.stdin.end();
      py.on('close', (code: number) => {
        if (code === 0) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: stderr.trim() });
        }
      });
      py.on('error', () => resolve({ ok: false, error: 'python3 not available on this server.' }));
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * POST /api/ai/context
 * Proxies requests to an external RAG/Context service (e.g., Upstash Context7).
 * Requires CONTEXT_API_URL and optionally CONTEXT_API_KEY.
 */
router.post('/ai/context', async (req: Request, res: Response) => {
  const contextUrl = process.env.CONTEXT_API_URL;
  const contextKey = process.env.CONTEXT_API_KEY;
  const localIndexEnabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  const query = String(req.body?.query ?? '').trim();

  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  if (localIndexEnabled) {
    const localResults = await localDocsIndex.search(query, 8);
    if (localResults.length > 0) {
      return res.json({
        source: 'local-flexsearch',
        results: localResults,
      });
    }
  }

  if (!contextUrl) {
    return res.status(200).json({
      source: localIndexEnabled ? 'local-flexsearch' : 'none',
      results: [],
      note: localIndexEnabled
        ? 'No local match and no external context service configured.'
        : 'Local docs index disabled and CONTEXT_API_URL not configured.',
    });
  }

  try {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (contextKey) {
      headers['Authorization'] = `Bearer ${contextKey}`;
    }

    const response = await fetch(contextUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Context Proxy Error:', message);
    res.status(500).json({ error: message });
  }
});

router.get('/ai/context/local/status', async (_req: Request, res: Response) => {
  const enabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  if (!enabled) {
    return res.json({
      enabled: false,
      reason: 'UCC_ENABLE_LOCAL_DOCS_INDEX=false',
    });
  }
  const stats = await localDocsIndex.stats();
  res.json({
    enabled: true,
    ...stats,
  });
});

router.post('/ai/context/local/rebuild', async (_req: Request, res: Response) => {
  const enabled = envFlag('UCC_ENABLE_LOCAL_DOCS_INDEX', true);
  if (!enabled) {
    return res.status(403).json({ error: 'Local docs index is disabled.' });
  }
  const stats = await localDocsIndex.rebuild();
  res.json({
    rebuilt: true,
    ...stats,
  });
});

export { router as aiRouter };
