#!/usr/bin/env node
/**
 * Command-line AI check for a Markdown or text file.
 *
 *   node bin/check.js post.md                 one whole-document scan
 *   node bin/check.js post.md --chunk         scan in ~100-word chunks; rechecks only pay for edited chunks
 *   node bin/check.js post.md --chunk --json  machine-readable report (for agents)
 *   node bin/check.js post.md --dry-run       show the plan and cost; spends nothing
 *   cat post.md | node bin/check.js -         read from stdin
 *
 * Exit codes: 0 nothing flagged, 1 something flagged, 2 error.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { entryKey, hash, loadCache, saveCache } from '../server/cache.js';
import { HttpError, analyze, assertApiKey } from '../server/pangram.js';
import {
    USD_PER_UNIT,
    billableUnits,
    describeRemoved,
    joinBlocks,
    padChunk,
    planChunks,
    prepareDocument,
    scoreBlocks,
} from '../src/prepare.js';

const ROOT = path.join(import.meta.dirname, '..');
const CACHE_FILE = path.join(ROOT, '.cache', 'checks.json');
const PARALLEL_REQUESTS = 3;

const HELP = `Usage: node bin/check.js <file.md | -> [options]

Options:
  --chunk           Scan in chunks of up to 100 words instead of one request.
                    Same cost on the first run, finer verdicts, and a recheck
                    only pays for chunks whose text changed.
  --model <name>    Pangram model (default: pangram-4)
  --headings        Send headings too (default: headings are left out)
  --json            Print a JSON report instead of text
  --dry-run         Show the plan, word count and cost without calling Pangram
  --max-cost <usd>  Stop before sending if this run would cost more than this
  --no-cache        Ignore stored results and do not store new ones
  --public-link     Ask Pangram for a public dashboard link (whole scans only)
  -h, --help        Show this help

Code blocks, images, captions, tables, HTML, front matter and bare links are never sent.
Results are stored in .cache/checks.json as hashes and scores only.
Exit codes: 0 nothing flagged, 1 something flagged, 2 error.`;

let jsonOutput = process.argv.includes('--json');

function fail(message) {
    if (jsonOutput) console.log(JSON.stringify({ error: message }));
    else console.error(`Error: ${message}`);
    process.exit(2);
}

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

const round = (n, places) => (typeof n === 'number' ? Number(n.toFixed(places)) : n);
const usd = (n) => `$${n.toFixed(2)}`;
const pc = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
const sumWords = (blocks) => blocks.reduce((n, b) => n + b.words, 0);

/** Only what a later run needs from a block's verdict. */
const keepScore = ({ verdict, label, ai_score, confidence, humanized, flagged }) => ({
    verdict, label, ai_score: round(ai_score, 4), confidence, humanized, flagged,
});

/** analyze(), retrying when the submit itself is rate limited. */
async function analyzeWithRetry(apiKey, input) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await analyze(apiKey, input);
        } catch (err) {
            if (!(err instanceof HttpError) || err.status !== 429 || attempt >= 4) throw err;
            await sleep(Math.min((err.retryAfter || 2) * 1000, 15_000));
        }
    }
}

async function runPool(jobs, size, worker) {
    let next = 0;
    let failure = null;
    await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, async () => {
        while (next < jobs.length && !failure) {
            const job = jobs[next++];
            try {
                await worker(job);
            } catch (err) {
                failure ??= err;
            }
        }
    }));
    if (failure) throw failure;
}

