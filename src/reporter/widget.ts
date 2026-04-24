/**
 * CleverBug Widget — browser-side reporter.
 *
 * Usage (vanilla script tag):
 *   <script src="https://cdn.cleverbug.dev/widget.js"></script>
 *   <script>
 *     CleverBugWidget.init({
 *       token: 'cb_token_xxx',
 *       endpoint: '/cleverbug/report',   // optional, default: '/cleverbug/report'
 *       user: { id: '123', email: 'user@example.com', isBetaTester: true }
 *     });
 *   </script>
 *
 * Build note: bundle this file with esbuild/rollup as IIFE targeting browsers.
 *   esbuild src/reporter/widget.ts --bundle --format=iife --global-name=CleverBugWidget --outfile=dist/widget.js
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WidgetUser {
  id: string;
  email?: string;
  plan?: string;
  isBetaTester?: boolean;
}

export interface WidgetConfig {
  token: string;
  user?: WidgetUser;
  endpoint?: string;
  shortcut?: string;
  shakeThreshold?: number;
}

interface MouseRecord {
  type: string;
  x: number;
  y: number;
  target: string;
  timestamp: number;
}

interface FetchRecord {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  timestamp: number;
}

// ─── Circular buffer ──────────────────────────────────────────────────────────

class CircularBuffer<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<T | undefined>(capacity).fill(undefined);
  }

  push(item: T): void {
    this.buf[this.head % this.capacity] = item;
    this.head++;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  toArray(): T[] {
    const start = this.count < this.capacity ? 0 : this.head % this.capacity;
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.buf[(start + i) % this.capacity];
      if (item !== undefined) result.push(item);
    }
    return result;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

const mouseEvents = new CircularBuffer<MouseRecord>(10);
const fetchHistory = new CircularBuffer<FetchRecord>(10);
const consoleLogs: string[] = [];
const MAX_CONSOLE_LOGS = 50;

let config: WidgetConfig | null = null;
let panelEl: HTMLDivElement | null = null;
let isOpen = false;

// ─── Console interceptor ──────────────────────────────────────────────────────

function installConsoleInterceptor(): void {
  const levels = ['error', 'warn'] as const;

  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const msg = `[${level.toUpperCase()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
      consoleLogs.push(msg);
      if (consoleLogs.length > MAX_CONSOLE_LOGS) consoleLogs.shift();
    };
  }
}

// ─── Fetch interceptor ────────────────────────────────────────────────────────

function installFetchInterceptor(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const start = Date.now();
    const method = (init?.method ?? 'GET').toUpperCase();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    try {
      const response = await originalFetch(input, init);
      fetchHistory.push({ method, url, status: response.status, durationMs: Date.now() - start, timestamp: start });
      return response;
    } catch (err) {
      fetchHistory.push({ method, url, status: 0, durationMs: Date.now() - start, timestamp: start });
      throw err;
    }
  };
}

// ─── Mouse/touch event tracking ───────────────────────────────────────────────

function installPointerTracking(): void {
  const track = (type: string) => (e: MouseEvent | TouchEvent) => {
    const x = e instanceof MouseEvent ? e.clientX : (e.touches[0]?.clientX ?? 0);
    const y = e instanceof MouseEvent ? e.clientY : (e.touches[0]?.clientY ?? 0);
    const target = (e.target as HTMLElement | null)?.tagName ?? 'UNKNOWN';
    mouseEvents.push({ type, x, y, target, timestamp: Date.now() });
  };

  document.addEventListener('click', track('click'), { passive: true });
  document.addEventListener('touchstart', track('touchstart'), { passive: true });
}

// ─── Shake detection ──────────────────────────────────────────────────────────

function installShakeDetector(threshold: number, onShake: () => void): void {
  let lastAcc = { x: 0, y: 0, z: 0 };
  let shakeStart = 0;
  const SHAKE_DURATION_MS = 500;

  window.addEventListener('devicemotion', (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;

    const ax = acc.x ?? 0;
    const ay = acc.y ?? 0;
    const az = acc.z ?? 0;

    const delta = Math.sqrt(
      (ax - lastAcc.x) ** 2 +
      (ay - lastAcc.y) ** 2 +
      (az - lastAcc.z) ** 2
    );

    lastAcc = { x: ax, y: ay, z: az };

    if (delta > threshold) {
      if (!shakeStart) shakeStart = Date.now();
      if (Date.now() - shakeStart >= SHAKE_DURATION_MS) {
        shakeStart = 0;
        onShake();
      }
    } else {
      shakeStart = 0;
    }
  });
}

// ─── Keyboard shortcut ────────────────────────────────────────────────────────

function installKeyboardShortcut(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      togglePanel();
    }
  });
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

async function captureScreenshot(): Promise<string | null> {
  const html2canvas = (window as unknown as Record<string, unknown>)['html2canvas'];
  if (typeof html2canvas !== 'function') return null;
  try {
    const canvas = await (html2canvas as (el: HTMLElement, opts?: unknown) => Promise<HTMLCanvasElement>)(
      document.body,
      { scale: 0.5, logging: false, useCORS: true }
    );
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

// ─── Context snapshot ─────────────────────────────────────────────────────────

async function buildContext(description?: string): Promise<Record<string, unknown>> {
  const screenshot = await captureScreenshot();

  return {
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    description: description ?? null,
    mouseEvents: mouseEvents.toArray(),
    fetchHistory: fetchHistory.toArray(),
    consoleLogs: consoleLogs.slice(-30),
    screenshot,
    user: config?.user ?? null,
  };
}

// ─── Submit report ────────────────────────────────────────────────────────────

async function submitReport(description?: string): Promise<void> {
  if (!config) return;

  const context = await buildContext(description);

  await fetch(config.endpoint ?? '/cleverbug/report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CleverBug-Token': config.token,
    },
    body: JSON.stringify({
      source: 'manual',
      error: {
        name: 'UserReport',
        message: description ?? 'User reported a problem',
      },
      context,
    }),
  });
}

// ─── UI: Panel ────────────────────────────────────────────────────────────────

const STYLES = `
  #cb-panel {
    position: fixed;
    top: 0;
    right: 0;
    width: 320px;
    height: 100dvh;
    background: #12131a;
    color: #e2e4f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    z-index: 2147483647;
    box-shadow: -6px 0 32px rgba(0,0,0,0.6);
    display: flex;
    flex-direction: column;
    padding: 24px;
    box-sizing: border-box;
    transform: translateX(100%);
    transition: transform 0.28s cubic-bezier(0.4,0,0.2,1);
    overflow-y: auto;
  }
  #cb-panel.cb-open { transform: translateX(0); }
  #cb-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }
  #cb-title {
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #cb-close {
    background: none;
    border: none;
    color: #888;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    padding: 4px;
    border-radius: 4px;
  }
  #cb-close:hover { color: #fff; background: rgba(255,255,255,0.08); }
  #cb-desc {
    width: 100%;
    background: #1e1f2e;
    border: 1px solid #2e3048;
    border-radius: 8px;
    color: #e2e4f0;
    font-size: 13px;
    font-family: inherit;
    padding: 10px 12px;
    resize: vertical;
    min-height: 80px;
    box-sizing: border-box;
    margin-bottom: 16px;
    outline: none;
  }
  #cb-desc:focus { border-color: #5c6bc0; }
  #cb-desc::placeholder { color: #555; }
  #cb-submit {
    width: 100%;
    padding: 11px 16px;
    background: #5c6bc0;
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  #cb-submit:hover { background: #7986cb; }
  #cb-submit:disabled { background: #2e3048; color: #555; cursor: not-allowed; }
  #cb-status {
    margin-top: 14px;
    text-align: center;
    font-size: 13px;
    color: #888;
    min-height: 20px;
  }
  #cb-status.cb-ok { color: #66bb6a; }
  #cb-status.cb-err { color: #ef5350; }
  #cb-hint {
    margin-top: auto;
    padding-top: 20px;
    font-size: 11px;
    color: #3a3c52;
    text-align: center;
  }
`;

function injectStyles(): void {
  if (document.getElementById('cb-styles')) return;
  const style = document.createElement('style');
  style.id = 'cb-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

function buildPanel(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = 'cb-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Reportar problema');

  panel.innerHTML = `
    <div id="cb-header">
      <div id="cb-title">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="7.5" stroke="#5c6bc0"/>
          <path d="M8 4.5v4M8 10.5v1" stroke="#5c6bc0" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        Reportar problema
      </div>
      <button id="cb-close" aria-label="Cerrar">&times;</button>
    </div>
    <textarea
      id="cb-desc"
      placeholder="Describe brevemente qué estaba haciendo cuando ocurrió el problema (opcional)..."
    ></textarea>
    <button id="cb-submit">Enviar reporte</button>
    <div id="cb-status"></div>
    <div id="cb-hint">Ctrl+Shift+B para abrir · CleverBug</div>
  `;

  return panel;
}

function openPanel(): void {
  if (isOpen) return;
  isOpen = true;

  injectStyles();

  if (!panelEl) {
    panelEl = buildPanel();
    document.body.appendChild(panelEl);

    const closeBtn = panelEl.querySelector<HTMLButtonElement>('#cb-close')!;
    const submitBtn = panelEl.querySelector<HTMLButtonElement>('#cb-submit')!;
    const textarea = panelEl.querySelector<HTMLTextAreaElement>('#cb-desc')!;
    const status = panelEl.querySelector<HTMLDivElement>('#cb-status')!;

    closeBtn.addEventListener('click', closePanel);

    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      status.textContent = 'Capturando contexto…';
      status.className = '';

      try {
        await submitReport(textarea.value.trim() || undefined);
        status.textContent = '✓ Reporte enviado. ¡Gracias!';
        status.className = 'cb-ok';
        textarea.value = '';
        setTimeout(closePanel, 2500);
      } catch {
        status.textContent = '✗ Error al enviar. Inténtalo de nuevo.';
        status.className = 'cb-err';
        submitBtn.disabled = false;
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) closePanel();
    });
  }

  // Reset status on reopen
  const status = panelEl.querySelector<HTMLDivElement>('#cb-status');
  const submitBtn = panelEl.querySelector<HTMLButtonElement>('#cb-submit');
  if (status) { status.textContent = ''; status.className = ''; }
  if (submitBtn) submitBtn.disabled = false;

  // Animate open
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      panelEl?.classList.add('cb-open');
    });
  });
}

function closePanel(): void {
  if (!isOpen || !panelEl) return;
  isOpen = false;
  panelEl.classList.remove('cb-open');
}

function togglePanel(): void {
  isOpen ? closePanel() : openPanel();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises the CleverBug widget.
 * Call once after the DOM is ready.
 *
 * If no user is provided, no listeners are registered and the widget
 * is completely invisible to the end user.
 */
export function init(cfg: WidgetConfig): void {
  if (config) {
    console.warn('[CleverBug] Widget already initialised. Ignoring duplicate init() call.');
    return;
  }

  // No user → completely invisible, nothing registered
  if (!cfg.user) return;

  config = cfg;

  installConsoleInterceptor();
  installFetchInterceptor();
  installPointerTracking();
  installKeyboardShortcut();

  // Shake only for beta testers
  if (cfg.user.isBetaTester) {
    const threshold = cfg.shakeThreshold ?? 15;
    installShakeDetector(threshold, openPanel);
  }
}

// ─── Expose on window for script-tag usage ────────────────────────────────────

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['CleverBugWidget'] = { init };
}
