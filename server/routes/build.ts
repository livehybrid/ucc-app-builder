import path from 'path';
import fs from 'fs/promises';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { UCCGenService, BuildStatus } from '../services/uccGen.js';
import { FileHandler } from '../utils/fileHandler.js';

const router = Router();
const uccGenService = new UCCGenService();
const fileHandler = new FileHandler();

// Store for active builds
const builds = new Map<string, BuildStatus>();

/**
 * POST /api/build
 * Start a new build from uploaded source files
 */
router.post('/build', async (req: Request, res: Response) => {
  try {
    const { files, appId, metadata } = req.body;

    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'Files array is required' });
    }

    if (!appId) {
      return res.status(400).json({ error: 'appId is required' });
    }

    const buildId = uuidv4();

    // Initialize build status
    builds.set(buildId, {
      id: buildId,
      status: 'pending',
      progress: 0,
      logs: [],
      startedAt: new Date().toISOString(),
    });

    // Start build asynchronously
    runBuild(buildId, files, appId, metadata);

    res.json({ buildId, status: 'pending' });
  } catch (error) {
    console.error('Build error:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/build/:buildId
 * Get build status and logs
 */
router.get('/build/:buildId', (req: Request, res: Response) => {
  const { buildId } = req.params;
  const build = builds.get(buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  res.json(build);
});

/**
 * GET /api/build/:buildId/download
 * Download the built app package
 */
router.get('/build/:buildId/download', async (req: Request, res: Response) => {
  const { buildId } = req.params;
  const build = builds.get(buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.status !== 'success') {
    return res.status(400).json({ error: 'Build not complete or failed' });
  }

  if (!build.outputPath) {
    return res.status(404).json({ error: 'Build output not found' });
  }

  try {
    const filename = `${build.appId || 'app'}.tgz`;

    // ucc-gen package produces a .tar.gz file; stream it directly
    if (build.outputPath.endsWith('.tgz') || build.outputPath.endsWith('.tar.gz')) {
      const buffer = await fs.readFile(build.outputPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
      return;
    }

    // Legacy: output path is a directory
    const zipBuffer = await fileHandler.createZipFromDirectory(build.outputPath);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to create download' });
  }
});

/**
 * POST /api/validate
 * Validate globalConfig.json without building
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { globalConfig } = req.body;

    if (!globalConfig) {
      return res.status(400).json({ error: 'globalConfig is required' });
    }

    const result = await uccGenService.validateConfig(globalConfig);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/ucc-version
 * Get the installed ucc-gen version
 */
router.get('/ucc-version', async (_req: Request, res: Response) => {
  try {
    const version = await uccGenService.getVersion();
    res.json({ version, available: true });
  } catch (error) {
    res.json({ version: null, available: false, error: (error as Error).message });
  }
});

/**
 * Run the build process asynchronously
 */
async function runBuild(
  buildId: string,
  files: Array<{ path: string; content: string }>,
  appId: string,
  metadata: Record<string, string>
): Promise<void> {
  const build = builds.get(buildId)!;

  try {
    // Update status
    build.status = 'running';
    build.progress = 10;
    build.logs.push('Starting build...');
    build.appId = appId;

    // Write files to temp directory
    build.logs.push('Writing source files...');
    const workDir = await fileHandler.createTempDirectory(buildId);
    await fileHandler.writeFiles(workDir, files);
    build.progress = 30;

    // Run ucc-gen init if needed
    build.logs.push('Initializing UCC project...');
    await uccGenService.init(workDir, appId, (log) => {
      build.logs.push(log);
    });
    build.progress = 50;

    // Run ucc-gen build
    build.logs.push('Running ucc-gen build...');

    // Extract version from globalConfig.json
    let version = '1.0.0';
    try {
      const globalConfigPath = `package/globalConfig.json`;
      // Handle both with and without appId prefix in path (VFS structure varies)
      const configFile = files.find(f =>
        f.path.endsWith('globalConfig.json')
      );

      if (configFile) {
        const config = JSON.parse(configFile.content);
        if (config.meta && config.meta.version) {
          version = config.meta.version;
        }
      }
    } catch (e) {
      build.logs.push(`Warning: Could not extract version from globalConfig.json, defaulting to ${version}`);
    }

    const outputDir = await uccGenService.build(workDir, (log) => {
      build.logs.push(log);
    }, version);
    build.progress = 80;

    // Package the output (ucc-gen build writes to output/<appID>, so point package at that)
    build.logs.push('Packaging output...');
    const builtAppPath = path.join(outputDir, appId);
    const packagePath = await uccGenService.package(workDir, builtAppPath, (log) => {
      build.logs.push(log);
    });
    build.outputPath = packagePath;
    build.progress = 100;

    build.status = 'success';
    build.completedAt = new Date().toISOString();
    build.logs.push('Build completed successfully!');

  } catch (error) {
    build.status = 'failed';
    build.error = (error as Error).message;
    build.logs.push(`Error: ${(error as Error).message}`);
    build.completedAt = new Date().toISOString();
  }
}

export { router as buildRouter };
