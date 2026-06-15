import { useState, useEffect, useRef, useCallback } from 'react';
import Button from '@splunk/react-ui/Button';
import Message from '@splunk/react-ui/Message';
import Select from '@splunk/react-ui/Select';
import Text from '@splunk/react-ui/Text';
import TextArea from '@splunk/react-ui/TextArea';
import Modal from '@splunk/react-ui/Modal';
import ControlGroup from '@splunk/react-ui/ControlGroup';
import Heading from '@splunk/react-ui/Heading';
import WaitSpinner from '@splunk/react-ui/WaitSpinner';
import Switch from '@splunk/react-ui/Switch';
import { buildValidateWorkflowYaml, CI_WORKFLOW_PATH } from '../lib/ciWorkflow';
import { GitHubSession, GitHubRepo, DeviceFlowResponse } from '../types/github';
import {
  initiateDeviceFlow,
  pollForToken,
  getUser,
  listRepos,
  createRepo,
  pushFiles,
  cloneRepo,
} from '../lib/github';
import type { VirtualFileSystem } from '../lib/vfs';

interface GitHubPanelProps {
  session?: GitHubSession;
  onSessionUpdate: (session: GitHubSession | undefined) => void;
  vfs: VirtualFileSystem;
  appName: string;
  mode?: 'push' | 'import'; // 'push' is default, 'import' for cloning from repo
  onImportComplete?: () => void; // Called after successful import
  onRequestClose?: () => void; // For closing the modal
}

