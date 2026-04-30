import { spawn, spawnSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

/**
 * Splunk Docker helper.
 *
 * Starts (or reuses) a local `splunk/splunk:latest` container, copies a built
 * UCC add-on tarball into `$SPLUNK_HOME/etc/apps/`, restarts Splunk, and tails
 * the internal log to confirm the add-on registered without errors.
 *
 * This is intentionally minimal — it's a developer-loop verifier, not a full
 * test harness.
 */

export interface DockerStartOptions {
  /** Defaults to `ucc-app-builder-splunk`. */
  containerName?: string;
  /** Defaults to `splunk/splunk:latest`. */
  image?: string;
  /** Splunk admin password. Defaults to `changeme123!`. */
  password?: string;
  /** Web port. Defaults to 8000. */
  webPort?: number;
  /** Management port. Defaults to 8089. */
  mgmtPort?: number;
  onLog?: (line: string) => void;
}

export interface SplunkInstallResult {
  containerName: string;
  webUrl: string;
  logTail: string[];
  errors: string[];
}

const DEFAULT_NAME = 'ucc-app-builder-splunk';

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: err + '\n' + e.message }));
  });
}

export class SplunkDockerService {
  async ensureContainer(opts: DockerStartOptions = {}): Promise<string> {
    const name = opts.containerName ?? DEFAULT_NAME;
    const image = opts.image ?? 'splunk/splunk:latest';
    const password = opts.password ?? 'changeme123!';
    const webPort = opts.webPort ?? 8000;
    const mgmtPort = opts.mgmtPort ?? 8089;

    const inspect = await run('docker', ['inspect', '-f', '{{.State.Running}}', name]);
    if (inspect.code === 0) {
      const running = inspect.out.trim();
      if (running === 'true') return name;
      // Start the stopped container.
      opts.onLog?.(`Starting existing container ${name}…`);
      const startRes = await run('docker', ['start', name]);
      if (startRes.code !== 0) throw new Error(`docker start failed: ${startRes.err}`);
      return name;
    }

    opts.onLog?.(`Creating container ${name} from ${image}…`);
    const createRes = await run('docker', [
      'run', '-d',
      '--name', name,
      '-e', 'SPLUNK_START_ARGS=--accept-license',
      '-e', `SPLUNK_PASSWORD=${password}`,
      '-p', `${webPort}:8000`,
      '-p', `${mgmtPort}:8089`,
      image,
    ]);
    if (createRes.code !== 0) {
      throw new Error(`docker run failed: ${createRes.err || createRes.out}`);
    }
    return name;
  }

  async waitForReady(
    containerName: string,
    onLog?: (line: string) => void,
    timeoutMs = 180_000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const healthRes = await run('docker', [
        'exec', containerName,
        '/opt/splunk/bin/splunk', 'status',
      ]);
      if (healthRes.code === 0 && /splunkd is running/i.test(healthRes.out + healthRes.err)) {
        onLog?.(`Splunk is up (${Math.round((Date.now() - start) / 1000)}s).`);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`Splunk container did not become ready within ${timeoutMs}ms.`);
  }

  async installApp(
    containerName: string,
    tarballPath: string,
    appId: string,
    onLog?: (line: string) => void,
  ): Promise<void> {
    const abs = path.resolve(tarballPath);
    await fs.access(abs);
    onLog?.(`Copying ${abs} → ${containerName}:/tmp/`);
    const cp = await run('docker', ['cp', abs, `${containerName}:/tmp/${path.basename(abs)}`]);
    if (cp.code !== 0) throw new Error(`docker cp failed: ${cp.err}`);

    onLog?.(`Extracting add-on to $SPLUNK_HOME/etc/apps/…`);
    const install = await run('docker', [
      'exec', containerName, 'bash', '-lc',
      `tar -xzf /tmp/${path.basename(abs)} -C /opt/splunk/etc/apps && rm -rf /opt/splunk/etc/apps/${appId}/.ucc && ls -la /opt/splunk/etc/apps/${appId}`,
    ]);
    if (install.code !== 0) throw new Error(`tar failed: ${install.err || install.out}`);
    onLog?.(install.out.trim());

    onLog?.('Restarting Splunk to pick up the new add-on…');
    const restart = await run('docker', [
      'exec', containerName, '/opt/splunk/bin/splunk', 'restart',
    ]);
    if (restart.code !== 0) throw new Error(`splunk restart failed: ${restart.err || restart.out}`);
    onLog?.('Restart complete.');
  }

  async tailInternalLog(containerName: string, lines = 200): Promise<string[]> {
    const tail = await run('docker', [
      'exec', containerName, 'bash', '-lc',
      `tail -n ${lines} /opt/splunk/var/log/splunk/splunkd.log`,
    ]);
    return (tail.out || tail.err).split('\n');
  }

  extractErrors(logLines: string[]): string[] {
    return logLines
      .filter((l) => /ERROR|FATAL|CRITICAL/.test(l))
      // Filter Splunk-internal noise that appears even on clean installs.
      .filter((l) => !/SHCRepository|HttpListener - Socket/.test(l));
  }

  isDockerAvailable(): boolean {
    try {
      const res = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
      return res.status === 0;
    } catch {
      return false;
    }
  }
}
