/**
 * Turns a Markdown (or plain text) document into the prose that gets sent to
 * Pangram, and maps Pangram's verdicts back onto the original paragraphs.
 *
 * No DOM access, so the web app and the command-line checker share it.
 */

import { marked } from 'marked';

export const WORDS_PER_UNIT = 100; // Pangram 4 bills per started 100-word block
export const USD_PER_UNIT = 0.05; // measured from the account balance, not documented

const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/i;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const FRONT_MATTER = /^﻿?---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

export function countWords(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function billableUnits(words) {
    return words > 0 ? Math.ceil(words / WORDS_PER_UNIT) : 0;
}

export function labelClass(label) {
    const l = String(label || '').toLowerCase();
    if (l.includes('assist') || l.includes('mixed')) return 'assisted';
    if (l.includes('ai')) return 'ai';
    return 'human';
}

function decodeEntities(text) {
    return String(text ?? '').replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, (m) => ENTITIES[m]);
}

/** Plain text of inline Markdown: keeps the words, drops images and bare links. */
function inlineText(tokens, removed) {
    let out = '';
    for (const t of tokens || []) {
        switch (t.type) {
            case 'image':
                removed.images++;
                break;
            case 'link': {
                const text = inlineText(t.tokens, removed);
                if (URL_ONLY.test(text.trim())) removed.urls++;
                else out += text;
                break;
            }
            case 'html': // inline tags such as <span> or <br>
                break;
            case 'br':
                out += ' ';
                break;
            case 'codespan':
                out += decodeEntities(t.text);
                break;
            default:
                out += t.tokens ? inlineText(t.tokens, removed) : decodeEntities(t.text);
        }
    }
    return out;
}

/** An image followed only by an italic line: a figure and its caption, not prose. */
function isCaptionedImage(tokens) {
    if (!tokens?.some((t) => t.type === 'image')) return false;
    const rest = tokens.filter((t) => t.type !== 'image' && t.type !== 'br' && !(t.type === 'text' && !t.text.trim()));
    return rest.length > 0 && rest.every((t) => t.type === 'em');
}

function tidy(text, removed) {
    return text
        .replace(BARE_URL, () => {
            removed.urls++;
            return '';
        })
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string} source Markdown or plain text
 * @param {{ headings?: boolean }} [options] headings: send headings too (default: drop them)
 * @returns {{ text: string, words: number, blocks: Array, removed: object }}
 *   `text` is what to send. Each block is one paragraph, list item or heading with
 *   its line in the source and its [start, end) offsets in `text`.
 */
export function prepareDocument(source, options = {}) {
    const removed = { frontMatter: 0, code: 0, images: 0, captions: 0, tables: 0, html: 0, headings: 0, urls: 0 };
    let doc = String(source ?? '').replace(/\r\n?/g, '\n');

    let bodyOffset = 0;
    const fm = doc.match(FRONT_MATTER);
    if (fm) {
        removed.frontMatter = 1;
        bodyOffset = fm[0].length;
    }
    const body = doc.slice(bodyOffset);

    const pieces = [];
    const add = (type, text, offset) => {
        const clean = tidy(text, removed);
        if (clean) pieces.push({ type, text: clean, offset });
    };

    const walk = (tokens, from) => {
        let cursor = from;
        for (const t of tokens || []) {
            const found = t.raw ? body.indexOf(t.raw, cursor) : -1;
            const pos = found === -1 ? cursor : found;
            if (found !== -1) cursor = found + t.raw.length;

            switch (t.type) {
                case 'space':
                case 'hr':
                case 'def':
                    break;
                case 'code':
                    // Indented "code" in pasted prose is usually just an indented paragraph.
                    if (t.codeBlockStyle === 'indented') add('paragraph', t.text, pos);
                    else removed.code++;
                    break;
                case 'table':
                    removed.tables++;
                    break;
                case 'html':
                    removed.html++;
                    break;
                case 'heading':
                    if (options.headings) add('heading', inlineText(t.tokens, removed), pos);
                    else removed.headings++;
                    break;
                case 'blockquote':
                    walk(t.tokens, pos);
                    break;
                case 'list':
                    {
                        let itemCursor = pos;
                        for (const item of t.items || []) {
                            const at = item.raw ? body.indexOf(item.raw, itemCursor) : -1;
                            const itemPos = at === -1 ? itemCursor : at;
                            if (at !== -1) itemCursor = at + item.raw.length;
                            walk(item.tokens, itemPos);
                        }
                    }
                    break;
                default:
                    if (isCaptionedImage(t.tokens)) {
                        removed.images++;
                        removed.captions++;
                        break;
                    }
                    // paragraph, or the loose "text" inside a tight list item
                    add(t.type === 'paragraph' || t.type === 'text' ? 'paragraph' : t.type,
                        t.tokens ? inlineText(t.tokens, removed) : decodeEntities(t.text), pos);
            }
        }
    };
    walk(marked.lexer(body), 0);

    const lineAt = (offset) => {
        let line = 1;
        for (let i = 0; i < offset && i < doc.length; i++) if (doc.charCodeAt(i) === 10) line++;
        return line;
    };

    const joined = joinBlocks(pieces.map((p, i) => {
        // Skip leading blank lines/markers so the line points at the first real line.
        const lead = body.slice(p.offset).match(/^\s*/)[0].length;
        return {
            id: i + 1,
            type: p.type,
            line: lineAt(bodyOffset + p.offset + lead),
            text: p.text,
            words: countWords(p.text),
        };
    }));

    return { ...joined, removed };
}

