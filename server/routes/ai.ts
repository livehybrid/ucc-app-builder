import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/ai/config
 * Returns AI configuration to the frontend.
 * If OPENROUTER_APIKEY is set, the server will proxy requests.
 */
router.get('/ai/config', (_req: Request, res: Response) => {
  const serverManaged = !!process.env.OPENROUTER_APIKEY;
  res.json({
    serverManaged,
    defaultModel: 'moonshotai/kimi-k2.5',
  });
});

/**
 * POST /api/ai/chat
 * Proxies chat completion requests to OpenRouter using the server-side API key.
 * Only available when OPENROUTER_APIKEY is set.
 */
router.post('/ai/chat', async (req: Request, res: Response) => {
  const apiKey = process.env.OPENROUTER_APIKEY;

  if (!apiKey) {
    return res.status(403).json({
      error: 'Server-managed AI is not configured. Set OPENROUTER_APIKEY env variable.',
    });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://splunk.engineer',
        'X-Title': 'UCCBuilder',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('AI Proxy Error:', message);
    res.status(500).json({ error: message });
  }
});

export { router as aiRouter };
