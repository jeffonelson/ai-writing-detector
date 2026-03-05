# AI Writing Detector

A local web app that analyzes your writing for AI-generated content using the [Pangram API](https://docs.pangram.com/). It shows you exactly which sections were flagged as AI-generated, AI-assisted, or human-written — and helps you collect the flagged phrases so you know what to avoid.

## Features

- **Paste or drag-and-drop** Markdown (`.md`) and text (`.txt`) files
- **Segment-level annotations** — color-coded text showing exactly which phrases triggered the AI detector
- **Summary stats** — overall AI / AI-Assisted / Human percentages with animated bars
- **Segment detail table** — sortable list of every detected window with label, score, confidence, and word count
- **Flagged phrases collector** — automatically saves AI-flagged segments across sessions so you can review patterns
- **Credit usage tracking** — persistent counter showing how many Pangram credits you've used
- **Keyboard shortcut** — `Cmd/Ctrl + Enter` to analyze
- **Dark editorial aesthetic** — designed to look like a document forensics tool

## Setup

### 1. Install dependencies

```bash
cd /Users/jeff/Documents/ai-writing-detector
npm install
```

### 2. Add your Pangram API key

Copy the example env file and paste in your API key:

```bash
cp .env.example .env
```

Then open the `.env` file and replace `your-api-key-here` with your actual Pangram API key:

```
PANGRAM_API_KEY=pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **Where to get a key**: Sign up at [pangram.com](https://pangram.com), go to your dashboard, and copy your API key.

> **Security note**: The API key is only used by the Vite dev server proxy — it is **never** sent to the browser. The `.env` file is gitignored and will not be committed.

### 3. Run the app

```bash
npm run dev
```

The app will open automatically at [http://localhost:5173](http://localhost:5173).

## How It Works

```
Browser  →  POST /api/analyze  →  Vite Dev Server Proxy  →  Pangram V3 API
                                   (injects API key)
```

The Vite dev server runs a custom plugin (`plugins/pangram-proxy.js`) that intercepts requests to `/api/analyze`, injects your `PANGRAM_API_KEY` header, and forwards the request to `https://text.api.pangram.com/v3`. Your API key never leaves the server process.

## Credit Usage

Pangram charges **1 credit per 1,000 words** (rounded up). The app:
- Shows you the **estimated credit cost** before each scan
- Tracks your **cumulative credit usage** in the header badge (persisted in localStorage)
- Provides a reset button to zero out the counter

## Flagged Phrases

After each scan, the app automatically collects segments that were:
- Labeled as **"AI-Generated"**, or
- Have an **AI assistance score > 60%**

These are saved to localStorage and persist across sessions. Use the **Copy All** button to export them for review. This helps you identify which words, phrases, and patterns are triggering the AI detector.

## Project Structure

```
ai-writing-detector/
├── index.html              # Single-page app shell
├── src/
│   ├── main.js             # Core app logic
│   └── style.css           # Dark editorial design system
├── plugins/
│   └── pangram-proxy.js    # Vite dev server proxy plugin
├── vite.config.js          # Vite configuration
├── .env.example            # API key template
├── .env                    # Your API key (gitignored)
└── package.json
```

## Color Coding

| Color | Meaning |
|-------|---------|
| 🔴 Red | AI-Generated |
| 🟡 Amber | AI-Assisted |
| 🟢 Green | Human-Written |
