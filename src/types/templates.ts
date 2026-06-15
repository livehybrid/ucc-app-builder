/**
 * Template Gallery Type Definitions
 *
 * Templates are pre-configured ComponentsConfig extensions that provide
 * production-ready input configurations with Python scripts.
 */

import type { ModularInputConfig, AccountConfig } from './components';

/**
 * Template categories for filtering and organization
 */
export type TemplateCategory =
  | 'rest-api' // REST API polling
  | 'database' // Database queries
  | 'cloud' // AWS, Azure, GCP
  | 'file-system' // File/directory monitoring
  | 'webhook' // Incoming webhooks
  | 'protocol' // SNMP, Syslog, etc.
  | 'custom'; // Other

/**
 * Difficulty level for template selection guidance
 */
type TemplateDifficulty = 'beginner' | 'intermediate' | 'advanced';

/**
 * Template metadata for display and filtering
 */
export interface TemplateMetadata {
  /** Unique identifier (e.g., 'rest-api-polling') */
  id: string;
  /** Display name */
  name: string;
  /** Brief description for card display */
  description: string;
  /** Category for filtering */
  category: TemplateCategory;
  /** Search tags */
  tags: string[];
  /** Difficulty guide */
  difficulty: TemplateDifficulty;
  /** Template version */
  version: string;
  /** Optional author for community templates */
  author?: string;
  /** Emoji icon for visual distinction */
  icon: string;
}

/**
 * Template input with associated Python script
 */
export interface TemplateInput {
  /** Input configuration using existing type */
  config: ModularInputConfig;
  /** Python script template with placeholders */
  pythonScript: string;
  /** Optional UCC helper module script */
  helperScript?: string;
}

/**
 * Template account configuration
 */
export interface TemplateAccount {
  /** Account configuration using existing type */
  config: AccountConfig;
}

/**
 * Complete template definition
 */
export interface Template {
  /** Template metadata */
  metadata: TemplateMetadata;

  /** Pre-configured input(s) */
  inputs: TemplateInput[];

  /** Pre-configured account(s) */
  accounts?: TemplateAccount[];

  /** Recommended configuration settings */
  recommendedTabs?: {
    enableLogging?: boolean;
    enableProxy?: boolean;
  };

  /** Markdown documentation for preview */
  documentation: string;

  /** Prerequisites before using */
  prerequisites?: string[];

  /** What the template adds (for preview) */
  addsSummary: string[];
}

/**
 * Category display info
 */
export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string; icon: string }[] = [
  { id: 'rest-api', label: 'REST API', icon: '🌐' },
  { id: 'database', label: 'Database', icon: '🗃️' },
  { id: 'cloud', label: 'Cloud Services', icon: '☁️' },
  { id: 'file-system', label: 'File System', icon: '📁' },
  { id: 'webhook', label: 'Webhooks', icon: '🔔' },
  { id: 'protocol', label: 'Protocols', icon: '📡' },
  { id: 'custom', label: 'Custom', icon: '⚙️' },
];

/**
 * Difficulty display info
 */
export const DIFFICULTY_INFO: Record<TemplateDifficulty, { label: string; stars: number }> = {
  beginner: { label: 'Beginner', stars: 1 },
  intermediate: { label: 'Intermediate', stars: 2 },
  advanced: { label: 'Advanced', stars: 3 },
};
