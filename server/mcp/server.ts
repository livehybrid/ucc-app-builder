#!/usr/bin/env tsx
/**
 * UCC App Builder — MCP Server (EXPOSE side).
 *
 * Exposes the builder's actions as MCP tools over stdio so an *external* agent
 * (Claude Desktop, the Splunk AI Assistant, any MCP client) can build a Splunk
 * add-on conversationally:
 *
 *   create_addon   -> start a new UCC add-on project (in memory)
 *   add_input      -> add a modular input to the project
 *   validate_app   -> run the agentic generate -> AppInspect -> auto-fix loop
 *   package_app    -> produce an AppInspect-clean .tar.gz ready to install
 *   list_project   -> show the current project's files
 *
 * Run:  npx tsx server/mcp/server.ts        (stdio)
 * Wire it into an MCP client config as a stdio server with that command.
 *
 * State is a single in-memory project per server process (one conversation =
 * one add-on), which matches how MCP stdio servers are spawned per client.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { VirtualFileSystem } from '../../src/lib/vfs.js';
import { generateSplunkApp } from '../../src/lib/generator.js';
import type { AppMetadata, BrandingConfig } from '../../src/types/app.js';
import {
  type ComponentsConfig,
  type ModularInputConfig,
  DEFAULT_COMPONENTS_CONFIG,
} from '../../src/types/components.js';
import { runAgentLoop, LoopFile } from '../services/agentLoop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
loadEnv({ path: path.join(repoRoot, '.env') });
loadEnv({ path: path.resolve(repoRoot, '..', '..', '.env') });

/** In-memory project for this MCP session. */
interface Project {
  metadata: AppMetadata;
  branding: BrandingConfig;
  components: ComponentsConfig;
}

let project: Project | null = null;

function defaultMetadata(name: string, displayName?: string): AppMetadata {
  const appId = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return {
    name,
    displayName: displayName || name,
    description: `${displayName || name} — built via the UCC App Builder MCP server`,
    author: 'livehybrid',
    email: '',
    version: '1.0.0',
    appId: appId.startsWith('ta_') || appId.startsWith('TA_') ? appId : `TA_${appId}`,
    licenseName: 'Apache-2.0',
    licenseUri: 'https://www.apache.org/licenses/LICENSE-2.0',
  };
}

function emptyComponents(): ComponentsConfig {
  // Deep-ish clone of the default so per-session mutations don't leak.
  return JSON.parse(JSON.stringify(DEFAULT_COMPONENTS_CONFIG)) as ComponentsConfig;
}

