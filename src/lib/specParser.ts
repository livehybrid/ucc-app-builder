/**
 * Splunk Spec File Parser
 * Parses .conf.spec files to extract validation rules and documentation
 */

export interface SpecStanza {
  name: string;           // e.g., "monitor://<path>"
  matchType: 'exact' | 'regex' | 'wildcard';
  pattern?: RegExp;
  params: Map<string, SpecParam>;
  description?: string;
}

export interface SpecParam {
  name: string;
  type: string;           // e.g., "boolean", "integer", "string"
  required: boolean;
  defaultValue?: string;
  description: string;
  validations: string[];
}

export interface SpecFile {
  name: string;
  stanzas: SpecStanza[];
}

export class SpecParser {
  /**
   * Parse a raw .spec file content
   */
  parse(filename: string, content: string): SpecFile {
    const stanzas: SpecStanza[] = [];
    let currentStanza: SpecStanza | null = null;
    let currentParam: SpecParam | null = null;

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and comments (except documentation comments starting with *)
      if (!line || (line.startsWith('#') && !line.startsWith('*'))) continue;

      // New Stanza: [stanza_name]
      if (line.startsWith('[') && line.endsWith(']')) {
        const name = line.slice(1, -1);
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

      // Documentation: * Text
      if (line.startsWith('*')) {
        const doc = line.slice(1).trim();
        if (currentParam) {
          currentParam.description += (currentParam.description ? '\n' : '') + doc;
        } else if (currentStanza) {
          currentStanza.description = (currentStanza.description || '') + doc;
        }
        continue;
      }

      // Parameter: key = <type>
      if (line.includes('=') && currentStanza) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=').trim();

        currentParam = {
          name: key.trim(),
          type: value,
          required: false, // Spec files don't explicitly mark required usually
          description: '',
          validations: [],
        };
        currentStanza.params.set(currentParam.name, currentParam);
      }
    }

    return { name: filename, stanzas };
  }

  private determineMatchType(name: string): 'exact' | 'regex' | 'wildcard' {
    if (name.includes('...')) return 'regex'; // regex in spec files often denoted by ... or <var>
    if (name.includes('<') && name.includes('>')) return 'regex';
    if (name === 'default') return 'exact';
    return 'exact';
  }

  private createStanzaPattern(name: string): RegExp | undefined {
    if (this.determineMatchType(name) === 'exact') return undefined;

    // Simple conversion of spec wildcards to regex
    // e.g. monitor://<path> -> monitor:\/\/.*
    let pattern = name
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex chars
      .replace(/<[^>]+>/g, '.*');             // Replace <var> with .*

    return new RegExp(`^${pattern}$`);
  }
}
