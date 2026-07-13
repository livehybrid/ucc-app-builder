/**
 * Assembles the full AI system message from static sections (role, UCC knowledge,
 * Python knowledge) and dynamic runtime context (current app, VFS files, globalConfig).
 *
 * Static sections live in ./role.ts, ./ucc-knowledge.ts, ./python-knowledge.ts.
 * Edit those files to tune the assistant's behaviour or domain knowledge.
 * Only add code here when it must reference runtime state (context / vfs / aiConfig).
 */

import { ROLE_SECTION } from './role';
import { UCC_KNOWLEDGE_SECTION } from './ucc-knowledge';
import { PYTHON_KNOWLEDGE_SECTION } from './python-knowledge';
import type { VirtualFileSystem } from '../../vfs';

interface PromptContext {
  currentFile?: string;
  currentFileContent?: string;
  globalConfig?: string;
  errors?: string[];
  appName?: string;
}

interface AiCapabilities {
  dockerToolsEnabled?: boolean;
  browserCheckEnabled?: boolean;
  localDocsIndexEnabled?: boolean;
}

interface AiConfig {
  serverManaged?: boolean;
  defaultModel?: string;
  profile?: string;
  capabilities?: AiCapabilities;
}

export function buildSystemMessage(
  context: PromptContext | undefined,
  vfs: VirtualFileSystem,
  aiConfig: AiConfig | null,
): string {
  let system = `# AI Assistant for Splunk UCC App Development\n\n`;
  system += ROLE_SECTION;
  system += `\n\n`;
  system += UCC_KNOWLEDGE_SECTION;
  system += `\n\n`;
  system += PYTHON_KNOWLEDGE_SECTION;

  // --- Dynamic context sections below ---

  if (context?.appName) {
    system += `\n\n## App Structure\n**App Name:** ${context.appName}\n`;
    system += `**Important:** All file paths in this project are relative to the virtual file system root.\n`;
    system += `The standard UCC file structure is:\n`;
    system += `- \`globalConfig.json\` - Main UCC configuration (at root)\n`;
    system += `- \`package/bin/\` - Python helper scripts (e.g., \`input1_helper.py\`)\n`;
    system += `- \`package/lib/\` - Shared Python libraries\n`;
    system += `- \`package/default/\` - Default .conf files\n\n`;
    system += `**CRITICAL:** When asked to modify files like \`input1_helper.py\`, use the EXACT path from the "Project Files" list below. Do NOT create nested folders or guess paths.`;
  }

  if (context?.currentFile) {
    system += `\n\n## Current Context\nUser is editing: ${context.currentFile}`;
  }

  if (context?.currentFileContent) {
    system += `\n\nFile content:\n\`\`\`\n${context.currentFileContent.substring(0, 4000)}\n\`\`\``;
  }

  if (context?.globalConfig) {
    try {
      const config = JSON.parse(context.globalConfig);
      let summary = '\n\n## Existing Components (READ ONLY)\n';

      if (config.pages?.inputs?.services?.length > 0) {
        summary += '**Modular Inputs:**\n';
        config.pages.inputs.services.forEach((s: { name: string; title: string }) => {
          summary += `- "${s.name}" (${s.title})\n`;
        });
      }

      if (config.alerts?.length > 0) {
        summary += '**Alert Actions:**\n';
        config.alerts.forEach((a: { name: string; label: string }) => {
          summary += `- "${a.name}" (${a.label})\n`;
        });
      }

      const accountTabs = config.pages?.configuration?.tabs?.filter(
        (t: { name: string; title: string }) => t.name === 'account' || t.name === 'aws_account',
      );
      if (accountTabs?.length > 0) {
        summary += '**Configuration Tabs:**\n';
        accountTabs.forEach((t: { name: string; title: string }) => {
          summary += `- "${t.name}" (${t.title})\n`;
        });
      }

      system += summary;
      system += `\n**CRITICAL INSTRUCTION:**\nBefore suggesting NEW inputs or alerts, you MUST check the list above.\n- If a similar component exists, ASK the user: "I see an existing input '${config.pages?.inputs?.services?.[0]?.name}'. Should I use that one or create a new one?"\n- DO NOT blindly create new inputs if one might already exist.\n- If you create a new input, use a unique name that doesn't conflict.`;
    } catch {
      // Ignore parse errors — globalConfig may be mid-edit
    }

    system += `\n\n## Current globalConfig.json\nThis file defines all inputs, accounts, and settings for the app. Study it to understand existing components:\n\`\`\`json\n${context.globalConfig.substring(0, 8000)}\n\`\`\``;
  }

  if (context?.errors && context.errors.length > 0) {
    system += `\n\nCurrent errors:\n${context.errors.join('\n')}`;
  }

  if (aiConfig?.capabilities) {
    const dockerEnabled = Boolean(aiConfig.capabilities.dockerToolsEnabled);
    const browserEnabled = Boolean(aiConfig.capabilities.browserCheckEnabled);
    const docsEnabled = Boolean(aiConfig.capabilities.localDocsIndexEnabled);
    system += `\n\n## Tool Capability Flags`;
    system += `\n- Docker install tooling: ${dockerEnabled ? 'ENABLED' : 'DISABLED'}`;
    system += `\n- Browser-check tooling: ${browserEnabled ? 'ENABLED' : 'DISABLED'}`;
    system += `\n- Local docs index: ${docsEnabled ? 'ENABLED' : 'DISABLED'}`;
    if (!dockerEnabled) system += `\n- Do NOT call install_to_splunk_docker when disabled.`;
    if (!browserEnabled) system += `\n- Do NOT call browser_check when disabled.`;
    if (!docsEnabled) system += `\n- consult_documentation may rely on external context service only.`;
  }

  const files = vfs.listAllFiles().map((f) => f.path);
  if (files.length > 0) {
    system += `\n\n## Project Files (use these EXACT paths)\n${files.join('\n')}`;
  }

  return system;
}