/** Joins blocks into one text to send, recording each block's [start, end) in it. */
export function joinBlocks(blocks) {
    let text = '';
    const placed = blocks.map((b, i) => {
        if (i > 0) text += '\n\n';
        const start = text.length;
        text += b.text;
        return { ...b, start, end: text.length };
    });
    return { text, words: countWords(text), blocks: placed };
}

/**
 * Splits blocks into chunks for separate requests. Billing rounds every request
 * up to a whole unit, so this picks the split with the fewest total units, and
 * among those the one with the most chunks (finer verdicts, cheaper rechecks).
 *
 * `findCached(i)` returns how many blocks starting at index i are already covered
 * by a stored result (0 if none); those runs become free chunks and are never
 * merged into a neighbour, so editing one paragraph only re-sends its own chunk.
 */
export function planChunks(blocks, { limit = WORDS_PER_UNIT, maxUnits = 3, findCached = () => 0 } = {}) {
    const chunks = [];
    let i = 0;
    while (i < blocks.length) {
        const hit = findCached(i);
        if (hit > 0) {
            chunks.push({ blocks: blocks.slice(i, i + hit), cached: true });
            i += hit;
            continue;
        }
        let end = i + 1;
        while (end < blocks.length && !findCached(end)) end++;
        for (const group of cheapestSplit(blocks.slice(i, end), limit, maxUnits * limit)) {
            chunks.push({ blocks: group, cached: false });
        }
        i = end;
    }
    return chunks;
}

function cheapestSplit(blocks, limit, maxWords) {
    const n = blocks.length;
    const prefix = [0];
    for (const b of blocks) prefix.push(prefix[prefix.length - 1] + b.words);

    // best[i]: cheapest way to split the first i blocks
    const best = [{ cost: 0, count: 0, from: 0 }];
    for (let i = 1; i <= n; i++) {
        best[i] = { cost: Infinity, count: 0, from: i - 1 };
        for (let j = i - 1; j >= 0; j--) {
            const words = prefix[i] - prefix[j];
            if (words > maxWords && j < i - 1) break;
            const cost = best[j].cost + Math.max(1, Math.ceil(words / limit));
            const count = best[j].count + 1;
            if (cost < best[i].cost || (cost === best[i].cost && count > best[i].count)) {
                best[i] = { cost, count, from: j };
            }
        }
    }

    const groups = [];
    for (let i = n; i > 0; i = best[i].from) groups.unshift(blocks.slice(best[i].from, i));
    return groups;
}

/**
 * A very short chunk costs a full unit and gets a low-confidence verdict. This
 * picks neighbouring blocks to send along as context, inside the same unit.
 * Returns the blocks to send, in document order; only the chunk's own blocks are scored.
 */
export function padChunk(chunk, allBlocks, { limit = WORDS_PER_UNIT, minWords = 50 } = {}) {
    const own = chunk.blocks;
    let words = own.reduce((n, b) => n + b.words, 0);
    if (words >= minWords) return own;

    const first = allBlocks.findIndex((b) => b.id === own[0].id);
    const last = first + own.length - 1;
    const before = [];
    const after = [];
    for (let k = first - 1; k >= 0 && words + allBlocks[k].words <= limit; k--) {
        words += allBlocks[k].words;
        before.unshift(allBlocks[k]);
    }
    for (let k = last + 1; k < allBlocks.length && words + allBlocks[k].words <= limit; k++) {
        words += allBlocks[k].words;
        after.push(allBlocks[k]);
    }
    return [...before, ...own, ...after];
}

