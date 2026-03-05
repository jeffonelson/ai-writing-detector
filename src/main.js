/**
 * AI Writing Detector — Main Application Logic
 * Handles text input, Pangram API calls, results rendering,
 * credit tracking, and flagged phrase collection.
 */

import { marked } from 'marked';

// ═══════════════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
    textInput: $('#text-input'),
    dropZone: $('#drop-zone'),
    dropOverlay: $('#drop-overlay'),
    wordCount: $('#word-count'),
    creditEstimate: $('#credit-estimate'),
    btnAnalyze: $('#btn-analyze'),
    btnClear: $('#btn-clear'),
    btnResetCredits: $('#btn-reset-credits'),
    creditCount: $('#credit-count'),

    resultsEmpty: $('#results-empty'),
    resultsLoading: $('#results-loading'),
    resultsError: $('#results-error'),
    resultsContent: $('#results-content'),
    errorMessage: $('#error-message'),

    summaryHeadline: $('#summary-headline'),
    summaryPredictionBadge: $('#summary-prediction-badge'),
    summaryAi: $('#summary-ai'),
    summaryAssisted: $('#summary-assisted'),
    summaryHuman: $('#summary-human'),
    barAi: $('#bar-ai'),
    barAssisted: $('#bar-assisted'),
    barHuman: $('#bar-human'),

    annotatedText: $('#annotated-text'),
    segmentTbody: $('#segment-tbody'),
    dashboardLink: $('#dashboard-link'),

    btnCopyFlagged: $('#btn-copy-flagged'),
    btnClearFlagged: $('#btn-clear-flagged'),
    flaggedList: $('#flagged-list'),
    flaggedEmpty: $('#flagged-empty'),
};

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════

let isAnalyzing = false;

// ═══════════════════════════════════════════════════
// CREDIT TRACKING (localStorage)
// ═══════════════════════════════════════════════════

const CREDIT_KEY = 'pangram_credits_used';
const FLAGGED_KEY = 'pangram_flagged_phrases';

function getCreditsUsed() {
    return parseInt(localStorage.getItem(CREDIT_KEY) || '0', 10);
}

function addCredits(n) {
    const total = getCreditsUsed() + n;
    localStorage.setItem(CREDIT_KEY, String(total));
    renderCreditBadge();
}

function resetCredits() {
    localStorage.setItem(CREDIT_KEY, '0');
    renderCreditBadge();
}

function renderCreditBadge() {
    els.creditCount.textContent = getCreditsUsed();
}

function estimateCredits(wordCount) {
    if (wordCount === 0) return 0;
    return Math.ceil(wordCount / 1000);
}

// ═══════════════════════════════════════════════════
// FLAGGED PHRASES (localStorage)
// ═══════════════════════════════════════════════════

function getFlaggedPhrases() {
    try {
        return JSON.parse(localStorage.getItem(FLAGGED_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveFlaggedPhrases(phrases) {
    localStorage.setItem(FLAGGED_KEY, JSON.stringify(phrases));
}

function addFlaggedPhrases(windows) {
    const existing = getFlaggedPhrases();
    const now = new Date().toISOString();

    for (const w of windows) {
        // Flag if AI-Generated OR score > 0.6
        if (w.label === 'AI-Generated' || w.ai_assistance_score > 0.6) {
            // Avoid exact duplicates
            const text = w.text.trim();
            if (text && !existing.some(e => e.text === text)) {
                existing.push({
                    text,
                    label: w.label,
                    score: w.ai_assistance_score,
                    confidence: w.confidence,
                    timestamp: now,
                });
            }
        }
    }

    saveFlaggedPhrases(existing);
    renderFlaggedPhrases();
}

function clearFlaggedPhrases() {
    saveFlaggedPhrases([]);
    renderFlaggedPhrases();
}

function renderFlaggedPhrases() {
    const phrases = getFlaggedPhrases();

    if (phrases.length === 0) {
        els.flaggedList.style.display = 'none';
        els.flaggedEmpty.style.display = 'block';
        return;
    }

    els.flaggedList.style.display = 'flex';
    els.flaggedEmpty.style.display = 'none';

    els.flaggedList.innerHTML = phrases.map((p) => {
        const cls = labelClass(p.label);
        const scoreStr = (p.score * 100).toFixed(0);
        const date = new Date(p.timestamp).toLocaleDateString();
        return `
      <div class="flagged-item">
        <div class="flagged-item-text">${escapeHtml(p.text)}</div>
        <div class="flagged-item-meta">
          <span class="label-badge label-badge--${cls}">${escapeHtml(p.label)}</span>
          <span>Score: ${scoreStr}%</span>
          <span>${date}</span>
        </div>
      </div>
    `;
    }).join('');
}

async function copyFlaggedToClipboard() {
    const phrases = getFlaggedPhrases();
    if (phrases.length === 0) return;

    const text = phrases.map((p) => {
        return `[${p.label} | Score: ${(p.score * 100).toFixed(0)}% | ${p.confidence}] "${p.text}"`;
    }).join('\n\n');

    try {
        await navigator.clipboard.writeText(text);
        els.btnCopyFlagged.textContent = 'Copied!';
        setTimeout(() => { els.btnCopyFlagged.textContent = 'Copy All'; }, 2000);
    } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        els.btnCopyFlagged.textContent = 'Copied!';
        setTimeout(() => { els.btnCopyFlagged.textContent = 'Copy All'; }, 2000);
    }
}

// ═══════════════════════════════════════════════════
// TEXT INPUT & WORD COUNT
// ═══════════════════════════════════════════════════

function countWords(text) {
    const stripped = text.trim();
    if (!stripped) return 0;
    return stripped.split(/\s+/).length;
}

function stripMarkdown(md) {
    // Use marked to parse, then strip HTML tags to get plain text
    const html = marked.parse(md, { async: false });
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent || div.innerText || '';
}

function updateWordCount() {
    const text = els.textInput.value;
    const wc = countWords(text);
    const credits = estimateCredits(wc);

    els.wordCount.textContent = `${wc.toLocaleString()} word${wc !== 1 ? 's' : ''}`;
    els.creditEstimate.textContent = `~${credits} credit${credits !== 1 ? 's' : ''}`;
    els.btnAnalyze.disabled = wc === 0 || isAnalyzing;
}

// ═══════════════════════════════════════════════════
// DRAG & DROP
// ═══════════════════════════════════════════════════

function setupDragDrop() {
    const zone = els.dropZone;
    let dragCounter = 0;

    zone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        zone.classList.add('dragging');
    });

    zone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            zone.classList.remove('dragging');
        }
    });

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        zone.classList.remove('dragging');

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            const file = files[0];
            const ext = file.name.split('.').pop().toLowerCase();

            if (['md', 'txt', 'markdown', 'text'].includes(ext)) {
                const reader = new FileReader();
                reader.onload = () => {
                    els.textInput.value = reader.result;
                    updateWordCount();
                };
                reader.readAsText(file);
            } else {
                showError(`Unsupported file type: .${ext}. Please use .md or .txt files.`);
            }
        }
    });
}

