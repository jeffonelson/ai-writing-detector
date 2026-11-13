# AI Writing Detector

A local web app that checks writing for AI-generated content with the [Pangram API](https://docs.pangram.com/). It shows which passages read as AI-generated, AI-assisted or human, and collects the flagged passages so you can see what to avoid.

## Features

- Paste text or drop a Markdown (`.md`) or text (`.txt`) file. Markdown formatting is removed before analysis.
- Pick the Pangram model from the ones your API key can use.
- A sentence verdict, an AI / AI-assisted / human breakdown, and the text annotated segment by segment.
- A segment table with label, AI score, confidence, humanizer score and word count. Selecting a passage or a row highlights its counterpart.
- Your real Pangram balance and this month's spend in the masthead, plus the measured cost of each scan.
- Flagged phrases saved in the browser across sessions, with a copy-all button.
- `Cmd/Ctrl + Enter` to analyze.

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Put your Pangram API key in `.env`:

```
PANGRAM_API_KEY=your-key
```

```bash
npm run dev
```

The app opens at [http://localhost:5173](http://localhost:5173). `npm run build` followed by `npm run preview` also works; the proxy runs in both.

## How it works

```
Browser  →  /api/*  →  local proxy (adds API key)  →  text.external-api.pangram.com
```

`plugins/pangram-proxy.js` is a Vite plugin that exposes three local routes:

| Route | Pangram call | Spends credits |
|-------|--------------|----------------|
| `POST /api/analyze` | `POST /task`, then polls `GET /task/{id}` | Yes |
| `GET /api/models` | `GET /models` | No |
| `GET /api/account` | `GET /balance` and `GET /usage` | No |

The API key stays in the server process and never reaches the browser. The proxy only answers same-origin requests made to `localhost`, `127.0.0.1` or `[::1]`, so other websites open in your browser cannot spend your credits. That also means the app is not reachable from other devices on your network.

## Cost

Pangram 4 bills per started 100-word block. The app shows the estimated number of billable units before a scan and the actual cost afterwards, taken from the change in your balance.

## Privacy

Text is sent to Pangram for analysis. A public Pangram dashboard link is only created when you tick "Create a public Pangram link".

## Flagged phrases

After each scan the app saves segments that Pangram labeled AI-generated, scored above 60%, or marked as humanized. They live in this browser's localStorage (latest 200).

## Project structure

```
index.html              Page shell
src/main.js             App logic
src/style.css           Styles
plugins/pangram-proxy.js  Local proxy to Pangram
vite.config.js          Vite configuration
.env.example            API key template
```
