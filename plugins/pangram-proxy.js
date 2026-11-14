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
import { HttpError, account, analyze, assertApiKey, listModels } from '../server/pangram.js';

const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

function createHandler(apiKey) {
  const routes = {
    '/analyze': { method: 'POST', run: async (req, signal) => analyze(apiKey, await readJsonBody(req), signal) },
    '/models': { method: 'GET', run: (_req, signal) => listModels(apiKey, signal) },
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
      assertApiKey(apiKey);

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
