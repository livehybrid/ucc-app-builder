import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { buildRouter } from './routes/build.js';
import { aiRouter } from './routes/ai.js';
import { agentRouter } from './routes/agent.js';
import { confSpecRouter } from './routes/confspec.js';

// Load .env from app root first, then workspace root (if present).
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '..', '..', '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GitHub Proxy Routes
app.post('/api/github/device/code', async (req, res) => {
  try {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json' 
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('GitHub Proxy Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/github/login/oauth/access_token', async (req, res) => {
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json' 
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error: any) {
    console.error('GitHub Proxy Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.use('/api', buildRouter);
app.use('/api', aiRouter);
app.use('/api', agentRouter);
app.use('/api', confSpecRouter);



// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 UCC App Builder backend running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health`);
});