// ═══════════════════════════════════════════════════
// UI STATE MANAGEMENT
// ═══════════════════════════════════════════════════

function showState(state) {
    els.resultsEmpty.style.display = state === 'empty' ? 'flex' : 'none';
    els.resultsLoading.style.display = state === 'loading' ? 'flex' : 'none';
    els.resultsError.style.display = state === 'error' ? 'flex' : 'none';
    els.resultsContent.style.display = state === 'results' ? 'block' : 'none';
}

function showError(msg) {
    els.errorMessage.textContent = msg;
    showState('error');
}

function setAnalyzing(v) {
    isAnalyzing = v;
    els.btnAnalyze.classList.toggle('loading', v);
    els.btnAnalyze.disabled = v;
    els.textInput.disabled = v;
    if (v) showState('loading');
}

// ═══════════════════════════════════════════════════
// API CALL
// ═══════════════════════════════════════════════════

async function analyzeText() {
    const rawText = els.textInput.value.trim();
    if (!rawText) return;

    // Detect if it looks like markdown and strip it
    const hasMarkdown = /[#*_\[\]`>-]{2,}|^\s*#{1,6}\s/m.test(rawText);
    const plainText = hasMarkdown ? stripMarkdown(rawText) : rawText;

    const wordCount = countWords(plainText);
    const creditsUsed = estimateCredits(wordCount);

    setAnalyzing(true);

    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: plainText }),
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || `API returned status ${res.status}`);
        }

        // Track credits
        addCredits(creditsUsed);

        // Render results
        renderResults(data, plainText);
        showState('results');

    } catch (err) {
        showError(err.message || 'Failed to analyze text. Check your API key and try again.');
    } finally {
        setAnalyzing(false);
        updateWordCount();
    }
}

// ═══════════════════════════════════════════════════
// RESULTS RENDERING
// ═══════════════════════════════════════════════════

function renderResults(data, plainText) {
    // Summary
    els.summaryHeadline.textContent = data.headline || data.prediction || '—';
    els.summaryPredictionBadge.textContent = data.prediction_short || '—';
    els.summaryPredictionBadge.setAttribute('data-prediction', data.prediction_short || '');

    const aiPct = ((data.fraction_ai || 0) * 100).toFixed(1);
    const assistedPct = ((data.fraction_ai_assisted || 0) * 100).toFixed(1);
    const humanPct = ((data.fraction_human || 0) * 100).toFixed(1);

    els.summaryAi.textContent = `${aiPct}%`;
    els.summaryAssisted.textContent = `${assistedPct}%`;
    els.summaryHuman.textContent = `${humanPct}%`;

    // Animate bars
    requestAnimationFrame(() => {
        els.barAi.style.width = `${aiPct}%`;
        els.barAssisted.style.width = `${assistedPct}%`;
        els.barHuman.style.width = `${humanPct}%`;
    });

    // Dashboard link
    if (data.dashboard_link) {
        els.dashboardLink.href = data.dashboard_link;
        els.dashboardLink.style.display = 'inline-flex';
    } else {
        els.dashboardLink.style.display = 'none';
    }

    // Annotated text
    renderAnnotatedText(data, plainText);

    // Segment table
    renderSegmentTable(data.windows || []);

    // Flagged phrases
    addFlaggedPhrases(data.windows || []);
}