/** Render the current project to a VFS file list (the loop's input shape). */
function projectFiles(): LoopFile[] {
  if (!project) throw new Error('No project. Call create_addon first.');
  const vfs = new VirtualFileSystem();
  generateSplunkApp(vfs, {
    metadata: project.metadata,
    branding: project.branding,
    components: project.components,
  });
  return vfs.listAllFiles().map((f) => ({ path: f.path, content: f.content }));
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

const TOOLS = [
  {
    name: 'create_addon',
    description:
      'Create a new Splunk UCC add-on project (in memory). Resets any current project. ' +
      'Provide a name; appId is derived (TA_<name>). Returns the project summary.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Add-on name, e.g. "github_audit".' },
        displayName: { type: 'string', description: 'Human display name.' },
        description: { type: 'string' },
        version: { type: 'string', description: 'Semver, default 1.0.0.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_input',
    description:
      'Add a modular input (data collection) to the current add-on. Creates the input ' +
      'definition + Python handler/helper. Provide a name and optional fields.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Input name (internal id), e.g. "github_repos".' },
        title: { type: 'string', description: 'Display title.' },
        fields: {
          type: 'array',
          description: 'Optional extra config fields for the input.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              label: { type: 'string' },
              type: { type: 'string', description: 'text | password | checkbox | singleSelect | ...' },
              required: { type: 'boolean' },
            },
            required: ['field', 'label'],
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'validate_app',
    description:
      'Run the agentic loop: ucc-gen build -> splunk-appinspect -> auto-fix -> repeat ' +
      'until AppInspect-clean. Returns the loop trace and final report. This is where ' +
      'the self-correction happens. Set maxIterations / includeWarnings to tune.',
    inputSchema: {
      type: 'object',
      properties: {
        maxIterations: { type: 'number' },
        includeWarnings: { type: 'boolean' },
        useLlm: { type: 'boolean', description: 'Allow LLM fixer (needs OPENROUTER_API_KEY).' },
      },
    },
  },
  {
    name: 'package_app',
    description:
      'Build + AppInspect-validate (with auto-fix) and return the path to a clean ' +
      '.tar.gz package ready to install into Splunk. Runs the loop, then reports the tarball.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_project',
    description: 'List the files in the current add-on project (generated from its definition).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleCall(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'create_addon': {
      const meta = defaultMetadata(String(args.name), args.displayName as string | undefined);
      if (args.description) meta.description = String(args.description);
      if (args.version) meta.version = String(args.version);
      project = {
        metadata: meta,
        branding: { navBarColor: '#65A637', logoFile: null },
        components: emptyComponents(),
      };
      return text(
        `Created add-on project.\n  appId: ${meta.appId}\n  displayName: ${meta.displayName}\n  version: ${meta.version}\n\nNext: add_input, then validate_app / package_app.`,
      );
    }

    case 'add_input': {
      if (!project) throw new Error('No project. Call create_addon first.');
      const input: ModularInputConfig = {
        name: String(args.name),
        title: String(args.title ?? args.name),
        entity: Array.isArray(args.fields)
          ? (args.fields as Array<Record<string, unknown>>).map((f) => ({
              field: String(f.field),
              label: String(f.label),
              type: (f.type as ModularInputConfig['entity'][number]['type']) ?? 'text',
              required: Boolean(f.required),
            }))
          : [],
      };
      project.components.inputs.push(input);
      return text(
        `Added input "${input.name}" (${input.entity.length} extra field(s)). Project now has ${project.components.inputs.length} input(s).`,
      );
    }

    case 'list_project': {
      const files = projectFiles();
      return text(
        `Project ${project!.metadata.appId} — ${files.length} files:\n` +
          files.map((f) => `  ${f.path}`).join('\n'),
      );
    }

    case 'validate_app':
    case 'package_app': {
      if (!project) throw new Error('No project. Call create_addon first.');
      const files = projectFiles();
      const result = await runAgentLoop({
        sessionId: `mcp-${project.metadata.appId}-${Date.now()}`,
        appId: project.metadata.appId,
        version: project.metadata.version,
        files,
        maxIterations: Number(args.maxIterations ?? 4),
        includeWarnings: args.includeWarnings === undefined ? true : Boolean(args.includeWarnings),
        useLlm: args.useLlm === undefined ? undefined : Boolean(args.useLlm),
      });
      const trace = result.events
        .map((e) => `  [it${e.iteration}] ${e.kind}: ${e.message}`)
        .join('\n');
      const header =
        `${name} for ${result.appId}: ${result.clean ? 'AppInspect-CLEAN ✅' : 'NOT clean ❌'} ` +
        `after ${result.iterations} iteration(s).`;
      const pkg = name === 'package_app' && result.tarball ? `\n\nPackage: ${result.tarball}` : '';
      return text(`${header}\n\n--- loop trace ---\n${trace}\n\n--- final ---\n${result.finalSummary ?? ''}${pkg}`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: 'ucc-app-builder', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await handleCall(name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so we don't corrupt the stdio JSON-RPC channel.
  process.stderr.write('UCC App Builder MCP server ready (stdio).\n');
}

main().catch((e) => {
  process.stderr.write(`MCP server failed: ${e}\n`);
  process.exit(1);
});
