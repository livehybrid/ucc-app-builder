import { useState, useEffect } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Select from '@splunk/react-ui/Select';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import Badge from '@splunk/react-ui/Badge';
import { variables } from '@splunk/themes'; // used in styled-components

// ── Types ──────────────────────────────────────────────────────────────────

type DeploymentTarget = 'splunkbase' | 'cloud_victoria' | 'cloud_classic' | 'enterprise';
type OutputFormat = 'json' | 'junitxml';

interface CheckMessage {
  filename?: string;
  line?: number;
  message: string;
  result: string;
}

interface AppInspectCheck {
  name: string;
  description: string;
  result: 'success' | 'failure' | 'warning' | 'skipped' | 'error' | 'not_applicable';
  tags: string[];
  messages: CheckMessage[];
}

interface AppInspectReport {
  summary: {
    Status: string;
    failure: number;
    warning: number;
    success: number;
    skipped: number;
    error: number;
  };
  checks: AppInspectCheck[];
}

interface AppInspectPanelProps {
  buildId: string;
  onFixItRequest: (prompt: string) => void;
}

// ── Styled components ──────────────────────────────────────────────────────

const Section = styled.div`
  margin-top: 16px;
  border-top: 1px solid ${variables.borderColor};
  padding-top: 16px;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
`;

const ControlRow = styled.div`
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-bottom: 12px;
`;

const ControlGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
`;

const ControlLabel = styled.span`
  font-size: 0.75rem;
  color: ${variables.contentColorMuted};
  font-weight: 500;
`;

const SummaryBar = styled.div`
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  margin-bottom: 12px;
`;

const SummaryItem = styled.div`
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 0.8rem;
  color: ${variables.contentColorMuted};
`;

const ResultList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 360px;
  overflow-y: auto;
`;

const CheckCard = styled.div<{ $result: string }>`
  border-radius: 4px;
  border-left: 3px solid ${({ $result }) =>
    $result === 'failure' || $result === 'error' ? '#D32F2F'
    : $result === 'warning' ? '#E65100'
    : '#65A637'};
  background: rgba(0, 0, 0, 0.12);
  padding: 8px 12px;
`;

const CheckHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
`;

const CheckName = styled.code`
  font-size: 0.75rem;
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  color: ${variables.contentColorDefault};
  word-break: break-all;
`;

const CheckDescription = styled.p`
  font-size: 0.75rem;
  color: ${variables.contentColorMuted};
  margin: 4px 0 0 0;
`;

const CheckMessages = styled.ul`
  margin: 6px 0 0 0;
  padding-left: 16px;
  list-style: disc;
`;

const CheckMessage = styled.li`
  font-size: 0.72rem;
  color: ${variables.contentColorMuted};
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
  word-break: break-all;
`;

const DownloadRow = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 8px;
`;

// ── Helpers ────────────────────────────────────────────────────────────────

const TARGET_LABELS: Record<DeploymentTarget, string> = {
  splunkbase:     'SplunkBase (Public)',
  cloud_victoria: 'Splunk Cloud — Victoria',
  cloud_classic:  'Splunk Cloud — Classic',
  enterprise:     'Self-hosted Enterprise',
};

function resultColor(result: string): string {
  if (result === 'failure' || result === 'error') return '#D32F2F';
  if (result === 'warning') return '#E65100';
  return '#65A637';
}