function labelClass(label) {
    if (!label) return 'human';
    const l = label.toLowerCase();
    if (l.includes('ai-generated') || l === 'ai-generated') return 'ai';
    if (l.includes('assisted') || l.includes('moderate')) return 'assisted';
    return 'human';
}

function renderAnnotatedText(data, plainText) {
    const windows = data.windows || [];

    if (windows.length === 0) {
        els.annotatedText.textContent = plainText;
        return;
    }

    // Sort windows by start_index
    const sorted = [...windows].sort((a, b) => a.start_index - b.start_index);

    let html = '';
    let lastEnd = 0;

    for (let i = 0; i < sorted.length; i++) {
        const w = sorted[i];
        const start = w.start_index;
        const end = w.end_index;

        // Gap between segments
        if (start > lastEnd) {
            html += escapeHtml(plainText.slice(lastEnd, start));
        }

        const cls = labelClass(w.label);
        const scoreStr = (w.ai_assistance_score * 100).toFixed(0);
        const segText = plainText.slice(start, end);

        html += `<span class="seg seg--${cls}" data-index="${i}">`;
        html += escapeHtml(segText);
        html += `<span class="seg-tooltip">`;
        html += `<span class="seg-tooltip-label">${escapeHtml(w.label)}</span>`;
        html += `<span class="seg-tooltip-score">Score: ${scoreStr}%</span>`;
        html += `<span class="seg-tooltip-confidence">${escapeHtml(w.confidence)}</span>`;
        html += `</span>`;
        html += `</span>`;

        lastEnd = end;
    }

    // Remaining text after last segment
    if (lastEnd < plainText.length) {
        html += escapeHtml(plainText.slice(lastEnd));
    }

    els.annotatedText.innerHTML = html;

    // Click to highlight in table
    els.annotatedText.querySelectorAll('.seg').forEach((seg) => {
        seg.addEventListener('click', () => {
            const idx = seg.dataset.index;
            highlightTableRow(idx);
        });
    });
}

function renderSegmentTable(windows) {
    if (windows.length === 0) {
        els.segmentTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">No segments returned.</td></tr>';
        return;
    }

    els.segmentTbody.innerHTML = windows.map((w, i) => {
        const cls = labelClass(w.label);
        const scoreStr = (w.ai_assistance_score * 100).toFixed(0);
        const excerpt = w.text.length > 80 ? w.text.slice(0, 80) + '…' : w.text;

        return `
      <tr data-index="${i}">
        <td title="${escapeHtml(w.text)}">${escapeHtml(excerpt)}</td>
        <td><span class="label-badge label-badge--${cls}">${escapeHtml(w.label)}</span></td>
        <td>${scoreStr}%</td>
        <td>${escapeHtml(w.confidence)}</td>
        <td>${w.word_count}</td>
      </tr>
    `;
    }).join('');

    // Click table row to highlight annotation
    els.segmentTbody.querySelectorAll('tr').forEach((row) => {
        row.addEventListener('click', () => {
            const idx = row.dataset.index;
            highlightAnnotation(idx);
        });
    });
}

function highlightTableRow(idx) {
    els.segmentTbody.querySelectorAll('tr').forEach(r => r.classList.remove('highlight'));
    const row = els.segmentTbody.querySelector(`tr[data-index="${idx}"]`);
    if (row) {
        row.classList.add('highlight');
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function highlightAnnotation(idx) {
    els.annotatedText.querySelectorAll('.seg').forEach(s => s.classList.remove('active'));
    const seg = els.annotatedText.querySelector(`.seg[data-index="${idx}"]`);
    if (seg) {
        seg.classList.add('active');
        seg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ═══════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════

function escapeHtml(str) {
    if (!str) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return str.replace(/[&<>"']/g, (c) => map[c]);
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

function init() {
    // Render initial states
    renderCreditBadge();
    renderFlaggedPhrases();
    updateWordCount();
    showState('empty');

    // Event listeners
    els.textInput.addEventListener('input', updateWordCount);
    els.btnAnalyze.addEventListener('click', analyzeText);

    els.btnClear.addEventListener('click', () => {
        els.textInput.value = '';
        updateWordCount();
        showState('empty');
        els.dashboardLink.style.display = 'none';
    });

    els.btnResetCredits.addEventListener('click', () => {
        if (confirm('Reset credit counter to 0?')) {
            resetCredits();
        }
    });

    els.btnCopyFlagged.addEventListener('click', copyFlaggedToClipboard);
    els.btnClearFlagged.addEventListener('click', () => {
        if (confirm('Clear all flagged phrases? This cannot be undone.')) {
            clearFlaggedPhrases();
        }
    });

    // Drag & drop
    setupDragDrop();

    // Keyboard shortcut: Ctrl/Cmd + Enter to analyze
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            if (!els.btnAnalyze.disabled) {
                analyzeText();
            }
        }
    });
}

init();