async function main() {
    let args;
    try {
        args = parseArgs({
            allowPositionals: true,
            options: {
                chunk: { type: 'boolean', default: false },
                model: { type: 'string', default: 'pangram-4' },
                headings: { type: 'boolean', default: false },
                json: { type: 'boolean', default: false },
                'dry-run': { type: 'boolean', default: false },
                'max-cost': { type: 'string' },
                'no-cache': { type: 'boolean', default: false },
                'public-link': { type: 'boolean', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
        });
    } catch (err) {
        fail(`${err.message}\n\n${HELP}`);
    }
    const { values: opts, positionals } = args;
    jsonOutput = opts.json;

    if (opts.help || positionals.length !== 1) {
        console.log(HELP);
        process.exit(opts.help ? 0 : 2);
    }

    let maxCost = Infinity;
    if (opts['max-cost'] !== undefined) {
        maxCost = Number(opts['max-cost']);
        if (!Number.isFinite(maxCost) || maxCost < 0) fail('--max-cost must be a dollar amount, such as 0.50.');
    }
    if (opts.chunk && opts['public-link']) fail('--public-link only works without --chunk.');

    const file = positionals[0];
    let source;
    try {
        source = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    } catch (err) {
        fail(`Could not read ${file}: ${err.code || err.message}`);
    }

    const prepared = prepareDocument(source, { headings: opts.headings });
    if (!prepared.words) fail('There is no prose to check after cleaning.');
    const { blocks } = prepared;
    const model = opts.model;

    // ── Plan: which runs of paragraphs are already known, which must be sent ──
    const useCache = !opts['no-cache'];
    const cache = useCache ? await loadCache(CACHE_FILE) : { version: 1, entries: {} };
    const runKey = (list) => entryKey(model, list.map((b) => b.text).join('\n\n'));

    let plan;
    if (opts.chunk) {
        const byFirst = new Map();
        for (const [key, entry] of Object.entries(cache.entries)) {
            if (entry.model !== model) continue;
            if (!byFirst.has(entry.first)) byFirst.set(entry.first, []);
            byFirst.get(entry.first).push([key, entry]);
        }
        const firstHash = blocks.map((b) => hash(b.text));
        const findCached = (i) => {
            let best = 0;
            for (const [key, entry] of byFirst.get(firstHash[i]) || []) {
                const count = entry.count;
                if (count > best && i + count <= blocks.length && runKey(blocks.slice(i, i + count)) === key) best = count;
            }
            return best;
        };
        plan = planChunks(blocks, { findCached });
    } else {
        // A public link has to come from a fresh request.
        const known = !opts['public-link'] && cache.entries[runKey(blocks)]?.summary;
        plan = [{ blocks, cached: Boolean(known) }];
    }

    for (const chunk of plan) {
        chunk.key = runKey(chunk.blocks);
        if (chunk.cached) continue;
        chunk.send = joinBlocks(opts.chunk ? padChunk(chunk, blocks) : chunk.blocks);
        chunk.units = billableUnits(chunk.send.words);
    }
    const toSend = plan.filter((c) => !c.cached);
    const units = toSend.reduce((n, c) => n + c.units, 0);
    const cost = units * USD_PER_UNIT;

    const report = {
        file: file === '-' ? null : file,
        model,
        mode: opts.chunk ? 'chunk' : 'whole',
        words: prepared.words,
        removed: prepared.removed,
        requests: { total: plan.length, sent: toSend.length, cached: plan.length - toSend.length },
        billable_units: units,
        estimated_cost_usd: round(cost, 2),
        whole_scan_cost_usd: round(billableUnits(prepared.words) * USD_PER_UNIT, 2),
    };
    const leftOut = describeRemoved(prepared.removed);
    const planLine =
        `${prepared.words} words · ${plan.length} request${plan.length === 1 ? '' : 's'}: ` +
        `${toSend.length} to send (${units} unit${units === 1 ? '' : 's'}, about ${usd(cost)}), ` +
        `${plan.length - toSend.length} from cache`;

    if (opts['dry-run']) {
        if (opts.json) {
            console.log(JSON.stringify({
                ...report,
                dry_run: true,
                chunks: plan.map((c, i) => ({
                    chunk: i + 1,
                    cached: c.cached,
                    lines: [c.blocks[0].line, c.blocks.at(-1).line],
                    words: sumWords(c.blocks),
                    words_sent: c.cached ? 0 : c.send.words,
                    units: c.cached ? 0 : c.units,
                })),
                text: prepared.text,
            }, null, 2));
        } else {
            console.log(planLine);
            if (leftOut) console.log(`Left out: ${leftOut}`);
            if (opts.chunk) {
                console.log('');
                plan.forEach((c, i) => {
                    const own = sumWords(c.blocks);
                    const detail = c.cached
                        ? 'cached'
                        : `send ${c.send.words} words${c.send.words > own ? ` (${c.send.words - own} as context)` : ''}, ${c.units} unit${c.units === 1 ? '' : 's'}`;
                    console.log(`  chunk ${String(i + 1).padStart(2)}  lines ${c.blocks[0].line}-${c.blocks.at(-1).line}  ${String(own).padStart(4)} words  ${detail}`);
                });
            } else {
                console.log('\n--- text that would be sent ---\n');
                console.log(prepared.text);
            }
        }
        return 0;
    }

    if (cost > maxCost + 1e-9) {
        fail(`This run would cost about ${usd(cost)}, over the --max-cost limit of ${usd(maxCost)}. Nothing was sent.`);
    }

    // ── Send what is not cached ──
    let summary = null;
    if (toSend.length) {
        if (!process.env.PANGRAM_API_KEY) {
            try {
                process.loadEnvFile(path.join(ROOT, '.env'));
            } catch {
                // no .env file: assertApiKey reports it
            }
        }
        const apiKey = process.env.PANGRAM_API_KEY;

        try {
            assertApiKey(apiKey);
            await runPool(toSend, PARALLEL_REQUESTS, async (chunk) => {
                const result = await analyzeWithRetry(apiKey, {
                    text: chunk.send.text,
                    model,
                    public_dashboard_link: opts['public-link'],
                });
                // Context paragraphs sent alongside a short chunk are scored but not kept.
                const own = new Set(chunk.blocks.map((b) => b.id));
                chunk.scores = scoreBlocks(chunk.send, result).filter((s) => own.has(s.id)).map(keepScore);
                chunk.summary = {
                    version: result.version ?? null,
                    verdict: result.prediction_short ?? null,
                    prediction: result.prediction ?? result.headline ?? null,
                    fraction_ai: round(Number(result.fraction_ai) || 0, 4),
                    fraction_ai_assisted: round(Number(result.fraction_ai_assisted) || 0, 4),
                    fraction_human: round(Number(result.fraction_human) || 0, 4),
                    pangram_segments: Array.isArray(result.windows) ? result.windows.length : 0,
                };
                chunk.link = result.dashboard_link ?? null;
                cache.entries[chunk.key] = {
                    model,
                    first: hash(chunk.blocks[0].text),
                    count: chunk.blocks.length,
                    at: new Date().toISOString(),
                    summary: chunk.summary,
                    scores: chunk.scores,
                };
            });
        } catch (err) {
            // Keep whatever was already paid for, then report the failure.
            if (useCache) await saveCache(CACHE_FILE, cache).catch(() => {});
            if (err instanceof HttpError) fail(err.message);
            throw err;
        }
        if (useCache) await saveCache(CACHE_FILE, cache);
    }

    // ── Assemble the per-paragraph report ──
    const scored = [];
    plan.forEach((chunk, i) => {
        const entry = chunk.cached ? cache.entries[chunk.key] : chunk;
        chunk.blocks.forEach((b, k) => {
            scored.push({
                id: b.id, type: b.type, line: b.line, words: b.words, text: b.text,
                ...entry.scores[k],
                chunk: i + 1,
                cached: chunk.cached,
            });
        });
        if (!opts.chunk) summary = entry.summary;
    });
    const flagged = scored.filter((b) => b.flagged);

    // In chunk mode there is no single Pangram verdict; report word-weighted shares.
    const share = (verdict) =>
        round(scored.filter((b) => b.verdict === verdict).reduce((n, b) => n + b.words, 0) / prepared.words, 4);
    const totals = opts.chunk
        ? { version: (plan[0].cached ? cache.entries[plan[0].key] : plan[0]).summary?.version ?? null,
            verdict: null, prediction: null,
            fraction_ai: share('ai'), fraction_ai_assisted: share('assisted'), fraction_human: share('human') }
        : summary;

    if (opts.json) {
        console.log(JSON.stringify({
            ...report,
            ...totals,
            dashboard_link: plan[0].link ?? null,
            flagged_count: flagged.length,
            flagged_ids: flagged.map((b) => b.id),
            blocks: scored,
        }, null, 2));
    } else {
        if (totals.prediction) console.log(totals.prediction);
        console.log(`${pc(totals.fraction_ai)} AI-generated · ${pc(totals.fraction_ai_assisted)} AI-assisted · ${pc(totals.fraction_human)} human` +
            (opts.chunk ? ' (by paragraph, word-weighted)' : ''));
        console.log(planLine.replace('to send', 'sent'));
        if (leftOut) console.log(`Left out: ${leftOut}`);
        if (plan[0].link) console.log(`Link: ${plan[0].link}`);

        if (!flagged.length) {
            console.log('\nNothing flagged.');
        } else {
            console.log(`\n${flagged.length} of ${scored.length} paragraphs flagged:\n`);
            for (const b of flagged) {
                const tags = [b.label || 'Flagged', `score ${pc(b.ai_score)}`];
                if (b.confidence) tags.push(`${b.confidence} confidence`);
                if (b.humanized) tags.push('humanized');
                const excerpt = b.text.length > 160 ? `${b.text.slice(0, 160).trimEnd()}…` : b.text;
                console.log(`  line ${b.line}  [${tags.join(' · ')}]\n    ${excerpt}\n`);
            }
        }
    }
    return flagged.length ? 1 : 0;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(err);
        process.exit(2);
    },
);
