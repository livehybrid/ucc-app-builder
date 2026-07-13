/**
 * Input Emulator UI - fill an input's params + account/credential values, then run the
 * generated collection logic (server-side, real HTTP, no install) and see the events it
 * would index. The "understand the data first" step before authoring props/transforms.
 */
import { useMemo, useState } from 'react';
import Modal from '@splunk/react-ui/Modal';
import Button from '@splunk/react-ui/Button';
import Text from '@splunk/react-ui/Text';
import Select from '@splunk/react-ui/Select';
import Switch from '@splunk/react-ui/Switch';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import type { VirtualFileSystem } from '../lib/vfs';
import { generateInputHelperScript } from '../lib/generator';

const API_BASE = (window as unknown as { __UCC_API_BASE__?: string }).__UCC_API_BASE__ || '/api';

interface EmulatedEvent {
  data: string;
  source?: string;
  sourcetype?: string;
  index?: string;
}
interface EmulateResult {
  ok: boolean;
  events?: EmulatedEvent[];
  logs?: string[];
  count?: number;
  truncated?: boolean;
  error?: string;
  trace?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  vfs: VirtualFileSystem;
}

interface DiscoveredInput {
  name: string;
  /** Path to the input's helper .py, or null when only declared in globalConfig (barebones). */
  path: string | null;
  hasHelper: boolean;
}

/**
 * Discover inputs to emulate: real helper files (`…/package/bin/<input>_helper.py`) UNION the
 * inputs declared in globalConfig.json. The latter lets a barebones project (only
 * globalConfig.json - the agent authored it but the helper boilerplate isn't generated until
 * build) still be tested: we run a generated skeleton for those.
 */
/** A bin/*.py file counts as collection code if it defines a collect_events/stream_events. */
const COLLECTION_FN = /\bdef\s+(?:collect_events|stream_events)\b/;

function discoverInputs(vfs: VirtualFileSystem): DiscoveredInput[] {
  const files = vfs.getAllFiles();
  const byName = new Map<string, DiscoveredInput>();
  // 1. AOB/UCC helper files: package/bin/<input>_helper.py.
  for (const f of files) {
    if (/\/package\/bin\/[^/]+_helper\.py$/.test(f.path)) {
      const name = (f.path.split('/').pop() || '').replace(/_helper\.py$/, '');
      byName.set(name, { name, path: f.path, hasHelper: true });
    }
  }
  try {
    const gc = files.find((f) => f.path.endsWith('globalConfig.json'));
    if (gc) {
      for (const svc of (JSON.parse(gc.content)?.pages?.inputs?.services ?? []) as Array<{
        name?: unknown;
      }>) {
        const name = svc?.name ? String(svc.name) : '';
        if (!name || byName.has(name)) continue;
        // 2. The input's OWN script: package/bin/<input>.py with a collection function. The
        //    agent often writes the modular input as <input>.py (a Script subclass or a
        //    module-level stream_events) rather than the _helper.py boilerplate - recognise
        //    it as real collection code instead of falsely reporting "barebones".
        const script = files.find(
          (f) => f.path.endsWith(`/package/bin/${name}.py`) && COLLECTION_FN.test(f.content || '')
        );
        if (script) byName.set(name, { name, path: script.path, hasHelper: true });
        else byName.set(name, { name, path: null, hasHelper: false });
      }
    }
  } catch {
    /* ignore malformed globalConfig */
  }
  return [...byName.values()];
}

/** The project's appId (globalConfig meta.name, else first path segment) - for writing a stub. */
function appIdOf(vfs: VirtualFileSystem): string {
  const files = vfs.getAllFiles();
  const gc = files.find((f) => f.path.endsWith('globalConfig.json'));
  if (gc) {
    try {
      const id = JSON.parse(gc.content)?.meta?.name;
      if (id) return String(id);
    } catch {
      /* fall through */
    }
  }
  return files[0] ? files[0].path.replace(/^\/+/, '').split('/')[0] : 'TA_app';
}

