/**
 * Local store of past Pangram verdicts, so unchanged text is never paid for twice.
 * Holds only hashes and scores, never the text itself.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const MAX_ENTRIES = 5000;

export const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** Identifies one checked run of paragraphs under one model. */
export const entryKey = (model, text) => hash(`${model}\0${text}`);

export async function loadCache(file) {
    try {
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (data?.version === VERSION && data.entries && typeof data.entries === 'object') return data;
    } catch {
        // missing or unreadable cache: start empty
    }
    return { version: VERSION, entries: {} };
}

export async function saveCache(file, cache) {
    const keys = Object.keys(cache.entries);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (cache.entries[a].at < cache.entries[b].at ? -1 : 1));
        for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache.entries[key];
    }
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(cache));
    await rename(temp, file); // atomic, so an interrupted run cannot corrupt the cache
}
