/**
 * CleverBug — Express integration example
 *
 * Run:
 *   cp .env.example .env        # fill in your tokens
 *   npx tsx examples/express-app.ts
 *
 * Test endpoints:
 *   GET /         → healthy
 *   GET /test-bug → throws TypeError → captured by CleverBug
 *   GET /checkout → simulates payment error with user context
 */

import { loadEnvFile } from 'node:process';
try { loadEnvFile(); } catch { /* .env not found, use existing env */ }

import express, { type Request, type Response, type NextFunction } from 'express';
import { CleverBug } from '../src/index.js';
import { createSlackApp, setupSlackActions } from '../src/integrations/slack.js';
import { applyFix } from '../src/integrations/github.js';

// ─── Init ─────────────────────────────────────────────────────────────────────

CleverBug.init({
  slack: {
    token: process.env['SLACK_BOT_TOKEN'] ?? '',
    channel: process.env['SLACK_CHANNEL'] ?? '#bugs',
  },
  github: {
    token: process.env['GITHUB_TOKEN'] ?? '',
    repo: process.env['GITHUB_REPO'] ?? 'my-org/my-app',
  },
  ai: {
    provider: (process.env['AI_PROVIDER'] as 'gemini' | 'claude') ?? 'gemini',
    apiKey: process.env['AI_API_KEY'] ?? '',
  },
  // Optional integrations — solo activa si las claves son reales
  ...(process.env['NOTION_TOKEN'] && !process.env['NOTION_TOKEN'].startsWith('secret_your') && {
    notion: {
      token: process.env['NOTION_TOKEN'],
      databaseId: process.env['NOTION_DATABASE_ID'] ?? '',
    },
  }),
  ...(process.env['LINEAR_API_KEY'] && {
    linear: {
      apiKey: process.env['LINEAR_API_KEY'],
      teamId: process.env['LINEAR_TEAM_ID'] ?? '',
    },
  }),
  aiTrigger: {
    minUniqueReports: 1,  // trigger AI on first report (good for testing)
    timeWindow: '1h',
  },
});

// ─── Slack interactive actions (botones en Slack) ─────────────────────────────

async function startSlackActions(): Promise<void> {
  const appToken = process.env['SLACK_APP_TOKEN'];
  if (!appToken) {
    console.warn('[CleverBug] SLACK_APP_TOKEN no configurado — botones de Slack desactivados.');
    return;
  }

  const config = CleverBug.getConfig();
  const slackApp = createSlackApp(config.slack);

  setupSlackActions(
    slackApp,

    // onEscalate: bug crítico confirmado por el equipo
    async (group, analysis) => {
      console.error('[CleverBug] 🚨 BUG CRÍTICO escalado:', {
        error: group.reports[0]?.error.message,
        severity: analysis.severity,
        users: group.uniqueUserIds.length,
        fingerprint: group.fingerprint.slice(0, 12),
      });
      // Aquí puedes: enviar DM al dev, crear ticket Linear, PagerDuty, etc.
    },

    // onApplyFix: equipo confirma aplicar el fix → crear PR en GitHub
    async (group, fix) => {
      const firstReport = group.reports[0];
      if (!firstReport) throw new Error('BugGroup vacío');

      console.log(`[CleverBug] Creando PR: ${fix.branchName}…`);
      const pr = await applyFix(config.github, fix, firstReport);
      console.log(`[CleverBug] PR creada: ${pr.url}`);
      return pr;
    }
  );

  await slackApp.start();
  console.log('[CleverBug] Slack Socket Mode activo — botones funcionando ✅');
}

startSlackActions().catch(console.error);

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Identify user per request (optional, enriches bug reports) ─────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  // In production: read from session/JWT
  const userId = req.headers['x-user-id'];
  if (typeof userId === 'string') {
    const email = req.headers['x-user-email'];
    const plan = req.headers['x-user-plan'];
    CleverBug.identify({
      userId,
      ...(typeof email === 'string' && { email }),
      ...(typeof plan === 'string' && { plan }),
    });
  }
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'CleverBug example app' });
});

// Simulate a bug that CleverBug will capture automatically
app.get('/test-bug', (_req: Request, _res: Response) => {
  // This error propagates to the CleverBug error middleware below
  throw new TypeError('Cannot read properties of undefined (reading "price")');
});

// Simulate a payment error with user context
app.get('/checkout', (req: Request, res: Response, next: NextFunction) => {
  try {
    // Simulated service call
    const cart = undefined as unknown as { price: number };
    const _price = cart.price; // throws TypeError

    res.json({ ok: true });
  } catch (err) {
    // Manual capture with request context
    CleverBug.captureError(err as Error, req);
    next(err);
  }
});

// Manual capture example (try/catch, no middleware needed)
app.get('/payment', async (_req: Request, res: Response) => {
  try {
    throw new Error('Stripe API timeout after 30000ms');
  } catch (err) {
    CleverBug.captureError(err as Error);
    res.status(500).json({ error: 'Payment service unavailable. Please retry.' });
  }
});

// ── CleverBug error middleware (must be LAST) ───────────────────────────────

app.use(CleverBug.middleware());

// Final error handler (sends response to client)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[app] Unhandled error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env['NODE_ENV'] === 'development' ? err.message : undefined,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

app.listen(PORT, () => {
  console.log(`\n🚀 CleverBug example app listening on http://localhost:${PORT}`);
  console.log('   GET /           → health check');
  console.log('   GET /test-bug   → triggers automatic error capture');
  console.log('   GET /checkout   → triggers manual error capture with context');
  console.log('   GET /payment    → triggers manual capture, returns 500 to client\n');
});
