# Instructions for AI agents

This repo is a local tool that checks writing against Pangram's AI detector. There are two reasons an agent ends up here: to **use the checker** on a draft, or to **change the code**. Both are covered below. [README.md](README.md) is the human-facing version.

## Using the checker on a draft

Every real check spends the owner's money. Follow these rules.

### Rules

1. **Dry-run first.** `--dry-run` is free and shows the cost. Run it before any paid check on a new file.
2. **Always pass `--max-cost`.** Pick a ceiling that fits the dry-run estimate. The checker sends nothing if the run would exceed it.
3. **Use `--chunk` while iterating.** Unchanged chunks are served from a local cache for free, so a recheck only pays for what you edited.
4. **Do not pass `--no-cache`** and do not delete `.cache/checks.json` unless the owner asks. Either one makes the next run pay full price.
5. **Edit only flagged paragraphs between checks.** Touching an unflagged paragraph changes its chunk's text and makes that chunk billable again.
6. **Do not pass `--public-link`** unless the owner asks. It publishes the text on a shareable Pangram page.
7. **Stop and report rather than loop.** If a paragraph is still flagged after two rewrites, say so and move on. Do not keep spending.
8. **Never print, log or commit the API key.** The checker reads `PANGRAM_API_KEY` from `.env` itself.

### Commands

Run from the repo root. `<file>` can be any path, or `-` for stdin.

```bash
node bin/check.js <file> --chunk --dry-run
```

```bash
node bin/check.js <file> --chunk --json --max-cost 1.00
```

```bash
node bin/check.js <file> --json --max-cost 1.00
```

The first is the free plan. The second is the iteration check. The third is a whole-document scan, used once at the end.

Other options: `--model pangram-4.1` (default `pangram-4`) and `--headings` (send headings too). Keep the model and `--headings` the same across a loop; changing either one misses the cache.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Checked, nothing flagged |
| 1 | Checked, at least one paragraph flagged |
| 2 | Error. With `--json` the output is `{"error": "..."}`. Nothing is charged when the error is a `--max-cost` refusal. |

Exit code 1 is a normal result, not a failure.

### JSON report

```json
{
  "file": "post.md",
  "model": "pangram-4.1",
  "mode": "chunk",
  "words": 328,
  "removed": { "frontMatter": 0, "code": 0, "images": 0, "captions": 0, "tables": 0, "html": 2, "headings": 1, "urls": 0 },
  "requests": { "total": 4, "sent": 1, "cached": 3 },
  "billable_units": 1,
  "estimated_cost_usd": 0.05,
  "whole_scan_cost_usd": 0.2,
  "version": "4.1",
  "verdict": null,
  "prediction": null,
  "fraction_ai": 1,
  "fraction_ai_assisted": 0,
  "fraction_human": 0,
  "dashboard_link": null,
  "flagged_count": 9,
  "flagged_ids": [1, 2, 3],
  "blocks": [
    {
      "id": 1,
      "type": "paragraph",
      "line": 14,
      "words": 65,
      "text": "The paragraph as it was sent, with Markdown removed.",
      "verdict": "ai",
      "label": "AI-Generated",
      "ai_score": 0.5398,
      "confidence": "Low",
      "humanized": false,
      "flagged": true,
      "chunk": 1,
      "cached": true
    }
  ]
}
```

How to read it:

- **`blocks`** is one entry per paragraph, list item or heading, in document order. `line` is the 1-based line in the source file where it starts. Use `line` to find the paragraph to edit; `text` has had Markdown removed and will not match the file byte for byte.
- **`verdict`** is `ai`, `assisted`, `human` or `unknown`. `flagged` is true for `ai`, `assisted`, or any paragraph Pangram marks as humanized.
- **`ai_score`** runs from 0 (human) to 1 (AI). `confidence` is Pangram's `High`, `Medium` or `Low`.
- **`chunk`** is which request the paragraph was sent in. Paragraphs in the same chunk were judged together and usually share a verdict, so a flagged paragraph may be flagged because of its neighbours.
- **`cached`** is true when the verdict came from an earlier run and cost nothing.
- **`estimated_cost_usd`** is what this run cost. `whole_scan_cost_usd` is what one whole-document scan would cost.
- **`verdict`, `prediction` and `dashboard_link` at the top level** are only filled in whole mode. In chunk mode the `fraction_*` fields are word-weighted shares of the paragraph verdicts.

