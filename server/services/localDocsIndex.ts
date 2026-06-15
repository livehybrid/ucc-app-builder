import fs from 'fs/promises';
import path from 'path';
import { Index } from 'flexsearch';

interface DocChunk {
  id: number;
  source: 'docs' | 'specs' | 'examples';
  path: string;
  title: string;
  text: string;
}

interface SearchResult {
  source: DocChunk['source'];
  path: string;
  title: string;
  snippet: string;
}

const ALLOWED_EXT = new Set([
  '.md',
  '.txt',
  '.conf',
  '.spec',
  '.json',
  '.py',
  '.ts',
  '.tsx',
  '.xml',
  '.yaml',
  '.yml',
]);

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function toRelative(p: string): string {
  const root = process.cwd();
  if (p.startsWith(root)) return path.relative(root, p) || '.';
  return p;
}

function chunkText(text: string, max = 1400): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= max) return [cleaned];

  const paragraphs = cleaned.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if ((buf + '\n\n' + p).length > max) {
      if (buf) chunks.push(buf.trim());
      if (p.length > max) {
        for (let i = 0; i < p.length; i += max) {
          chunks.push(p.slice(i, i + max));
        }
        buf = '';
      } else {
        buf = p;
      }
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf.trim());
  return chunks;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      out.push(...await walkFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    out.push(full);
  }
  return out;
}

class LocalDocsIndex {
  private index = new Index({ tokenize: 'forward', preset: 'match', cache: true });
  private docs = new Map<number, DocChunk>();
  private nextId = 1;
  private initPromise: Promise<void> | null = null;
  private booted = false;

  async ensureReady() {
    if (this.booted) return;
    if (!this.initPromise) this.initPromise = this.build();
    await this.initPromise;
    this.booted = true;
  }

  private async indexPath(basePath: string, source: DocChunk['source']) {
    if (!await pathExists(basePath)) return;
    const files = await walkFiles(basePath);
    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8');
      const chunks = chunkText(text);
      const rel = toRelative(file);
      for (let i = 0; i < chunks.length; i++) {
        const id = this.nextId++;
        const chunk = chunks[i];
        const title = chunks.length > 1 ? `${path.basename(file)}#${i + 1}` : path.basename(file);
        const doc: DocChunk = {
          id,
          source,
          path: rel,
          title,
          text: chunk,
        };
        this.docs.set(id, doc);
        this.index.add(id, `${rel}\n${title}\n${chunk}`);
      }
    }
  }

  private async build() {
    this.index = new Index({ tokenize: 'forward', preset: 'match', cache: true });
    this.docs.clear();
    this.nextId = 1;

    const docsDir = path.join(process.cwd(), 'docs');
    const specsDir = path.join(process.cwd(), 'vendor', 'splunk-spec-files');
    await this.indexPath(docsDir, 'docs');
    await this.indexPath(specsDir, 'specs');

    const examplesDirRaw = process.env.UCC_EXAMPLES_DIR;
    const examplesEnabled = envBool('UCC_ENABLE_EXAMPLES_INDEX', true);
    if (examplesEnabled && examplesDirRaw) {
      const examplesDir = path.isAbsolute(examplesDirRaw)
        ? examplesDirRaw
        : path.join(process.cwd(), examplesDirRaw);
      await this.indexPath(examplesDir, 'examples');
    }
  }

  async search(query: string, limit = 8): Promise<SearchResult[]> {
    await this.ensureReady();
    const ids = this.index.search(query, { limit }) as number[];
    return ids
      .map((id) => this.docs.get(id))
      .filter((d): d is DocChunk => Boolean(d))
      .map((d) => ({
        source: d.source,
        path: d.path,
        title: d.title,
        snippet: d.text.slice(0, 350),
      }));
  }

  async stats() {
    await this.ensureReady();
    let docs = 0;
    let specs = 0;
    let examples = 0;
    for (const d of this.docs.values()) {
      if (d.source === 'docs') docs++;
      else if (d.source === 'specs') specs++;
      else if (d.source === 'examples') examples++;
    }
    return {
      chunks: this.docs.size,
      bySource: { docs, specs, examples },
    };
  }

  async rebuild() {
    this.booted = false;
    this.initPromise = null;
    await this.ensureReady();
    return this.stats();
  }
}

export const localDocsIndex = new LocalDocsIndex();
