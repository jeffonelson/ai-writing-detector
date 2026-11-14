/**
 * Pangram API client (Node). Used by the Vite proxy and the command-line checker.
 * Errors are thrown as HttpError with a message that is safe to show to the user.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const PANGRAM = 'https://text.external-api.pangram.com';
const UPSTREAM_TIMEOUT_MS = 20_000;
const TASK_DEADLINE_MS = 120_000;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const STATUS_MESSAGES = {
  401: 'Pangram rejected the API key. Check PANGRAM_API_KEY in .env.',
  402: 'Your Pangram account is out of credits.',
  403: 'This API key is not allowed to use that model.',
  413: 'That text is too large for Pangram to accept.',
  429: 'Pangram rate limit reached. Wait a moment and try again.',
  503: 'That Pangram model is temporarily unavailable. Try again shortly.',
};

export class HttpError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function assertApiKey(apiKey) {
  if (!apiKey || apiKey === 'your-api-key-here') {
    throw new HttpError(500, 'PANGRAM_API_KEY is not set. Add it to .env.');
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

async function request(apiKey, path, { method = 'GET', body, signal } = {}) {
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

/** Submit text and wait for the finished result. Spends credits. */
export async function analyze(apiKey, input, signal) {
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

  const created = await request(apiKey, '/task', {
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
      task = await request(apiKey, `/task/${encodeURIComponent(taskId)}`, { signal });
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

/** Model selectors this key can use. Free. */
export function listModels(apiKey, signal) {
  return request(apiKey, '/models', { signal });
}

/** Balance and this month's usage. Free. */
export async function account(apiKey, signal) {
  const [balance, usage] = await Promise.allSettled([
    request(apiKey, '/balance', { signal }),
    request(apiKey, '/usage', { signal }),
  ]);
  if (balance.status === 'rejected' && usage.status === 'rejected') throw balance.reason;
  return {
    balance: balance.status === 'fulfilled' ? balance.value : null,
    usage: usage.status === 'fulfilled' ? usage.value : null,
  };
}
