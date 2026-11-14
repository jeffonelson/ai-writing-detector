# AI Writing Detector

Checks writing for AI-generated content with the [Pangram API](https://docs.pangram.com/) and tells you which paragraphs to revise. It runs on your machine and comes in two forms:

- A **web app** for pasting a draft and reading the result.
- A **command-line checker** for scripts and AI agents that draft, check and revise in a loop. Agents should read [AGENTS.md](AGENTS.md).

## Setup

Requires Node.js 20.19 or later (22.12 or later on the 22 line) and a Pangram API key.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your key in `.env`:

```
PANGRAM_API_KEY=your-key
```

## Web app

```bash
npm run dev
```

The app opens at [http://localhost:5173](http://localhost:5173). `npm run build` followed by `npm run preview` also works.

1. Paste text, or drop a `.md` or `.txt` file onto the text box.
2. Pick a model in the masthead. The list comes from your API key.
3. Press **Analyze** (or `Cmd/Ctrl + Enter`).

What you get back:

- **Verdict:** Pangram's one-sentence conclusion and the AI / AI-assisted / human split.
- **Paragraphs to revise:** each flagged paragraph with its line number in your original text.
- **Annotated text:** the text as sent, with AI-generated passages highlighted and AI-assisted ones underlined.
- **Segments:** Pangram's own segments with label, AI score, confidence, humanizer score and word count.
- **Flagged phrases:** passages labeled AI-generated, scored above 60% or marked as humanized, saved in this browser across sessions (latest 200).

The masthead shows your real Pangram balance and this month's spend. The text box footer shows the word count and billable units before you scan, and the verdict line shows what the scan actually cost.

Options under the text box:

- **Include headings** sends headings too. They are left out by default.
- **Create a public Pangram link** asks Pangram for a shareable dashboard link. Off by default.

## Command-line checker

See what would be sent and what it would cost, without spending anything:

```bash
node bin/check.js post.md --dry-run
```

Run one whole-document scan:

```bash
node bin/check.js post.md
```

Run a chunked scan with a machine-readable report:

```bash
node bin/check.js post.md --chunk --json
```

| Option | What it does |
|--------|--------------|
| `--chunk` | Scan in chunks instead of one request. See below. |
| `--json` | Print a JSON report instead of text. |
| `--dry-run` | Print the plan, word count and cost without calling Pangram. |
| `--max-cost 0.50` | Refuse to send anything if the run would cost more than this. |
| `--model pangram-4.1` | Choose the model. Default is `pangram-4`. |
| `--headings` | Send headings too. |
| `--no-cache` | Ignore stored results and store nothing. |
| `--public-link` | Ask for a public dashboard link. Whole scans only. |

Use `-` as the file to read from stdin. The exit code is 0 when nothing is flagged, 1 when something is, and 2 on error.

### Chunk mode and the cache

A whole-document scan usually comes back as one big segment, which says little about which paragraphs to fix. `--chunk` splits the document at paragraph boundaries and sends each chunk separately, so you get a verdict per chunk.

Pangram bills each request per started 100-word block, so the checker picks the split with the fewest billable units. That is usually within a unit or two of a whole scan. Chunks run from under 100 to about 300 words.

Every result is stored in `.cache/checks.json`, keyed by a hash of the chunk's text and the model. On the next run, unchanged chunks cost nothing and only chunks containing an edited paragraph are sent again. The cache holds hashes and scores, never your text, and is not committed to git. Delete the file to start fresh.

A chunk under 50 words is sent with neighbouring paragraphs as context when they fit in the same billing unit.

Chunks are judged with less context than a whole document, and short ones come back with lower confidence. Finish with one whole-document scan before publishing.

### A typical revision loop

1. `--chunk --dry-run` to see the cost.
2. `--chunk` to find the flagged paragraphs.
3. Rewrite those paragraphs.
4. `--chunk` again. Only the edited chunks are charged.
5. Repeat 3 and 4, then run one whole scan as the final check.

## What gets sent

Only prose. These are always left out:

- Code blocks
- Images and the italic caption line under them
- Tables
- HTML blocks and comments
- Front matter
- Bare links

Headings are left out unless you opt in. Inline formatting is removed but the words are kept, including link text and inline code.

## Cost

Pangram 4 costs $0.05 per started 100-word block, per request. That rate was measured from the account balance; Pangram's docs do not state it. A 1,580-word post is about $0.80 for a whole scan.

## Privacy and security

- Your text is sent to Pangram for analysis. Nothing else leaves your machine.
- The API key stays in the local server process and never reaches the browser.
- The web app's proxy only answers same-origin requests made to `localhost`, `127.0.0.1` or `[::1]`, so other websites open in your browser cannot spend your credits. The app is therefore not reachable from other devices on your network.
- A public Pangram link is only created when you ask for one.

## How it works

```
Browser  →  /api/*  →  local proxy (adds API key)  →  text.external-api.pangram.com
bin/check.js  ───────────────────────────────────→  text.external-api.pangram.com
```

The proxy is a Vite plugin with three routes:

| Route | Pangram call | Spends credits |
|-------|--------------|----------------|
| `POST /api/analyze` | `POST /task`, then polls `GET /task/{id}` | Yes |
| `GET /api/models` | `GET /models` | No |
| `GET /api/account` | `GET /balance` and `GET /usage` | No |

## Project structure

```
index.html                Page shell
src/main.js               Web app logic
src/style.css             Styles
src/prepare.js            Markdown cleaning, chunk planning, paragraph mapping (shared)
server/pangram.js         Pangram API client (shared)
server/cache.js           Stored verdicts for the checker
bin/check.js              Command-line checker
plugins/pangram-proxy.js  Local proxy used by the web app
vite.config.js            Vite configuration
.env.example              API key template
AGENTS.md                 Instructions for AI agents
```