export function GitHubPanel({
  session,
  onSessionUpdate,
  vfs,
  appName,
  mode = 'push',
  onImportComplete,
  onRequestClose,
}: GitHubPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Auth flow state
  const [deviceCodeData, setDeviceCodeData] = useState<DeviceFlowResponse | null>(null);

  // Repo management state
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [newRepoName, setNewRepoName] = useState(appName);
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);

  // Commit state
  // Commit state
  const [commitMessage, setCommitMessage] = useState('Initial Commit');
  const [includeCicd, setIncludeCicd] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);

  // Import state
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
    file: string;
  } | null>(null);

  // Client ID state. A deployment can provide a hosted Client ID via the
  // GITHUB_CLIENT_ID env var (served at /api/github/config); otherwise the user
  // brings their own, stored in localStorage. The server value wins when present.
  const [clientId, setClientId] = useState(
    () => localStorage.getItem('splunk_app_builder_github_client_id') || ''
  );
  const [serverClientId, setServerClientId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const effectiveClientId = serverClientId ?? clientId;

  const modalReturnRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('splunk_app_builder_github_client_id', clientId);
  }, [clientId]);

  useEffect(() => {
    fetch('/api/github/config')
      .then((r) => r.json())
      .then((d: { clientId?: string | null }) => {
        if (d?.clientId) setServerClientId(d.clientId);
      })
      .catch(() => {
        /* no hosted client id — fall back to BYO */
      });
  }, []);

  // Load repos if connected
  const loadRepos = useCallback(async () => {
    if (!session?.auth) return;
    setLoading(true);
    try {
      const repoList = await listRepos(session.auth.accessToken);
      setRepos(repoList);
      setError(null);
    } catch (e: unknown) {
      setError(`Failed to list repos: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [session?.auth]);

  useEffect(() => {
    if (session?.auth) {
      loadRepos();
    }
  }, [session?.auth, loadRepos]);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!effectiveClientId) {
        throw new Error('Please configure GitHub Client ID first');
      }
      const data = await initiateDeviceFlow(effectiveClientId);
      setDeviceCodeData(data);

      // Start polling
      const token = await pollForToken(effectiveClientId, data.device_code, data.interval);

      // Get User Info
      const user = await getUser(token.accessToken);

      onSessionUpdate({
        auth: token,
        user: user,
      });
      setDeviceCodeData(null);
    } catch (e: unknown) {
      setError(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      setDeviceCodeData(null);
      // Reveal the settings view so the Client ID field (and setup steps) are
      // visible right under the error — otherwise the user is told to fix the
      // Client ID with no field in sight.
      setShowSettings(true);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    if (confirm('Disconnect GitHub account?')) {
      onSessionUpdate(undefined);
    }
  };

  const handleCreateRepo = async () => {
    if (!session?.auth) return;
    setLoading(true);
    try {
      const newRepo = await createRepo(
        session.auth.accessToken,
        newRepoName || appName,
        newRepoPrivate,
        'Splunk App generated with UCC App Builder'
      );

      // Add to list and select it
      setRepos([newRepo, ...repos]);
      onSessionUpdate({
        ...session,
        selectedRepo: newRepo,
      });
      setRepoModalOpen(false);
      setInfo(`Repository ${newRepo.full_name} created successfully.`);
    } catch (e: unknown) {
      setError(`Failed to create repo: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePush = async () => {
    if (!session?.auth || !session.selectedRepo) return;
    if (!commitMessage.trim()) {
      setError('Please enter a commit message');
      return;
    }

    setPushing(true);
    setError(null);
    setInfo('Pushing files...');
    try {
      // Optionally generate a ready-to-run CI/CD workflow (ucc-gen build + AppInspect)
      // alongside the add-on, at the repo root.
      const extraFiles: Array<{ path: string; content: string }> = [];
      if (includeCicd) {
        let appId = session.selectedRepo.name;
        try {
          const gc = vfs.getAllFiles().find((f) => f.path.endsWith('globalConfig.json'));
          if (gc) appId = JSON.parse(gc.content)?.meta?.name || appId;
        } catch {
          /* fall back to repo name */
        }
        extraFiles.push({ path: CI_WORKFLOW_PATH, content: buildValidateWorkflowYaml(appId) });
      }
      await pushFiles(
        session.auth.accessToken,
        session.selectedRepo,
        vfs,
        commitMessage,
        [], // Ignore files list
        extraFiles
      );

      setInfo('Successfully pushed to GitHub!');
      setPushSuccess(true);
      onSessionUpdate({
        ...session,
        lastSync: new Date().toISOString(),
      });
    } catch (e: unknown) {
      setError(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPushing(false);
    }
  };

  const handleImport = async () => {
    if (!session?.auth || !session.selectedRepo) {
      setError('Please select a repository to import from.');
      return;
    }

    setImporting(true);
    setError(null);
    setInfo(null);
    setImportProgress(null);

    try {
      const result = await cloneRepo(
        session.auth.accessToken,
        session.selectedRepo,
        vfs,
        (current, total, file) => {
          setImportProgress({ current, total, file });
        }
      );

      if (result.errors.length > 0) {
        setInfo(`Imported ${result.fileCount} files. ${result.errors.length} files skipped.`);
      } else {
        setInfo(
          `Successfully imported ${result.fileCount} files from ${session.selectedRepo.name}!`
        );
      }

      // Call the import complete callback
      if (onImportComplete) {
        onImportComplete();
      }
    } catch (e: unknown) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  };

  // Settings / Setup View
  if (!effectiveClientId || showSettings) {
    return (
      <div style={{ padding: '0 20px 20px' }}>
        <Heading level={3}>GitHub Configuration</Heading>
        {error && (
          <Message type="error" style={{ marginBottom: 12 }}>
            {error}
          </Message>
        )}
        {serverClientId ? (
          <Message type="success" style={{ marginBottom: 12 }}>
            Client ID is provided by this deployment (GITHUB_CLIENT_ID) — no setup needed.
          </Message>
        ) : null}
        <p>To use GitHub integration, you must provide a Client ID from a GitHub OAuth App.</p>
        <ol style={{ marginLeft: '20px', marginBottom: '20px', color: '#999', fontSize: '0.9em' }}>
          <li>Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.</li>
          <li>
            Any name/homepage works; for <em>Authorization callback URL</em> use any valid URL (e.g.{' '}
            <code>http://localhost:3001</code>) — Device Flow doesn&apos;t use it.
          </li>
          <li>
            On the app, tick <strong>&quot;Enable Device Flow&quot;</strong> and save.{' '}
            <em>(Required — without it GitHub returns 404.)</em>
          </li>
          <li>
            Copy the <strong>Client ID</strong> (the <code>Iv1…</code>/<code>Ov23…</code> value,
            <strong> not</strong> the client secret) and paste it below.
          </li>
        </ol>

        <ControlGroup label="Client ID">
          <Text
            value={clientId}
            onChange={(_e, { value }) => setClientId(value)}
            placeholder="e.g. Ov23..."
          />
        </ControlGroup>

        <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
          <Button
            appearance="primary"
            onClick={() => setShowSettings(false)}
            disabled={!clientId}
            label="Save & Continue"
          />
          {session && <Button onClick={() => setShowSettings(false)} label="Cancel" />}
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ padding: '0 20px 20px' }}>
        <p style={{ marginBottom: '16px' }}>Connect to GitHub to sync your app source code.</p>

        {error && <Message type="error">{error}</Message>}

        {deviceCodeData ? (
          <div
            style={{
              textAlign: 'center',
              background: 'rgba(255,255,255,0.05)',
              padding: '20px',
              borderRadius: '4px',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <p>Please visit:</p>
            <Heading level={2} style={{ margin: '10px 0' }}>
              <a href={deviceCodeData.verification_uri} target="_blank" rel="noopener noreferrer">
                {deviceCodeData.verification_uri}
              </a>
            </Heading>
            <p>And enter code:</p>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '12px',
                margin: '10px 0',
              }}
            >
              <Heading level={1} style={{ margin: 0, letterSpacing: '4px' }}>
                {deviceCodeData.user_code}
              </Heading>
              <Button
                appearance="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(deviceCodeData.user_code);
                }}
                label="📋 Copy"
              />
            </div>
            <div style={{ marginTop: '20px' }}>
              <WaitSpinner size="medium" /> Waiting for authentication...
            </div>
          </div>
        ) : (
          <Button
            appearance="primary"
            onClick={handleConnect}
            disabled={loading}
            icon={loading ? <WaitSpinner /> : undefined}
            label={loading ? 'Connecting...' : 'Connect to GitHub'}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: '0 20px 20px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <div>
          <span style={{ marginRight: '10px', fontSize: '0.9em', color: '#666' }}>
            Logged in as <strong>{session.user.login}</strong>
          </span>
          <Button appearance="secondary" onClick={handleDisconnect} label="Disconnect" />
        </div>
      </div>

      {error && (
        <Message type="error" style={{ marginBottom: '10px' }}>
          {error}
        </Message>
      )}
      {info && (
        <Message type="info" style={{ marginBottom: '10px' }}>
          {info}
        </Message>
      )}

      <ControlGroup label="Repository">
        <Select
          value={session.selectedRepo?.id}
          onChange={(_e, { value }) => {
            const repo = repos.find((r) => r.id === value);
            if (repo) {
              onSessionUpdate({ ...session, selectedRepo: repo });
            }
          }}
          style={{ width: '100%' }}
        >
          {repos.map((repo) => (
            <Select.Option key={repo.id} value={repo.id} label={repo.full_name} />
          ))}
        </Select>
        <Button onClick={() => setRepoModalOpen(true)} label="New Repo" />
      </ControlGroup>

      {session.selectedRepo && mode === 'import' && (
        <div
          style={{
            marginTop: '20px',
            borderTop: '1px solid rgba(255,255,255,0.1)',
            paddingTop: '16px',
          }}
        >
          <Heading level={4}>Import from {session.selectedRepo.name}</Heading>
          <p style={{ color: '#9b9ea3', fontSize: '0.9em', marginBottom: '12px' }}>
            This will clone all text files from the repository into the app builder. Binary files
            and files over 1MB will be skipped.
          </p>

          {importProgress && (
            <div
              style={{
                marginBottom: '12px',
                padding: '12px',
                background: 'rgba(101, 166, 55, 0.1)',
                borderRadius: '6px',
              }}
            >
              <WaitSpinner /> Importing {importProgress.current}/{importProgress.total}...
              <div
                style={{
                  fontSize: '0.8em',
                  color: '#9b9ea3',
                  marginTop: '4px',
                  wordBreak: 'break-all',
                }}
              >
                {importProgress.file}
              </div>
            </div>
          )}

          <Button
            appearance="primary"
            onClick={handleImport}
            disabled={importing}
            icon={importing ? <WaitSpinner /> : undefined}
            label={importing ? 'Importing...' : '📥 Clone Repository'}
          />
        </div>
      )}

      {session.selectedRepo && mode === 'push' && (
        <div style={{ marginTop: '20px', borderTop: '1px solid #eee', paddingTop: '16px' }}>
          <Heading level={4}>Sync to {session.selectedRepo.name}</Heading>
          {session.lastSync && (
            <div style={{ fontSize: '0.8em', color: '#666', marginBottom: '8px' }}>
              Last synced: {new Date(session.lastSync).toLocaleString()}
            </div>
          )}

          {pushSuccess ? (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '3rem', marginBottom: '10px' }}>✅</div>
              <div style={{ marginBottom: '20px', color: '#65A637', fontWeight: 'bold' }}>
                Push Complete!
              </div>
              <Button
                appearance="primary"
                onClick={onRequestClose}
                label="Close"
                style={{ minWidth: '120px' }}
              />
            </div>
          ) : (
            <>
              <TextArea
                value={commitMessage}
                onChange={(_e: unknown, { value }: { value: string }) => setCommitMessage(value)}
                style={{ marginBottom: '10px', width: '100%', minHeight: '80px' }}
              />
              <div style={{ marginBottom: '10px' }}>
                <Switch
                  selected={includeCicd}
                  onClick={() => setIncludeCicd(!includeCicd)}
                  appearance="checkbox"
                >
                  Include CI/CD workflow (ucc-gen build + AppInspect)
                </Switch>
                <p style={{ fontSize: '0.8em', color: '#9b9ea3', margin: '2px 0 0 0' }}>
                  Adds <code>{CI_WORKFLOW_PATH}</code> so every push builds and AppInspect-validates the add-on.
                </p>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <Button
                  appearance="secondary"
                  onClick={onRequestClose}
                  label="Cancel"
                  disabled={pushing}
                />
                <Button
                  appearance="primary"
                  onClick={handlePush}
                  disabled={pushing}
                  icon={pushing ? <WaitSpinner /> : undefined}
                  label={pushing ? 'Pushing...' : 'Commit & Push'}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* New Repo Modal */}
      <Modal
        open={repoModalOpen}
        onRequestClose={() => setRepoModalOpen(false)}
        returnFocus={modalReturnRef}
      >
        <Modal.Header title="Create New Repository" />
        <Modal.Body>
          <ControlGroup label="Name">
            <Text value={newRepoName} onChange={(_e, { value }) => setNewRepoName(value)} />
          </ControlGroup>
          <div style={{ marginTop: '10px' }}>
            <label>
              <input
                type="checkbox"
                checked={newRepoPrivate}
                onChange={(e) => setNewRepoPrivate(e.target.checked)}
              />{' '}
              Private Repository
            </label>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button appearance="secondary" onClick={() => setRepoModalOpen(false)} label="Cancel" />
          <Button appearance="primary" onClick={handleCreateRepo} label="Create" />
        </Modal.Footer>
      </Modal>
    </div>
  );
}