/** Best-effort: seed arg names from globalConfig (the input's entity fields + account fields). */
function seedArgNames(vfs: VirtualFileSystem, inputName: string): string[] {
  try {
    const gc = vfs.getAllFiles().find((f) => f.path.endsWith('globalConfig.json'));
    if (!gc) return [];
    const cfg = JSON.parse(gc.content);
    const names = new Set<string>();
    for (const svc of cfg?.pages?.inputs?.services ?? []) {
      if (svc?.name === inputName) {
        for (const e of svc?.entity ?? []) if (e?.field) names.add(String(e.field));
      }
    }
    for (const tab of cfg?.pages?.configuration?.tabs ?? []) {
      for (const e of tab?.entity ?? []) if (e?.field) names.add(String(e.field));
    }
    names.delete('name');
    return [...names];
  } catch {
    return [];
  }
}

export function InputEmulator({ open, onClose, vfs }: Props) {
  // `vfs` is a STABLE instance (App holds it in useState and mutates it in place, bumping a
  // separate version counter), so we cannot depend on its identity to re-discover. Re-run
  // discovery each time the modal opens so inputs authored after first mount are found.
  const inputs = useMemo(() => (open ? discoverInputs(vfs) : []), [vfs, open]);
  const [selected, setSelected] = useState('');
  const [argRows, setArgRows] = useState<Array<{ name: string; value: string }>>([]);
  const [index, setIndex] = useState('main');
  const [proxy, setProxy] = useState({
    enabled: false,
    host: '',
    port: '8080',
    username: '',
    password: '',
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<EmulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickInput = (name: string) => {
    setSelected(name);
    setResult(null);
    setError(null);
    const seeded = seedArgNames(vfs, name).map((n) => ({ name: n, value: '' }));
    setArgRows(seeded.length ? seeded : [{ name: '', value: '' }]);
  };

  const setRow = (i: number, patch: Partial<{ name: string; value: string }>) =>
    setArgRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const selectedInput = inputs.find((i) => i.name === selected);
  const usingStub = !!selectedInput && !selectedInput.hasHelper;

  /** Add a starter helper for a globalConfig-only input to the project so it persists. */
  const addStarterHelper = () => {
    if (!selectedInput) return;
    vfs.writeFile(
      `${appIdOf(vfs)}/package/bin/${selectedInput.name}_helper.py`,
      generateInputHelperScript(selectedInput.name),
      'generated'
    );
    onClose();
  };

  const run = async () => {
    const input = inputs.find((i) => i.name === selected);
    if (!input) return;
    // Use the real helper when present; for a barebones input (declared in globalConfig but
    // no helper yet) run a generated SKELETON so the harness has something to execute (it
    // logs and emits no events until collection logic is written).
    const helperCode = input.path
      ? vfs.getAllFiles().find((f) => f.path === input.path)?.content || ''
      : generateInputHelperScript(input.name);
    const args: Record<string, string> = { __input_name__: selected };
    for (const r of argRows) if (r.name.trim()) args[r.name.trim()] = r.value;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/emulate/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ helperCode, args, index, proxy: proxy.enabled ? proxy : null }),
      });
      const data = (await res.json()) as EmulateResult;
      if (!data.ok) setError(data.error || 'Emulation failed.');
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      style={{ width: 780, maxWidth: '94%' }}
      returnFocus={() => {}}
    >
      <Modal.Header title="Test Input - emulate stream_events" />
      <Modal.Body>
        <Message type="info" style={{ marginBottom: 12 }}>
          Runs the input's collection code with the values you provide (real HTTP, no install) and
          shows the events it would index - so you can see the data before writing props/transforms.
        </Message>

        {inputs.length === 0 ? (
          <p style={{ color: '#9b9ea3' }}>
            No modular inputs found. Author <code>globalConfig.json</code> with an input (via the
            wizard or the AI), then come back to test it.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 10 }}>
              <label
                style={{
                  fontSize: '0.8rem',
                  color: '#9b9ea3',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                Input
                <Select value={selected} onChange={(_e, { value }) => pickInput(String(value))}>
                  {inputs.map((i) => (
                    <Select.Option key={i.name} label={i.name} value={i.name} />
                  ))}
                </Select>
              </label>
              <label
                style={{
                  fontSize: '0.8rem',
                  color: '#9b9ea3',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                Index
                <Text value={index} onChange={(_e, { value }) => setIndex(value)} />
              </label>
            </div>

            {selected && usingStub && (
              <Message type="warning" style={{ marginBottom: 10 }}>
                This input has no collection code yet (only declared in globalConfig.json). Running
                it uses a generated skeleton - it logs but emits no events until you implement the
                collection logic.
                <div style={{ marginTop: 8 }}>
                  <Button
                    appearance="default"
                    onClick={addStarterHelper}
                    label={`Add starter helper for ${selected}`}
                  />
                </div>
              </Message>
            )}

            {selected && (
              <>
                <div style={{ fontSize: '0.8rem', color: '#9b9ea3', marginBottom: 4 }}>
                  Parameters &amp; credentials
                </div>
                {argRows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                    <Text
                      value={r.name}
                      onChange={(_e, { value }) => setRow(i, { name: value })}
                      placeholder="field"
                      style={{ flex: 1 }}
                    />
                    <Text
                      value={r.value}
                      onChange={(_e, { value }) => setRow(i, { value })}
                      placeholder="value"
                      style={{ flex: 2 }}
                    />
                    <Button
                      appearance="destructive"
                      onClick={() => setArgRows((p) => p.filter((_, idx) => idx !== i))}
                      label="✕"
                    />
                  </div>
                ))}
                <Button
                  appearance="default"
                  onClick={() => setArgRows((p) => [...p, { name: '', value: '' }])}
                  label="+ field"
                />

                <div style={{ marginTop: 10 }}>
                  <Switch
                    selected={proxy.enabled}
                    onClick={() => setProxy((p) => ({ ...p, enabled: !p.enabled }))}
                    appearance="checkbox"
                  >
                    Use proxy
                  </Switch>
                  {proxy.enabled && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <Text
                        value={proxy.host}
                        onChange={(_e, { value }) => setProxy((p) => ({ ...p, host: value }))}
                        placeholder="host"
                      />
                      <Text
                        value={proxy.port}
                        onChange={(_e, { value }) => setProxy((p) => ({ ...p, port: value }))}
                        placeholder="port"
                      />
                      <Text
                        value={proxy.username}
                        onChange={(_e, { value }) => setProxy((p) => ({ ...p, username: value }))}
                        placeholder="user"
                      />
                      <Text
                        value={proxy.password}
                        onChange={(_e, { value }) => setProxy((p) => ({ ...p, password: value }))}
                        placeholder="pass"
                        type="password"
                      />
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 12 }}>
                  <Button
                    appearance="primary"
                    onClick={run}
                    disabled={running}
                    icon={running ? <WaitSpinner /> : undefined}
                    label={running ? 'Running…' : '▶ Run emulation'}
                  />
                </div>
              </>
            )}

            {error && (
              <Message type="error" style={{ marginTop: 12 }}>
                {error}
                {result?.trace ? (
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{result.trace}</pre>
                ) : null}
              </Message>
            )}

            {result?.ok && (
              <div style={{ marginTop: 12 }}>
                <Message type="success" style={{ marginBottom: 8 }}>
                  {result.count} event{result.count === 1 ? '' : 's'} captured
                  {result.truncated ? ' (truncated)' : ''}.
                </Message>
                <pre
                  style={{
                    maxHeight: 240,
                    overflow: 'auto',
                    background: '#1e1e1e',
                    color: '#e8e8e8',
                    padding: 10,
                    borderRadius: 6,
                    fontSize: '0.78rem',
                  }}
                >
                  {(result.events || [])
                    .map(
                      (e, i) =>
                        `# event ${i + 1} (sourcetype=${e.sourcetype || ''}, index=${e.index || ''})\n${e.data}`
                    )
                    .join('\n\n')}
                </pre>
                {result.logs && result.logs.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: '#9b9ea3' }}>
                      Logs ({result.logs.length})
                    </summary>
                    <pre style={{ fontSize: '0.75rem', color: '#9b9ea3' }}>
                      {result.logs.join('\n')}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button appearance="default" onClick={onClose} label="Close" />
      </Modal.Footer>
    </Modal>
  );
}
