import { useState, useEffect } from 'react';
import styled from 'styled-components';
import Button from '@splunk/react-ui/Button';
import Heading from '@splunk/react-ui/Heading';
import Message from '@splunk/react-ui/Message';
import Progress from '@splunk/react-ui/Progress';
import Badge from '@splunk/react-ui/Badge';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import { variables } from '@splunk/themes';
import {
  checkHealth,
  getUCCVersion,
  startBuild,
  waitForBuild,
  downloadBuild,
  type BuildStatus,
  type UCCVersionInfo,
} from '../lib/api';
import type { VFSNode } from '../types/vfs';

interface BuildPanelProps {
  files: VFSNode;
  appId: string;
  onClose?: () => void;
}

const PanelContainer = styled.div`
  background: ${variables.backgroundColorDialog};
  border: 1px solid ${variables.borderColor};
  border-radius: 6px;
  flex-shrink: 0;
`;

const PanelHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid ${variables.borderColor};
`;

const PanelContent = styled.div`
  padding: 16px;
`;

const StatusRow = styled.div`
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
  align-items: center;
`;

const StatusItem = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`;

const BuildControls = styled.div`
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
`;

const BuildLogs = styled.pre`
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 12px;
  max-height: 200px;
  overflow-y: auto;
  font-size: 0.75rem;
  margin: 0;
  font-family: 'Splunk Platform Mono', Inconsolata, Consolas, monospace;
`;

function flattenVFS(node: VFSNode, basePath = ''): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (node.type === 'file' && node.content !== undefined) {
    files.push({ path: basePath || node.name, content: node.content });
  } else if (node.type === 'directory' && node.children) {
    for (const child of node.children.values()) {
      const childPath = basePath ? `${basePath}/${child.name}` : child.name;
      files.push(...flattenVFS(child, childPath));
    }
  }
  return files;
}

export function BuildPanel({ files, appId, onClose }: BuildPanelProps) {
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [uccVersion, setUccVersion] = useState<UCCVersionInfo | null>(null);
  const [buildStatus, setBuildStatus] = useState<BuildStatus | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function checkBackend() {
      const healthy = await checkHealth();
      setBackendStatus(healthy ? 'online' : 'offline');
      if (healthy) {
        const version = await getUCCVersion();
        setUccVersion(version);
      }
    }
    checkBackend();
  }, []);

  const handleBuild = async () => {
    setIsBuilding(true);
    setError(null);
    setBuildStatus(null);
    try {
      const flatFiles = flattenVFS(files);
      const { buildId } = await startBuild(flatFiles, appId);
      const finalStatus = await waitForBuild(buildId, (status) => setBuildStatus(status));
      setBuildStatus(finalStatus);
      if (finalStatus.status === 'failed') setError(finalStatus.error || 'Build failed');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBuilding(false);
    }
  };

  const handleDownload = async () => {
    if (!buildStatus?.id) return;
    try {
      await downloadBuild(buildStatus.id, appId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <PanelContainer>
      <PanelHeader>
        <Heading level={4} style={{ margin: 0 }}>
          Build with ucc-gen
        </Heading>
        {onClose && <Button appearance="default" onClick={onClose} label="\u2715" />}
      </PanelHeader>

      <PanelContent>
        <StatusRow>
          <StatusItem>
            <span style={{ color: '#9b9ea3' }}>Backend:</span>
            {backendStatus === 'checking' && <WaitSpinner />}
            {backendStatus === 'online' && <Badge label="Online" backgroundColor="#65A637" />}
            {backendStatus === 'offline' && <Badge label="Offline" backgroundColor="#D32F2F" />}
          </StatusItem>

          {uccVersion && (
            <StatusItem>
              <span style={{ color: '#9b9ea3' }}>ucc-gen:</span>
              {uccVersion.available ? (
                <Badge label={uccVersion.version || 'Available'} backgroundColor="#65A637" />
              ) : (
                <Badge label="Not installed" backgroundColor="#D32F2F" />
              )}
            </StatusItem>
          )}
        </StatusRow>

        {backendStatus === 'online' && uccVersion?.available && (
          <BuildControls>
            <Button
              appearance="primary"
              onClick={handleBuild}
              disabled={isBuilding}
              label={isBuilding ? 'Building...' : 'Build App'}
            />
            {buildStatus?.status === 'success' && (
              <Button appearance="default" onClick={handleDownload} label="Download Built App" />
            )}
          </BuildControls>
        )}

        {backendStatus === 'offline' && (
          <Message type="warning">
            Backend server is not running. Start it with: <code>npm run dev:server</code>
          </Message>
        )}

        {uccVersion && !uccVersion.available && (
          <Message type="warning">
            ucc-gen is not installed or not in PATH. Install with:{' '}
            <code>pip install splunk-add-on-ucc-framework</code>
          </Message>
        )}

        {buildStatus && (
          <div style={{ marginBottom: 16 }}>
            <Progress percentage={buildStatus.progress} />
          </div>
        )}

        {error && <Message type="error">{error}</Message>}

        {buildStatus && buildStatus.logs.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Heading level={5} style={{ marginBottom: 8, color: '#9b9ea3' }}>
              Build Logs
            </Heading>
            <BuildLogs>
              {buildStatus.logs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </BuildLogs>
          </div>
        )}
      </PanelContent>
    </PanelContainer>
  );
}
