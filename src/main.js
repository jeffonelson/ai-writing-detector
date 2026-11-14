/**
 * AI Writing Detector: paste text, send it to Pangram through the local proxy,
 * and show which passages read as AI-generated, AI-assisted or human.
 */

import {
    billableUnits,
    countWords,
    describeRemoved,
    labelClass,
    locateWindows,
    prepareDocument,
    scoreBlocks,
} from './prepare.js';

const $ = (id) => document.getElementById(id);

const els = {
    modelPicker: $('model-picker'),
    account: $('account'),
    hero: $('hero'),
    headline: $('headline'),
    dek: $('dek'),
    fineprint: $('fineprint'),
    dropZone: $('drop-zone'),
    textInput: $('text-input'),
    inputStats: $('input-stats'),
    optLink: $('opt-link'),
    optHeadings: $('opt-headings'),
    reviseSection: $('revise-section'),
    reviseSummary: $('revise-summary'),
    reviseTbody: $('revise-tbody'),
    btnAnalyze: $('btn-analyze'),
    btnClear: $('btn-clear'),
    results: $('results'),
    figAi: $('fig-ai'),
    figAssisted: $('fig-assisted'),
    figHuman: $('fig-human'),
    bar: $('bar'),
    barAi: $('bar-ai'),
    barAssisted: $('bar-assisted'),
    barHuman: $('bar-human'),
    annotated: $('annotated-text'),
    segmentTbody: $('segment-tbody'),
    flaggedSection: $('flagged-section'),
    flaggedList: $('flagged-list'),
    btnCopyFlagged: $('btn-copy-flagged'),
    btnClearFlagged: $('btn-clear-flagged'),
};

const MODEL_KEY = 'pangram_model';
const LINK_KEY = 'pangram_public_link';
const HEADINGS_KEY = 'pangram_include_headings';
const FLAGGED_KEY = 'pangram_flagged_phrases';
const FALLBACK_MODELS = ['pangram-4'];
const MAX_FLAGGED = 200;
const IDLE_HEADLINE = 'Paste some writing to see how much of it reads as AI.';

let isAnalyzing = false;
let balance = null;

// ─── Small helpers ───────────────────────────────────────────────

const store = {
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // storage full or unavailable: the app still works without persistence
        }
    },
};

function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

const usd = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
});

function pct(fraction, digits = 0) {
    const n = Number(fraction);
    return `${((Number.isFinite(n) ? n : 0) * 100).toFixed(digits)}%`;
}

function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function modelName(selector) {
    return selector.replace(/^pangram-/, 'Pangram ');
}

async function api(path, options) {
    let res;
    try {
        res = await fetch(path, options);
    } catch {
        throw new Error('Could not reach the local server. Is it still running?');
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        // handled below
    }
    if (!res.ok) throw new Error(data?.error || `The request failed (status ${res.status}).`);
    if (data === null) throw new Error('The local server returned an unreadable response.');
    return data;
}

// ─── Text preparation ────────────────────────────────────────────

/** The prose that gets sent to Pangram, with a map back to the source paragraphs. */
function prepare() {
    return prepareDocument(els.textInput.value, { headings: els.optHeadings.checked });
}

function updateInputStats() {
    const prepared = prepare();
    const { words } = prepared;
    els.btnAnalyze.disabled = words === 0 || isAnalyzing;

    if (words === 0) {
        els.inputStats.textContent = 'Code, images, tables and links are left out before analysis.';
        return;
    }
    const leftOut = describeRemoved(prepared.removed);
    els.inputStats.textContent =
        `${plural(words, 'word')} · about ${plural(billableUnits(words), 'billable unit')}` +
        (leftOut ? ` · left out ${leftOut}` : '');
}

let statsTimer = 0;
function scheduleInputStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateInputStats, 120);
}

// ─── Masthead: models and account ────────────────────────────────