function buildFixItPrompt(check: AppInspectCheck): string {
  const lines: string[] = [
    `## AppInspect failure: \`${check.name}\``,
    '',
    `**Description:** ${check.description}`,
  ];
  if (check.messages.length > 0) {
    lines.push('', '**Failures:**');
    for (const m of check.messages) {
      const location = m.filename
        ? `${m.filename}${m.line != null ? `:${m.line}` : ''}`
        : null;
      lines.push(`- ${location ? `\`${location}\` — ` : ''}${m.message}`);
    }
  }
  lines.push('', 'Please fix this issue in my Splunk app.');
  return lines.join('\n');
}

// ── Component ──────────────────────────────────────────────────────────────

export function AppInspectPanel({ buildId, onFixItRequest }: AppInspectPanelProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [target, setTarget] = useState<DeploymentTarget>('splunkbase');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('json');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<AppInspectReport | null>(null);
  const [junitXml, setJunitXml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch('/api/appinspect/available')
      .then((r) => r.json())
      .then((d: { available: boolean }) => setAvailable(d.available))
      .catch(() => setAvailable(false));
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setReport(null);
    setJunitXml(null);
    setError(null);
    setShowAll(false);
    try {
      const res = await fetch('/api/appinspect/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildId, target, outputFormat }),
      });
      if (outputFormat === 'junitxml') {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? 'AppInspect failed');
        } else {
          setJunitXml(await res.text());
        }
      } else {
        const body = await res.json();
        if (!res.ok) setError((body as { error?: string }).error ?? 'AppInspect failed');
        else setReport(body as AppInspectReport);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const handleDownloadXml = () => {
    if (!junitXml) return;
    const blob = new Blob([junitXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'appinspect-results.xml';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (available === false) {
    return (
      <Section>
        <Heading level={5} style={{ margin: '0 0 8px 0', color: '#9b9ea3' }}>
          AppInspect
        </Heading>
        <Message type="warning">
          <code>splunk-appinspect</code> is not installed. Install with:{' '}
          <code>pip install splunk-appinspect</code>
        </Message>
      </Section>
    );
  }

  // Sort: failures/errors first, then warnings, then success/skipped
  const checks = report?.checks ?? [];
  const failures = checks.filter((c) => c.result === 'failure' || c.result === 'error');
  const warnings = checks.filter((c) => c.result === 'warning');
  const passes = checks.filter((c) => c.result === 'success' || c.result === 'skipped' || c.result === 'not_applicable');
  const visibleChecks = showAll ? [...failures, ...warnings, ...passes] : [...failures, ...warnings];

  return (
    <Section>
      <SectionHeader>
        <Heading level={5} style={{ margin: 0, color: '#9b9ea3' }}>
          AppInspect {available === null && <WaitSpinner size="small" />}
        </Heading>
      </SectionHeader>

      <ControlRow>
        <ControlGroup>
          <ControlLabel>Deployment target</ControlLabel>
          <Select
            value={target}
            onChange={(_e, { value }) => setTarget(value as DeploymentTarget)}
            style={{ minWidth: 200 }}
          >
            {(Object.entries(TARGET_LABELS) as [DeploymentTarget, string][]).map(([val, label]) => (
              <Select.Option key={val} label={label} value={val} />
            ))}
          </Select>
        </ControlGroup>

        <ControlGroup>
          <ControlLabel>Output format</ControlLabel>
          <Select
            value={outputFormat}
            onChange={(_e, { value }) => setOutputFormat(value as OutputFormat)}
            style={{ minWidth: 140 }}
          >
            <Select.Option label="JSON (interactive)" value="json" />
            <Select.Option label="JUnit XML (download)" value="junitxml" />
          </Select>
        </ControlGroup>

        <Button
          appearance="primary"
          onClick={handleRun}
          disabled={running || available === null}
          label={running ? 'Running…' : 'Run AppInspect'}
        />
        {running && <WaitSpinner />}
      </ControlRow>

      {error && <Message type="error">{error}</Message>}

      {junitXml && (
        <DownloadRow>
          <Message type="success">AppInspect complete — JUnit XML ready.</Message>
          <Button appearance="default" onClick={handleDownloadXml} label="Download XML" />
        </DownloadRow>
      )}

      {report && (
        <>
          <SummaryBar>
            <SummaryItem>
              <Badge label={`${report.summary.failure} failure${report.summary.failure !== 1 ? 's' : ''}`}
                style={{ backgroundColor: report.summary.failure > 0 ? '#D32F2F' : '#555' }} />
            </SummaryItem>
            <SummaryItem>
              <Badge label={`${report.summary.warning} warning${report.summary.warning !== 1 ? 's' : ''}`}
                style={{ backgroundColor: report.summary.warning > 0 ? '#E65100' : '#555' }} />
            </SummaryItem>
            <SummaryItem>
              <Badge label={`${report.summary.success} passed`} style={{ backgroundColor: '#65A637' }} />
            </SummaryItem>
            <SummaryItem style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#9b9ea3' }}>
              {TARGET_LABELS[target]}
            </SummaryItem>
          </SummaryBar>

          {report.summary.failure === 0 && report.summary.warning === 0 && (
            <Message type="success">All checks passed for {TARGET_LABELS[target]}.</Message>
          )}

          {visibleChecks.length > 0 && (
            <ResultList>
              {visibleChecks.map((check) => (
                <CheckCard key={check.name} $result={check.result}>
                  <CheckHeader>
                    <div style={{ flex: 1 }}>
                      <Badge
                        label={check.result.toUpperCase()}
                        style={{ backgroundColor: resultColor(check.result), marginRight: 6, fontSize: '0.65rem' }}
                      />
                      <CheckName>{check.name}</CheckName>
                    </div>
                    {(check.result === 'failure' || check.result === 'error' || check.result === 'warning') && (
                      <Button
                        appearance="secondary"
                        label="Fix it"
                        onClick={() => onFixItRequest(buildFixItPrompt(check))}
                        style={{ flexShrink: 0, fontSize: '0.72rem' }}
                      />
                    )}
                  </CheckHeader>
                  {check.description && (
                    <CheckDescription>{check.description}</CheckDescription>
                  )}
                  {check.messages.length > 0 && (
                    <CheckMessages>
                      {check.messages.slice(0, 5).map((m, i) => (
                        <CheckMessage key={i}>
                          {m.filename && <><strong>{m.filename}{m.line != null ? `:${m.line}` : ''}</strong> — </>}
                          {m.message}
                        </CheckMessage>
                      ))}
                      {check.messages.length > 5 && (
                        <CheckMessage>…and {check.messages.length - 5} more</CheckMessage>
                      )}
                    </CheckMessages>
                  )}
                </CheckCard>
              ))}
            </ResultList>
          )}

          {passes.length > 0 && (
            <div style={{ marginTop: 8, textAlign: 'center' }}>
              <Button
                appearance="secondary"
                label={showAll ? 'Hide passed checks' : `Show ${passes.length} passed checks`}
                onClick={() => setShowAll((s) => !s)}
              />
            </div>
          )}
        </>
      )}
    </Section>
  );
}
