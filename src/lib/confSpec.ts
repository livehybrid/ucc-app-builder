/**
 * Splunk `.conf.spec` parser.
 *
 * Splunk ships a `.conf.spec` text file for every configuration file (inputs,
 * props, transforms, savedsearches, etc.). Each spec has the shape:
 *
 *   # Global preamble comments
 *   [<stanza>]
 *   * Optional leading comment describing the stanza
 *   setting = <value>
 *   * Description of setting (may span multiple lines, prefixed with *)
 *
 * We parse these into a structured index so the agent can ask
 *   get_stanza_spec("inputs.conf", "script://...")
 * and get back the list of valid settings + their docs + defaults. This
 * replaces embeddings-based RAG for the core "what settings exist?" question,
 * which is the 80% case — fully self-hostable, zero external services.
 */

export interface SpecSetting {
  name: string;
  /** Right-hand side of the `name = value` declaration (the canonical form / hints). */
  rhs: string;
  /** Default value if the spec lists one. */
  default?: string;
  /** Doc comment lines immediately following the setting, prefixed with `*`. */
  doc: string;
}

export interface SpecStanza {
  /** Stanza header, verbatim, without the brackets. */
  name: string;
  /** Description — the `*` lines that appear above or immediately under the stanza header. */
  doc: string;
  settings: SpecSetting[];
}

export interface ParsedSpec {
  /** File-level preamble comments. */
  preamble: string;
  stanzas: SpecStanza[];
}

export function parseConfSpec(text: string): ParsedSpec {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const preambleLines: string[] = [];
  const stanzas: SpecStanza[] = [];

  let i = 0;
  // 1. Preamble — `#` comments before any stanza.
  while (i < lines.length && !lines[i].trimStart().startsWith('[')) {
    preambleLines.push(lines[i]);
    i++;
  }

  // 2. Stanzas.
  while (i < lines.length) {
    const headerLine = lines[i].trim();
    if (!headerLine.startsWith('[')) {
      i++;
      continue;
    }
    const headerMatch = headerLine.match(/^\[(.*)\]\s*$/);
    if (!headerMatch) {
      i++;
      continue;
    }
    const stanza: SpecStanza = {
      name: headerMatch[1],
      doc: '',
      settings: [],
    };
    i++;
    // Collect doc comments immediately after the header, terminated by a blank
    // line or a setting line.
    const docLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trimStart().startsWith('*')) {
        docLines.push(l.trimStart().replace(/^\*+\s?/, ''));
        i++;
      } else {
        break;
      }
    }
    stanza.doc = docLines.join('\n').trim();

    // 3. Settings — key = value; docs as `*` lines *below* the setting.
    while (i < lines.length) {
      const l = lines[i];
      const trimmed = l.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        i++;
        continue;
      }
      if (trimmed.startsWith('[')) break;

      const settingMatch = l.match(/^\s*([A-Za-z0-9_.<>:\-*+?/\\[\]]+)\s*=\s*(.*)$/);
      if (!settingMatch) {
        i++;
        continue;
      }
      const setting: SpecSetting = {
        name: settingMatch[1],
        rhs: settingMatch[2].trim(),
        doc: '',
      };
      i++;

      const settingDocLines: string[] = [];
      while (i < lines.length) {
        const ld = lines[i];
        const td = ld.trimStart();
        if (td.startsWith('*')) {
          settingDocLines.push(td.replace(/^\*+\s?/, ''));
          i++;
        } else {
          break;
        }
      }
      const doc = settingDocLines.join('\n').trim();
      setting.doc = doc;

      // Extract `Defaults to X` / `Default: X` if present. Anchored so we
      // don't match "The default host value." style prose.
      const defaultMatch = doc.match(/\bDefault(?:s)?\s*(?:to\b|:)\s*([^\n.]+)/i);
      if (defaultMatch) setting.default = defaultMatch[1].trim();

      stanza.settings.push(setting);
    }

    stanzas.push(stanza);
  }

  return {
    preamble: preambleLines.join('\n').trim(),
    stanzas,
  };
}

/**
 * In-memory index of parsed `.conf.spec` files.
 *
 * Exposed via server API / agent tool. Populated at server startup from a
 * spec directory (by default the `data/splunk-confs/` folder bundled with the
 * app, which ships with Splunk 10.2 specs).
 */
export class ConfSpecIndex {
  private files = new Map<string, ParsedSpec>();

  /** e.g. register("inputs.conf.spec", text) */
  register(fileName: string, text: string): void {
    const normalised = fileName.replace(/\.spec$/i, '').replace(/^.*\//, '');
    this.files.set(normalised, parseConfSpec(text));
  }

  listConfs(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  listStanzas(confName: string): string[] | null {
    const spec = this.files.get(normaliseConfName(confName));
    if (!spec) return null;
    return spec.stanzas.map((s) => s.name);
  }

  getStanza(confName: string, stanzaName: string): SpecStanza | null {
    const spec = this.files.get(normaliseConfName(confName));
    if (!spec) return null;
    // Exact first; then glob-like pattern (Splunk spec stanzas are often like
    // `script://<path>` — the agent might ask for "script" so we fall back to
    // a prefix/substring match).
    const exact = spec.stanzas.find((s) => s.name === stanzaName);
    if (exact) return exact;
    const prefix = spec.stanzas.find((s) => s.name.startsWith(stanzaName));
    if (prefix) return prefix;
    const contains = spec.stanzas.find((s) => s.name.includes(stanzaName));
    return contains ?? null;
  }

  getSetting(confName: string, stanzaName: string, settingName: string): SpecSetting | null {
    const stanza = this.getStanza(confName, stanzaName);
    if (!stanza) return null;
    return stanza.settings.find((s) => s.name === settingName) ?? null;
  }
}

function normaliseConfName(name: string): string {
  return name.replace(/\.spec$/i, '').replace(/^.*\//, '');
}

/** Module-level singleton, populated by the server at boot. */
export const confSpecIndex = new ConfSpecIndex();
