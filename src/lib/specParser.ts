/**
 * Splunk Spec File Parser
 * Parses .conf.spec files (from $SPLUNK_HOME/etc/system/README/ or the
 * livehybrid/splunk-spec-files submodule) to extract stanza definitions,
 * parameter names/types, documentation, and default values.
 */

interface SpecStanza {
  name: string; // e.g., "monitor://<path>", "<spec>"
  matchType: 'exact' | 'regex' | 'wildcard';
  pattern?: RegExp;
  params: Map<string, SpecParam>;
  description?: string;
}

interface SpecParam {
  name: string;
  type: string; // e.g., "<boolean>", "<integer>", "<string>"
  required: boolean;
  defaultValue?: string;
  description: string;
  validations: string[];
}

interface SpecFile {
  name: string;
  stanzas: SpecStanza[];
}

export class SpecParser {
  /**
   * Parse a raw .spec file content into structured stanza/param definitions
   */
  parse(filename: string, content: string): SpecFile {
    const stanzas: SpecStanza[] = [];
    let currentStanza: SpecStanza | null = null;
    let currentParam: SpecParam | null = null;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimEnd();
      const trimmed = line.trim();

      // Skip blank lines
      if (!trimmed) {
        // A blank line after documentation can signal end of a param doc block
        // but we keep currentParam for continued * lines
        continue;
      }

      // Skip comment lines (lines starting with #)
      if (trimmed.startsWith('#')) continue;

      // New Stanza: [stanza_name]
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const name = trimmed.slice(1, -1);
        currentStanza = {
          name,
          matchType: this.determineMatchType(name),
          pattern: this.createStanzaPattern(name),
          params: new Map(),
        };
        stanzas.push(currentStanza);
        currentParam = null;
        continue;
      }

      // Documentation line: starts with * (common in Splunk spec files)
      if (trimmed.startsWith('*')) {
        const doc = trimmed.slice(1).trim();

        // Check for "Default:" lines to extract default values
        const defaultMatch = doc.match(/^Default(?:\s*\(.*?\))?:\s*(.+)/i);
        if (defaultMatch && currentParam) {
          currentParam.defaultValue = defaultMatch[1].trim();
        }

        if (currentParam) {
          currentParam.description += (currentParam.description ? '\n' : '') + doc;
        } else if (currentStanza) {
          currentStanza.description = (currentStanza.description || '') + '\n' + doc;
        }
        continue;
      }

      // Parameter definition: key = <type> or key = value1|value2|...
      // Must be inside a stanza and contain '='
      if (trimmed.includes('=') && currentStanza) {
        const eqIndex = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();

        // Skip lines that look like documentation continuation or examples
        // (e.g., lines with very long descriptions or lines inside comments)
        if (
          !key ||
          (key.includes(' ') && !key.includes('-') && !key.includes('.') && !key.includes('<'))
        ) {
          // This might be a continuation line, not a real param definition
          // Append to current param description if we have one
          if (currentParam) {
            currentParam.description += (currentParam.description ? '\n' : '') + trimmed;
          }
          continue;
        }

        currentParam = {
          name: key,
          type: value,
          required: false,
          description: '',
          defaultValue: undefined,
          validations: [],
        };
        currentStanza.params.set(currentParam.name, currentParam);
        continue;
      }

      // Continuation lines (indented text that belongs to current doc)
      if (line.startsWith(' ') || line.startsWith('\t')) {
        const continuationText = trimmed;
        if (currentParam) {
          // Check for "Default:" in continuation lines
          const defaultMatch = continuationText.match(/^Default(?:\s*\(.*?\))?:\s*(.+)/i);
          if (defaultMatch) {
            currentParam.defaultValue = defaultMatch[1].trim();
          }
          currentParam.description += (currentParam.description ? '\n' : '') + continuationText;
        } else if (currentStanza) {
          currentStanza.description = (currentStanza.description || '') + '\n' + continuationText;
        }
      }
    }

    return { name: filename, stanzas };
  }

  private determineMatchType(name: string): 'exact' | 'regex' | 'wildcard' {
    if (name.includes('...')) return 'regex';
    if (name.includes('<') && name.includes('>')) return 'regex';
    if (name === 'default') return 'exact';
    return 'exact';
  }

  private createStanzaPattern(name: string): RegExp | undefined {
    if (this.determineMatchType(name) === 'exact') return undefined;

    // Replace ... (Splunk's "match anything" wildcard) FIRST
    const withDots = name.replace(/\.\.\./g, '___DOTDOTDOT___');

    // Replace <var> placeholders before escaping regex chars
    const withPlaceholders = withDots.replace(/<[^>]+>/g, '___WILDCARD___');

    // Escape regex special characters in the literal parts
    const escaped = withPlaceholders.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Replace our placeholders with appropriate patterns
    const pattern = escaped
      .replace(/___DOTDOTDOT___/g, '.*') // ... matches anything (including empty)
      .replace(/___WILDCARD___/g, '.+'); // <var> matches one or more chars

    return new RegExp(`^${pattern}$`);
  }
}
