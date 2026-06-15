import { useCallback, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import TextArea from '@splunk/react-ui/TextArea';
import Switch from '@splunk/react-ui/Switch';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { variables } from '@splunk/themes';
import { VirtualFileSystem } from '../lib/vfs';
import { generateSplunkApp } from '../lib/generator';
import { parseSpec, EXAMPLE_SPECS } from '../lib/specToComponents';
import { runBuildLoop, type LoopEvent, type LoopResult } from '../lib/api';

/**
 * LoopPanel — the agentic AppInspect loop, surfaced in the UI (the demo money-shot).
 *
 * Flow: natural-language spec -> deterministic parse to a UCC project -> stream the
 * keystone loop (ucc-gen build -> splunk-appinspect -> auto-fix -> re-run) live ->
 * land AppInspect-CLEAN with a downloadable package. The deterministic (no-LLM) path
 * is the default so this is reproducible and hermetic for tests/demo.
 */

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow-y: auto;
`;

const Card = styled.div`
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 8px;
  padding: 16px;
`;

const Row = styled.div`
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
`;

const ExampleRow = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0;
`;

const Timeline = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 380px;
  overflow-y: auto;
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.82rem;
`;

const EventRow = styled.div<{ $kind: string }>`
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 6px 10px;
  border-radius: 4px;
  border-left: 3px solid
    ${({ $kind }) =>
      $kind === 'clean'
        ? '#5cb85c'
        : $kind === 'build_error' || $kind === 'exhausted' || $kind === 'fix_skipped'
          ? '#d9534f'
          : $kind === 'fix'
            ? '#f0ad4e'
            : $kind === 'inspect'
              ? '#5bc0de'
              : 'rgba(255,255,255,0.15)'};
  background: rgba(255, 255, 255, 0.03);
`;

const IterTag = styled.span`
  color: ${variables.contentColorMuted};
  flex-shrink: 0;
  min-width: 42px;
`;

const KindTag = styled.span<{ $kind: string }>`
  font-weight: 700;
  flex-shrink: 0;
  min-width: 96px;
  color: ${({ $kind }) =>
    $kind === 'clean'
      ? '#5cb85c'
      : $kind === 'build_error' || $kind === 'exhausted'
        ? '#d9534f'
        : $kind === 'fix'
          ? '#f0ad4e'
          : variables.contentColorDefault};
`;

const Muted = styled.span`
  color: ${variables.contentColorMuted};
  font-size: 0.8rem;
`;

const MutedP = styled.p`
  color: ${variables.contentColorMuted};
  margin-top: 4px;
`;

const Summary = styled.pre`
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 12px;
  font-size: 0.78rem;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
`;

const ICONS: Record<string, string> = {
  start: '🟢',
  iteration: '🔁',
  build: '🔨',
  build_error: '💥',
  package: '📦',
  inspect: '🔎',
  fix: '🩹',
  fix_skipped: '⚠️',
  clean: '✅',
  exhausted: '🛑',
  done: '🏁',
};

export function LoopPanel() {
  const [spec, setSpec] = useState(EXAMPLE_SPECS[0].spec);
  const [useLlm, setUseLlm] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const parsed = useMemo(() => parseSpec(spec), [spec]);

  const run = useCallback(async () => {
    setRunning(true);
    setEvents([]);
    setResult(null);
    setError(null);

    // 1) Generate the UCC project from the parsed spec (deterministic).
    const vfs = new VirtualFileSystem();
    generateSplunkApp(vfs, parsed);
    const files = vfs
      .listAllFiles()
      .filter((f) => !/\.(png|jpg|jpeg|gif|ico)$/i.test(f.path))
      .map((f) => ({ path: f.path, content: f.content }));
    const id = parsed.metadata.appId;
    setAppId(id);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // 2) Stream the agentic loop and render events live.
      const res = await runBuildLoop({
        sessionId: `ui-${id}-${Date.now()}`,
        appId: id,
        version: parsed.metadata.version,
        files,
        includeWarnings: true,
        useLlm,
        onEvent: (e) => setEvents((prev) => [...prev, e]),
        signal: controller.signal,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [parsed, useLlm]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  return (
    <Wrap data-testid="loop-panel">
      <Card>
        <Heading level={3}>AppInspect Build Loop (deterministic)</Heading>
        <MutedP>
          The same build → <code>ucc-gen build</code> → <code>splunk-appinspect</code> → auto-fix →
          re-run loop the <strong>AI Agent</strong> drives via its <code>build_and_inspect</code>{' '}
          tool — here as a standalone, deterministic surface (no LLM by default, so it is
          reproducible for tests/demos). For the full conversational experience, use the{' '}
          <strong>AI Agent</strong> panel.
        </MutedP>

        <ExampleRow>
          {EXAMPLE_SPECS.map((ex) => (
            <Button
              key={ex.label}
              appearance="secondary"
              label={ex.label}
              disabled={running}
              onClick={() => setSpec(ex.spec)}
            />
          ))}
        </ExampleRow>

        <TextArea
          data-testid="loop-spec"
          value={spec}
          onChange={(_e, { value }) => setSpec(value)}
          rowsMin={3}
          disabled={running}
          style={{ width: '100%' }}
        />

        <Row style={{ marginTop: 12 }}>
          <Button
            data-testid="loop-run"
            appearance="primary"
            label={running ? 'Building…' : 'Build & self-correct'}
            disabled={running || !spec.trim()}
            onClick={run}
          />
          {running && <Button appearance="default" label="Stop" onClick={stop} />}
          {running && <WaitSpinner size="medium" />}
          <Switch
            value="llm"
            selected={useLlm}
            onClick={() => setUseLlm((v) => !v)}
            appearance="toggle"
            disabled={running}
          >
            Use LLM fixer (Claude)
          </Switch>
          <Muted>
            target: <code>{parsed.metadata.appId}</code>
          </Muted>
        </Row>
      </Card>

      {error && (
        <Message type="error" data-testid="loop-error">
          {error}
        </Message>
      )}

      {events.length > 0 && (
        <Card>
          <Heading level={4}>Loop trace {appId && <Muted>· {appId}</Muted>}</Heading>
          <Timeline data-testid="loop-timeline">
            {events.map((e, i) => (
              <EventRow key={i} $kind={e.kind} data-kind={e.kind}>
                <IterTag>it{e.iteration}</IterTag>
                <KindTag $kind={e.kind}>
                  {ICONS[e.kind] ?? '•'} {e.kind}
                </KindTag>
                <span>{e.message}</span>
              </EventRow>
            ))}
          </Timeline>
        </Card>
      )}

      {result && (
        <Card data-testid="loop-result">
          <Row>
            {result.clean ? (
              <Message type="success" data-testid="loop-clean">
                AppInspect-CLEAN after {result.iterations} iteration(s).
              </Message>
            ) : (
              <Message type="warning" data-testid="loop-notclean">
                Not clean after {result.iterations} iteration(s) — see trace above.
              </Message>
            )}
          </Row>
          {result.finalSummary && <Summary>{result.finalSummary}</Summary>}
          {result.tarball && (
            <p style={{ marginTop: 8, fontSize: '0.82rem' }}>
              Package: <code>{result.tarball.split('/').pop()}</code>
            </p>
          )}
        </Card>
      )}
    </Wrap>
  );
}