With `--dry-run --json` the report has `dry_run: true`, a `chunks` array (`chunk`, `cached`, `lines`, `words`, `words_sent`, `units`) and the full `text` that would be sent, and no verdicts.

### The loop

1. Dry-run with `--chunk` and tell the owner the estimated cost if it is more than they would expect.
2. Run `--chunk --json --max-cost <ceiling>`.
3. For each block with `flagged: true`, rewrite that paragraph in the source file at `line`. Leave everything else alone.
4. Run step 2 again. `requests.sent` should be about the number of chunks you touched.
5. Stop when `flagged_count` is 0, when a paragraph has survived two rewrites, or when the owner's budget is reached.
6. Finish with one whole scan (no `--chunk`) and report its `prediction` and `fraction_*` values. Chunks are judged with less context than a whole document, so this is the result that counts.

### What to expect from Pangram

- A whole scan often returns a single segment for the entire document. That is why chunk mode exists.
- Short chunks get `Low` or `Medium` confidence. Treat a low-confidence flag as weaker evidence.
- Casual surface edits do not reliably change a verdict. In testing, a deliberately sloppy lowercase rewrite of one paragraph still scored 100% AI with high confidence. Change the substance and structure of a paragraph, not just its tone.
- Very short texts are unreliable in both directions.

### What is and is not sent

Only prose is sent and billed. Code blocks, images and their italic captions, tables, HTML blocks and comments, front matter and bare links are always left out. Headings are left out unless `--headings` is passed. You do not need to strip any of this yourself.

## Changing the code

### Layout

| File | Role |
|------|------|
| `src/prepare.js` | Markdown cleaning, chunk planning, mapping verdicts back to paragraphs. No DOM or Node APIs; shared by the browser and the CLI. |
| `server/pangram.js` | Pangram API client. Shared by the proxy and the CLI. |
| `server/cache.js` | Verdict cache for the CLI. |
| `bin/check.js` | Command-line checker. |
| `plugins/pangram-proxy.js` | Vite plugin: the local proxy the web app calls. |
| `src/main.js`, `src/style.css`, `index.html` | Web app. |

### Commands

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

There is no test suite or linter. After a change, run `npm run build`, and check behaviour with `node bin/check.js <file> --dry-run` (free) before any paid run.

### Constraints

- **Pangram API:** use `POST /task` then `GET /task/{id}` on `text.external-api.pangram.com`. The `text.api.pangram.com` hosts are deprecated. Always send an explicit `model`. Docs: https://docs.pangram.com
- **Keep the proxy locked down.** It must only answer same-origin requests to a loopback host, require `application/json`, and send no CORS headers. It spends real money, so do not loosen these checks.
- **The API key never reaches the browser.** Do not expose it through `import.meta.env`, a response body or a log line.
- **Never use `innerHTML` on untrusted text without `escapeHtml`**, and never parse user Markdown into a live DOM. `src/prepare.js` works from tokens for that reason.
- **Keep `src/prepare.js` free of DOM and Node-only APIs** so both sides can import it.
- **The cache stores hashes and scores only.** Do not add the text.
- **The $0.05 per 100 words rate is measured, not documented.** It lives in `USD_PER_UNIT` in `src/prepare.js`.
- **Testing costs money.** Prefer dry runs and a short excerpt. Tell the owner before a paid run larger than a few units.
- **Style:** white background, IBM Plex Sans and Mono, hairline rules, and one accent colour that only marks AI content. Do not add more colours.