/** "2 code blocks, 3 images" for whatever was left out; empty string if nothing was. */
export function describeRemoved(removed) {
    const names = {
        frontMatter: ['front matter', 'front matter'],
        code: ['code block', 'code blocks'],
        images: ['image', 'images'],
        captions: ['caption', 'captions'],
        tables: ['table', 'tables'],
        html: ['HTML block', 'HTML blocks'],
        headings: ['heading', 'headings'],
        urls: ['bare link', 'bare links'],
    };
    return Object.entries(names)
        .filter(([key]) => removed[key] > 0)
        .map(([key, [one, many]]) =>
            key === 'frontMatter' ? one : `${removed[key]} ${removed[key] === 1 ? one : many}`)
        .join(', ');
}

/**
 * Pangram's window offsets may count Unicode code points while JS strings count
 * UTF-16 units. Returns the windows with `start`/`end` as JS string offsets into
 * `text`, plus each window's position in the API response as `index`.
 */
export function locateWindows(text, rawWindows) {
    const windows = (Array.isArray(rawWindows) ? rawWindows : [])
        .map((w, index) => ({ ...w, index }))
        .filter((w) => Number.isInteger(w.start_index) && Number.isInteger(w.end_index));

    const points = Array.from(text);
    let toUnit = (n) => n;
    if (points.length !== text.length) {
        let unitHits = 0;
        let pointHits = 0;
        for (const w of windows) {
            if (text.slice(w.start_index, w.end_index) === w.text) unitHits++;
            if (points.slice(w.start_index, w.end_index).join('') === w.text) pointHits++;
        }
        if (pointHits > unitHits) {
            const prefix = [0];
            for (const p of points) prefix.push(prefix[prefix.length - 1] + p.length);
            toUnit = (n) => prefix[Math.max(0, Math.min(n, points.length))];
        }
    }

    const clamp = (n) => Math.max(0, Math.min(n, text.length));
    return windows
        .map((w) => ({ ...w, start: clamp(toUnit(w.start_index)), end: clamp(toUnit(w.end_index)) }))
        .filter((w) => w.end > w.start);
}

const SKIPPABLE = /[\s​-‍︀-️﻿]/;

/**
 * Pangram may normalize the text it analyzes (whitespace, emoji selectors).
 * Returns a function mapping an offset in `sent` to the matching offset in `returned`.
 */
function alignOffsets(sent, returned) {
    if (sent === returned) return (n) => n;

    const map = new Int32Array(sent.length + 1);
    let i = 0;
    let j = 0;
    while (i < sent.length) {
        map[i] = Math.min(j, returned.length);
        if (j >= returned.length) i++;
        else if (sent[i] === returned[j]) (i++, j++);
        else if (SKIPPABLE.test(sent[i])) i++;
        else if (SKIPPABLE.test(returned[j])) j++;
        else (i++, j++);
    }
    map[sent.length] = Math.min(j, returned.length);
    return (n) => map[Math.max(0, Math.min(n, sent.length))];
}

/**
 * Gives every block from prepareDocument() the verdict of the Pangram window(s)
 * covering it. Pangram's windows are usually larger than a paragraph, so
 * neighbouring paragraphs often share one verdict.
 */
export function scoreBlocks(prepared, result) {
    const returned = typeof result?.text === 'string' && result.text ? result.text : prepared.text;
    const windows = locateWindows(returned, result?.windows);
    const toReturned = alignOffsets(prepared.text, returned);

    return prepared.blocks.map((block) => {
        const start = toReturned(block.start);
        const end = toReturned(block.end);

        let covered = 0;
        let weighted = 0;
        let best = null;
        let bestOverlap = 0;
        let humanized = false;
        for (const w of windows) {
            const overlap = Math.min(end, w.end) - Math.max(start, w.start);
            if (overlap <= 0) continue;
            covered += overlap;
            weighted += overlap * (Number(w.ai_assistance_score) || 0);
            if (w.is_humanized === true) humanized = true;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                best = w;
            }
        }

        const verdict = best ? labelClass(best.label) : 'unknown';
        return {
            id: block.id,
            type: block.type,
            line: block.line,
            words: block.words,
            text: block.text,
            verdict,
            label: best?.label ?? null,
            ai_score: covered ? weighted / covered : null,
            confidence: best?.confidence ?? null,
            humanized,
            window: best ? best.index : null,
            flagged: verdict === 'ai' || verdict === 'assisted' || humanized,
        };
    });
}