function renderModels(models) {
    const saved = store.get(MODEL_KEY, null);
    const selected = models.includes(saved) ? saved : models.includes('pangram-4') ? 'pangram-4' : models[0];
    els.modelPicker.innerHTML = models
        .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(modelName(m))}</option>`)
        .join('');
    els.modelPicker.value = selected;
}

async function loadModels() {
    renderModels(FALLBACK_MODELS);
    try {
        const data = await api('/api/models');
        const list = Array.isArray(data.models) ? data.models.filter((m) => typeof m === 'string') : [];
        // "default" is an alias; prefer naming the model explicitly when we can.
        const named = list.filter((m) => m !== 'default');
        if (named.length || list.length) renderModels(named.length ? named : list);
    } catch (err) {
        if (!isAnalyzing && els.results.hidden) setHero('error', err.message);
    }
}

async function refreshAccount() {
    try {
        const data = await api('/api/account');
        const parts = [];
        const available = Number(data.balance?.available_balance_usd);
        balance = data.balance && Number.isFinite(available) ? available : null;
        if (balance !== null) parts.push(`Balance <strong>${escapeHtml(usd.format(balance))}</strong>`);

        const spent = Number(data.usage?.total_cost_usd);
        if (data.usage && Number.isFinite(spent)) {
            parts.push(`This month <strong>${escapeHtml(usd.format(spent))}</strong>`);
        }
        els.account.innerHTML = parts.join(' · ');
    } catch {
        balance = null;
        els.account.textContent = '';
    }
    return balance;
}

// ─── Hero ────────────────────────────────────────────────────────

function setHero(state, headline, dek = '', fineprint = []) {
    els.hero.classList.toggle('is-loading', state === 'loading');
    els.hero.classList.toggle('is-error', state === 'error');
    els.headline.textContent = headline;
    els.dek.textContent = dek;
    els.fineprint.replaceChildren(
        ...fineprint.flatMap((part, i) => (i === 0 ? [part] : [' · ', part])),
    );
}

// ─── Analysis ────────────────────────────────────────────────────

async function analyzeText() {
    if (isAnalyzing) return;
    const prepared = prepare();
    const { text, words } = prepared;
    if (!words) return;

    const model = els.modelPicker.value;
    isAnalyzing = true;
    els.btnAnalyze.disabled = true;
    els.btnAnalyze.textContent = 'Analyzing…';
    els.textInput.disabled = true;
    els.modelPicker.disabled = true;
    els.results.hidden = true;
    setHero('loading', `Reading ${plural(words, 'word')} with ${modelName(model)}…`);

    const balanceBefore = balance;
    try {
        const data = await api('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                model,
                public_dashboard_link: els.optLink.checked,
            }),
        });
        renderResults(data, prepared, model);

        // Report what the scan actually cost, when the balance shows it.
        const balanceAfter = await refreshAccount();
        if (balanceBefore !== null && balanceAfter !== null && balanceBefore > balanceAfter) {
            els.fineprint.append(` · Cost ${usd.format(balanceBefore - balanceAfter)}`);
        }
    } catch (err) {
        setHero('error', err.message || 'The analysis failed.');
    } finally {
        isAnalyzing = false;
        els.btnAnalyze.textContent = 'Analyze';
        els.textInput.disabled = false;
        els.modelPicker.disabled = false;
        updateInputStats();
    }
}

// ─── Results ─────────────────────────────────────────────────────

function isHumanized(w) {
    return w.is_humanized === true;
}

function windowTitle(w) {
    const parts = [String(w.label || 'Unlabeled'), `AI score ${pct(w.ai_assistance_score)}`];
    if (w.confidence) parts.push(`${w.confidence} confidence`);
    if (isHumanized(w)) parts.push('humanized');
    return parts.join(' · ');
}

function renderAnnotated(text, windows) {
    const spans = [...windows].sort((a, b) => a.start - b.start);

    let html = '';
    let cursor = 0;
    for (const w of spans) {
        // Windows can overlap; only draw the part that hasn't been drawn yet.
        const start = Math.max(w.start, cursor);
        if (w.end <= start) continue;

        if (start > cursor) html += escapeHtml(text.slice(cursor, start));
        html +=
            `<span class="seg seg--${labelClass(w.label)}" data-index="${w.index}" ` +
            `title="${escapeHtml(windowTitle(w))}">${escapeHtml(text.slice(start, w.end))}</span>`;
        cursor = w.end;
    }
    if (cursor < text.length) html += escapeHtml(text.slice(cursor));

    els.annotated.innerHTML = html;
}

/** Flagged paragraphs of the original document, by source line. */
function renderRevise(blocks) {
    const flagged = blocks.filter((b) => b.flagged);
    els.reviseSummary.textContent = flagged.length
        ? `${flagged.length.toLocaleString()} of ${plural(blocks.length, 'paragraph')} flagged. ` +
          'Pangram judges text in larger segments, so neighbouring paragraphs often share a verdict.'
        : `None of the ${plural(blocks.length, 'paragraph')} were flagged.`;

    els.reviseTbody.innerHTML = flagged
        .map((b) => {
            const excerpt = b.text.length > 180 ? `${b.text.slice(0, 180).trimEnd()}…` : b.text;
            return `
      <tr data-index="${b.window ?? ''}">
        <td class="num faint">${b.line}</td>
        <td class="excerpt">${escapeHtml(excerpt)}</td>
        <td><span class="label label--${b.verdict}">${escapeHtml(b.label || 'Flagged')}${b.humanized ? ' · humanized' : ''}</span></td>
        <td class="num">${b.ai_score === null ? '—' : pct(b.ai_score)}</td>
        <td class="num">${b.words.toLocaleString()}</td>
      </tr>`;
        })
        .join('');
    els.reviseTbody.closest('.table-scroll').hidden = flagged.length === 0;
}

function renderSegments(windows) {
    if (!windows.length) {
        els.segmentTbody.innerHTML = '<tr><td class="empty" colspan="6">Pangram returned no segments.</td></tr>';
        return;
    }

    els.segmentTbody.innerHTML = windows
        .map((w) => {
            const text = String(w.text ?? '');
            const excerpt = text.length > 110 ? `${text.slice(0, 110).trimEnd()}…` : text;
            const cls = labelClass(w.label);

            // Pangram 4.1 adds per-class probabilities: Human, AI-Assisted, AI-Generated.
            const probs = Array.isArray(w.class_probabilities) && w.class_probabilities.length === 3
                ? `Human ${pct(w.class_probabilities[0])} · AI-assisted ${pct(w.class_probabilities[1])} · AI-generated ${pct(w.class_probabilities[2])}`
                : '';

            let humanizer = '<span class="faint">—</span>';
            if (typeof w.humanizer_score === 'number') {
                humanizer = isHumanized(w)
                    ? `<span class="strong">${pct(w.humanizer_score)}</span>`
                    : `<span class="faint">${pct(w.humanizer_score)}</span>`;
            } else if (isHumanized(w)) {
                humanizer = '<span class="strong">Yes</span>';
            }

            return `
      <tr data-index="${w.index}">
        <td class="excerpt">${escapeHtml(excerpt)}</td>
        <td><span class="label label--${cls}">${escapeHtml(w.label || '—')}</span></td>
        <td class="num" title="${escapeHtml(probs)}">${pct(w.ai_assistance_score)}</td>
        <td>${escapeHtml(w.confidence || '—')}</td>
        <td class="num">${humanizer}</td>
        <td class="num">${Number.isFinite(w.word_count) ? w.word_count.toLocaleString() : '—'}</td>
      </tr>`;
        })
        .join('');
}

function renderResults(data, prepared, model) {
    // Pangram may normalize the input; window offsets refer to the text it returns.
    const text = typeof data.text === 'string' && data.text ? data.text : prepared.text;
    const windows = locateWindows(text, data.windows);
    const version = data.version ? `Pangram ${data.version}` : modelName(model);

    const ai = Number(data.fraction_ai) || 0;
    const assisted = Number(data.fraction_ai_assisted) || 0;
    const human = Number(data.fraction_human) || 0;

    const fine = [`${plural(countWords(text), 'word')}`, version];
    if (typeof data.dashboard_link === 'string' && /^https:\/\//i.test(data.dashboard_link)) {
        const link = document.createElement('a');
        link.href = data.dashboard_link;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View on Pangram ↗';
        fine.push(link);
    }

    const humanizedCount = windows.filter(isHumanized).length;
    const dek =
        `${pct(ai)} AI-generated, ${pct(assisted)} AI-assisted and ${pct(human)} human ` +
        `across ${plural(windows.length, 'segment')}.` +
        (humanizedCount
            ? ` ${plural(humanizedCount, 'segment')} ${humanizedCount === 1 ? 'looks' : 'look'} run through a humanizer.`
            : '');

    setHero('result', data.prediction || data.headline || 'Analysis complete.', dek, fine);

    els.figAi.textContent = pct(ai);
    els.figAssisted.textContent = pct(assisted);
    els.figHuman.textContent = pct(human);
    els.barAi.style.flexGrow = String(ai);
    els.barAssisted.style.flexGrow = String(assisted);
    els.barHuman.style.flexGrow = String(human);
    els.bar.setAttribute(
        'aria-label',
        `${pct(ai)} AI-generated, ${pct(assisted)} AI-assisted, ${pct(human)} human`,
    );

    renderRevise(scoreBlocks(prepared, data));
    renderAnnotated(text, windows);
    renderSegments(windows);
    els.results.hidden = false;

    addFlaggedPhrases(windows, data.version);
}

function activate(index, scrollTarget) {
    if (index === undefined || index === '') return;
    for (const el of document.querySelectorAll('.seg.active, #segment-tbody tr.active')) {
        el.classList.remove('active');
    }
    const seg = els.annotated.querySelector(`.seg[data-index="${CSS.escape(index)}"]`);
    const row = els.segmentTbody.querySelector(`tr[data-index="${CSS.escape(index)}"]`);
    seg?.classList.add('active');
    row?.classList.add('active');
    (scrollTarget === 'row' ? row : seg)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Flagged phrases (kept in this browser) ──────────────────────

function getFlagged() {
    const list = store.get(FLAGGED_KEY, []);
    return Array.isArray(list) ? list.filter((p) => p && typeof p.text === 'string') : [];
}

function addFlaggedPhrases(windows, version) {
    const flagged = getFlagged();
    const seen = new Set(flagged.map((p) => p.text));
    const now = new Date().toISOString();

    for (const w of windows) {
        const text = String(w.text ?? '').trim();
        const isFlagged = labelClass(w.label) === 'ai' || w.ai_assistance_score > 0.6 || isHumanized(w);
        if (!isFlagged || !text || seen.has(text)) continue;
        seen.add(text);
        flagged.push({
            text,
            label: w.label,
            score: w.ai_assistance_score,
            confidence: w.confidence,
            is_humanized: w.is_humanized,
            humanizer_score: w.humanizer_score,
            version,
            timestamp: now,
        });
    }

    store.set(FLAGGED_KEY, flagged.slice(-MAX_FLAGGED));
    renderFlagged();
}

function renderFlagged() {
    const flagged = getFlagged();
    els.flaggedSection.hidden = flagged.length === 0;

    els.flaggedList.innerHTML = flagged
        .slice()
        .reverse()
        .map((p) => {
            const date = new Date(p.timestamp);
            const meta = [
                `<span class="label--${labelClass(p.label)}">${escapeHtml(p.label || 'Flagged')}</span>`,
                `score ${pct(p.score)}`,
            ];
            if (p.is_humanized) meta.push('humanized');
            if (!Number.isNaN(date.getTime())) meta.push(escapeHtml(date.toLocaleDateString()));
            return `<li><p class="flagged-text">${escapeHtml(p.text)}</p><p class="flagged-meta">${meta.join(' · ')}</p></li>`;
        })
        .join('');
}

async function copyFlagged() {
    const flagged = getFlagged();
    if (!flagged.length) return;

    const text = flagged
        .map((p) => {
            const bits = [p.label || 'Flagged', `score ${pct(p.score)}`];
            if (p.confidence) bits.push(`${p.confidence} confidence`);
            if (p.is_humanized) bits.push('humanized');
            return `[${bits.join(' | ')}] "${p.text}"`;
        })
        .join('\n\n');

    let label = 'Copied';
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        label = 'Copy failed';
    }
    els.btnCopyFlagged.textContent = label;
    setTimeout(() => {
        els.btnCopyFlagged.textContent = 'Copy all';
    }, 2000);
}

// ─── Drag and drop ───────────────────────────────────────────────

function setupDragDrop() {
    const zone = els.dropZone;
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    zone.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth++;
        zone.classList.add('dragging');
    });

    zone.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) zone.classList.remove('dragging');
    });

    zone.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });

    zone.addEventListener('drop', async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        zone.classList.remove('dragging');
        if (isAnalyzing) return;

        const file = e.dataTransfer.files[0];
        if (!file) return;
        const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
        if (!['md', 'markdown', 'txt', 'text'].includes(ext)) {
            setHero('error', 'That file type is not supported. Drop a .md or .txt file.');
            return;
        }
        if (file.size > 1_000_000) {
            setHero('error', 'That file is too large. The limit is about 1 MB.');
            return;
        }
        try {
            els.textInput.value = await file.text();
            updateInputStats();
        } catch {
            setHero('error', 'That file could not be read.');
        }
    });
}

// ─── Init ────────────────────────────────────────────────────────

function init() {
    setHero('idle', IDLE_HEADLINE);
    els.optLink.checked = store.get(LINK_KEY, false) === true;
    els.optHeadings.checked = store.get(HEADINGS_KEY, false) === true;
    renderFlagged();
    updateInputStats();
    setupDragDrop();

    els.textInput.addEventListener('input', scheduleInputStats);
    els.btnAnalyze.addEventListener('click', analyzeText);
    els.modelPicker.addEventListener('change', () => store.set(MODEL_KEY, els.modelPicker.value));
    els.optLink.addEventListener('change', () => store.set(LINK_KEY, els.optLink.checked));
    els.optHeadings.addEventListener('change', () => {
        store.set(HEADINGS_KEY, els.optHeadings.checked);
        updateInputStats();
    });
    els.reviseTbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-index]');
        if (row) activate(row.dataset.index, 'seg');
    });

    els.btnClear.addEventListener('click', () => {
        if (isAnalyzing) return;
        els.textInput.value = '';
        els.results.hidden = true;
        setHero('idle', IDLE_HEADLINE);
        updateInputStats();
        els.textInput.focus();
    });

    els.annotated.addEventListener('click', (e) => {
        const seg = e.target.closest('.seg');
        if (seg) activate(seg.dataset.index, 'row');
    });
    els.segmentTbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-index]');
        if (row) activate(row.dataset.index, 'seg');
    });

    els.btnCopyFlagged.addEventListener('click', copyFlagged);
    els.btnClearFlagged.addEventListener('click', () => {
        if (confirm('Clear all flagged phrases? This cannot be undone.')) {
            store.set(FLAGGED_KEY, []);
            renderFlagged();
        }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.btnAnalyze.disabled) {
            e.preventDefault();
            analyzeText();
        }
    });

    loadModels();
    refreshAccount();
}

init();
