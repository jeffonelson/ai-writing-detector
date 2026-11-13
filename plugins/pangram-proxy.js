/**
 * Vite plugin: a small local proxy in front of the Pangram API.
 *
 *   POST /api/analyze  -> POST /task, then poll GET /task/{id} until it finishes
 *   GET  /api/models   -> GET /models
 *   GET  /api/account  -> GET /balance + GET /usage (neither spends credits)
 *
 * The API key stays in this process and is never sent to the browser. Because
 * the proxy spends real credits, it only answers same-origin requests made to
 * a loopback host, so other websites open in the browser cannot use it.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const PANGRAM = 'https://text.external-api.pangram.com';
const MAX_BODY_BYTES = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const TASK_DEADLINE_MS = 120_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const STATUS_MESSAGES = {
  401: 'Pangram rejected the API key. Check PANGRAM_API_KEY in .env and restart the server.',
  402: 'Your Pangram account is out of credits.',
  403: 'This API key is not allowed to use that model.',
  413: 'That text is too large for Pangram to accept.',
  429: 'Pangram rate limit reached. Wait a moment and try again.',
  503: 'That Pangram model is temporarily unavailable. Try again shortly.',
};

class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function send(res, status, data, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

/** Refuse anything that is not a same-origin request to a loopback host. */
function assertLocalSameOrigin(req) {
  const host = req.headers.host || '';
  let hostname = '';
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    // leave hostname empty so the check below fails
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new HttpError(403, 'This proxy only answers requests made to localhost.');
  }

  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // malformed Origin header: treated as cross-origin
    }
    if (originHost !== host) throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }

  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-origin requests are not allowed.');
  }
}

async function readJsonBody(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'Request body must be application/json.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'That text is too large. The limit is about 1 MB.');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

/** Pull a human-readable reason out of a Pangram error body, if there is one. */
function upstreamDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const detail = data.detail ?? data.error ?? data.message;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === 'string' ? d : d?.msg))
      .filter((d) => typeof d === 'string')
      .join('; ');
  }
  return '';
}

async function pangram(apiKey, path, { method = 'GET', body, signal } = {}) {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let res;
  let raw;
  try {
    res = await fetch(PANGRAM + path, {
      method,
      headers: {
        'x-api-key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    raw = await res.text();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timeout.aborted) throw new HttpError(504, 'Pangram took too long to respond.');
    throw new HttpError(502, 'Could not reach Pangram. Check your internet connection.');
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // non-JSON body, handled below
  }

  if (!res.ok) {
    const detail = upstreamDetail(data);
    const message =
      STATUS_MESSAGES[res.status] ||
      (res.status >= 500
        ? 'Pangram had a problem processing the request.'
        : detail || `Pangram refused the request (status ${res.status}).`);
    const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
    throw new HttpError(
      res.status >= 500 ? 502 : res.status,
      detail && !message.includes(detail) && res.status < 500 ? `${message} (${detail})` : message,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  if (data === null) throw new HttpError(502, 'Pangram returned an unreadable response.');
  return data;
}

async function analyze(apiKey, input, signal) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  const { text, model, public_dashboard_link: publicLink = false } = input;
  if (typeof text !== 'string' || !text.trim()) {
    throw new HttpError(400, 'There is no text to analyze.');
  }
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new HttpError(400, 'Choose a model before analyzing.');
  }
  if (typeof publicLink !== 'boolean') {
    throw new HttpError(400, 'public_dashboard_link must be true or false.');
  }

  const created = await pangram(apiKey, '/task', {
    method: 'POST',
    body: { text, model, public_dashboard_link: publicLink },
    signal,
  });
  const taskId = created?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    throw new HttpError(502, 'Pangram did not return a task to follow.');
  }

  const deadline = Date.now() + TASK_DEADLINE_MS;
  let delay = 500;
  while (Date.now() < deadline) {
    await sleep(delay, undefined, { signal });
    delay = Math.min(delay * 1.5, 2000);

    let task;
    try {
      task = await pangram(apiKey, `/task/${encodeURIComponent(taskId)}`, { signal });
    } catch (err) {
      // Being rate limited while polling is recoverable: back off and keep going.
      if (err instanceof HttpError && err.status === 429) {
        delay = Math.min(Math.max((err.retryAfter || 2) * 1000, delay), 10_000);
        continue;
      }
      throw err;
    }

    if (task.stage === 'STAGE_SUCCESS') return task;
    if (task.stage === 'STAGE_FAILED') {
      // Pangram reports the failure reason in `headline`.
      throw new HttpError(422, task.headline || 'Pangram could not analyze this text.');
    }
  }
  throw new HttpError(504, 'Pangram was still working after two minutes. Try again.');
}

async function account(apiKey, signal) {
  const [balance, usage] = await Promise.allSettled([
    pangram(apiKey, '/balance', { signal }),
    pangram(apiKey, '/usage', { signal }),
  ]);
  if (balance.status === 'rejected' && usage.status === 'rejected') throw balance.reason;
  return {
    balance: balance.status === 'fulfilled' ? balance.value : null,
    usage: usage.status === 'fulfilled' ? usage.value : null,
  };
}

function createHandler(apiKey) {
  const routes = {
    '/analyze': { method: 'POST', run: async (req, signal) => analyze(apiKey, await readJsonBody(req), signal) },
    '/models': { method: 'GET', run: (_req, signal) => pangram(apiKey, '/models', { signal }) },
    '/account': { method: 'GET', run: (_req, signal) => account(apiKey, signal) },
  };

  return async function handle(req, res) {
    // Stop talking to Pangram if the browser goes away mid-request.
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });

    try {
      const { pathname } = new URL(req.url || '/', 'http://localhost');
      const route = routes[pathname];
      if (!route) throw new HttpError(404, 'Not found.');
      if (req.method !== route.method) {
        send(res, 405, { error: 'Method not allowed.' }, { Allow: route.method });
        return;
      }

      assertLocalSameOrigin(req);

      if (!apiKey || apiKey === 'your-api-key-here') {
        throw new HttpError(500, 'PANGRAM_API_KEY is not set. Add it to .env and restart the server.');
      }

      send(res, 200, await route.run(req, aborter.signal));
    } catch (err) {
      if (aborter.signal.aborted) return;
      if (err instanceof HttpError) {
        send(
          res,
          err.status,
          { error: err.message },
          err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {},
        );
        return;
      }
      console.error('[pangram-proxy]', err);
      send(res, 500, { error: 'Unexpected error in the local proxy. See the terminal for details.' });
    }
  };
}

export default function pangramProxy(apiKey) {
  const handle = createHandler(apiKey);
  // Must return nothing: Vite treats a returned function as a post-middleware hook.
  const mount = (server) => {
    server.middlewares.use('/api', handle);
  };
  return {
    name: 'pangram-proxy',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
