/**
 * Template Registry
 *
 * Central registry of all available templates.
 * Import and register templates here to make them available in the gallery.
 */

import type { Template, TemplateCategory } from '../types/templates';
import { restApiPollingTemplate } from './rest-api-polling';

/**
 * All registered templates
 */
export const TEMPLATES: Template[] = [
  restApiPollingTemplate,
  // Add more templates here as they are created:
  // paginatedApiTemplate,
  // oauth2ApiTemplate,
  // databaseQueryTemplate,
  // fileMonitorTemplate,
  // awsCloudWatchTemplate,
];

/**
 * Get all templates
 */
export function getAllTemplates(): Template[] {
  return TEMPLATES;
}

/**
 * Get template by ID
 */
export function getTemplateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.metadata.id === id);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: TemplateCategory): Template[] {
  return TEMPLATES.filter((t) => t.metadata.category === category);
}

/**
 * Search templates by query string
 */
export function searchTemplates(query: string): Template[] {
  const lowerQuery = query.toLowerCase().trim();
  if (!lowerQuery) return TEMPLATES;

  return TEMPLATES.filter((t) => {
    const searchableText = [
      t.metadata.name,
      t.metadata.description,
      ...t.metadata.tags,
      t.metadata.category,
    ]
      .join(' ')
      .toLowerCase();

    return searchableText.includes(lowerQuery);
  });
}

/**
 * Get unique categories that have templates
 */
export function getAvailableCategories(): TemplateCategory[] {
  const categories = new Set<TemplateCategory>();
  TEMPLATES.forEach((t) => categories.add(t.metadata.category));
  return Array.from(categories);
}
