# DraftPilot

AI-powered writing assistant for Google Docs — grammar, tone, style, fact-checking, and more. Powered by [GitHub Copilot SDK](https://github.com/github/copilot-sdk).

## Features

- **Grammar & style suggestions** — inline accept/dismiss with one-click apply to your document
- **Target tone** — set a per-document target tone; analysis flags deviations
- **Writing Quality score** — hybrid score (0–100) based on suggestions, readability, vocabulary diversity, and sentence variety
- **Flesch Reading Ease** — instant readability calculation
- **AI Detection** — estimates how much of the text appears AI-generated
- **Publish readiness** — tells you when your doc is ready to ship
- **Fact-check research** — extracts verifiable claims, then lets you verify each one via web search
- **Chat interface** — ask the AI to rephrase, expand, summarize, or edit your text
- **Memory** — learns your writing preferences over time
- **Multi-tab support** — works with Google Docs that have multiple tabs

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [GitHub Copilot CLI](https://docs.github.com/en/copilot) installed and authenticated (`gh auth login`)
- A Google Cloud project with the **Google Docs API** enabled and an OAuth 2.0 client ID (Chrome app type)

## Setup

### 1. Configure the extension

```bash
cp extension/manifest.example.json extension/manifest.json
```

Edit `extension/manifest.json` and replace `YOUR_GOOGLE_OAUTH_CLIENT_ID` with your Google OAuth client ID.

### 2. Start the server

```bash
cd server
npm install
npm run dev
```

### 3. Load the Chrome extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Navigate to a Google Doc and click the DraftPilot icon

## Usage

1. Click **Analyze** to get suggestions, scores, and tone analysis
2. **Accept** or **Dismiss** suggestions (applied directly to your doc)
3. **Double-click the tone pill** to set a target tone for this document
4. Use **🔍 Extract Claims** to pull out factual assertions, then **Verify** individually
5. Use the **Chat** tab to ask questions or request edits

## Development

```bash
# Server (hot reload)
cd server && npm run dev

# Extension — plain JS, no build step
# Edit files in extension/ and reload in Chrome
```
