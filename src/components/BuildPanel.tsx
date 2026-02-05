import { useState, useEffect } from 'react';
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

/**
 * Flatten VFS tree to array of files with paths and content
 */
function flattenVFS(
  node: VFSNode,
  basePath = ''
): Array<{ path: string; content: string }> {
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

      const finalStatus = await waitForBuild(buildId, (status) => {
        setBuildStatus(status);
      });

      setBuildStatus(finalStatus);

      if (finalStatus.status === 'failed') {
        setError(finalStatus.error || 'Build failed');
      }
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
    <div className="build-panel">
      <div className="build-panel-header">
        <h3>Build with ucc-gen</h3>
        {onClose && (
          <button className="btn-icon" onClick={onClose} title="Close">
            ✕
          </button>
        )}
      </div>

      <div className="build-panel-content">
        {/* Backend Status */}
        <div className="status-section">
          <div className="status-item">
            <span className="status-label">Backend:</span>
            <span className={`status-value ${backendStatus}`}>
              {backendStatus === 'checking' && '⏳ Checking...'}
              {backendStatus === 'online' && '✓ Online'}
              {backendStatus === 'offline' && '✗ Offline'}
            </span>
          </div>

          {uccVersion && (
            <div className="status-item">
              <span className="status-label">ucc-gen:</span>
              <span className={`status-value ${uccVersion.available ? 'online' : 'offline'}`}>
                {uccVersion.available ? `✓ ${uccVersion.version}` : '✗ Not installed'}
              </span>
            </div>
          )}
        </div>

        {/* Build Controls */}
        {backendStatus === 'online' && uccVersion?.available && (
          <div className="build-controls">
            <button
              className="btn btn-primary"
              onClick={handleBuild}
              disabled={isBuilding}
            >
              {isBuilding ? 'Building...' : 'Build App'}
            </button>

            {buildStatus?.status === 'success' && (
              <button className="btn btn-secondary" onClick={handleDownload}>
                Download Built App
              </button>
            )}
          </div>
        )}

        {backendStatus === 'offline' && (
          <div className="warning-box">
            <p>Backend server is not running.</p>
            <p>Start it with: <code>npm run dev:server</code></p>
          </div>
        )}

        {uccVersion && !uccVersion.available && (
          <div className="warning-box">
            <p>ucc-gen is not installed or not in PATH.</p>
            <p>Install it with: <code>pip install splunk-add-on-ucc-framework</code></p>
          </div>
        )}

        {/* Progress */}
        {buildStatus && (
          <div className="build-progress">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${buildStatus.progress}%` }}
              />
            </div>
            <span className="progress-text">{buildStatus.progress}%</span>
          </div>
        )}

        {/* Error */}
        {error && <div className="error-box">{error}</div>}

        {/* Logs */}
        {buildStatus && buildStatus.logs.length > 0 && (
          <div className="build-logs">
            <h4>Build Logs</h4>
            <pre>
              {buildStatus.logs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </pre>
          </div>
        )}
      </div>

      <style>{`
        .build-panel {
          background: var(--splunk-dark);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          margin-bottom: 1rem;
        }
        .build-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid var(--border-color);
        }
        .build-panel-header h3 {
          margin: 0;
          font-size: 1rem;
        }
        .btn-icon {
          background: none;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 1rem;
          padding: 0.25rem;
        }
        .btn-icon:hover {
          color: var(--text-color);
        }
        .build-panel-content {
          padding: 1rem;
        }
        .status-section {
          display: flex;
          gap: 2rem;
          margin-bottom: 1rem;
        }
        .status-item {
          display: flex;
          gap: 0.5rem;
        }
        .status-label {
          color: var(--text-secondary);
        }
        .status-value.online {
          color: var(--splunk-green);
        }
        .status-value.offline {
          color: #D32F2F;
        }
        .status-value.checking {
          color: var(--text-secondary);
        }
        .build-controls {
          display: flex;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .warning-box {
          background: rgba(255, 193, 7, 0.1);
          border: 1px solid #FFC107;
          border-radius: 4px;
          padding: 0.75rem 1rem;
          margin-bottom: 1rem;
        }
        .warning-box p {
          margin: 0 0 0.5rem 0;
        }
        .warning-box p:last-child {
          margin-bottom: 0;
        }
        .warning-box code {
          background: rgba(0,0,0,0.2);
          padding: 0.2rem 0.4rem;
          border-radius: 2px;
        }
        .error-box {
          background: rgba(211, 47, 47, 0.1);
          border: 1px solid #D32F2F;
          border-radius: 4px;
          padding: 0.75rem 1rem;
          color: #D32F2F;
          margin-bottom: 1rem;
        }
        .build-progress {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 1rem;
        }
        .progress-bar {
          flex: 1;
          height: 8px;
          background: var(--splunk-gray);
          border-radius: 4px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: var(--splunk-green);
          transition: width 0.3s ease;
        }
        .progress-text {
          font-size: 0.875rem;
          color: var(--text-secondary);
          min-width: 3rem;
        }
        .build-logs {
          margin-top: 1rem;
        }
        .build-logs h4 {
          margin: 0 0 0.5rem 0;
          font-size: 0.875rem;
          color: var(--text-secondary);
        }
        .build-logs pre {
          background: rgba(0,0,0,0.3);
          border-radius: 4px;
          padding: 0.75rem;
          max-height: 200px;
          overflow-y: auto;
          font-size: 0.75rem;
          margin: 0;
        }
        .build-logs pre div {
          margin-bottom: 0.25rem;
        }
      `}</style>
    </div>
  );
}
