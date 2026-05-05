import express from "express";
import cors from "cors";
import http from "http";
import { detectAIText } from "ai-text-detector";
import { analyzeDocument, chat, extractClaims, verifyClaim, stopCopilotClient } from "./copilot.js";
import {
  upsertDocument,
  getTargetTone,
  setTargetTone,
  saveLastResult,
  getLastResult,
  recordAnalysis,
  recordSuggestionAction,
  saveChatMessage,
  getChatHistory,
  getDashboard,
  getDocumentHistory,
  getMemorySummary,
  clearMemory,
  clearDocumentMemory,
  closeDb,
} from "./database.js";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3847;

// Only allow requests from the Chrome extension (chrome-extension:// origin)
// Combined with 127.0.0.1 binding, this blocks LAN + cross-origin web attacks
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("chrome-extension://")) {
        callback(null, true);
      } else {
        callback(new Error("CORS blocked"));
      }
    },
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/analyze", async (req, res) => {
  const { text, docId, title } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field in request body" });
    return;
  }

  try {
    // Ensure document exists in memory
    if (docId) {
      upsertDocument(docId, title);
    }

    const targetTone = docId ? getTargetTone(docId) : null;
    const result = await analyzeDocument(text, docId, targetTone);

    // Record analysis in memory
    if (docId) {
      const categoryCounts: Record<string, number> = {};
      for (const s of result.suggestions) {
        categoryCounts[s.category] = (categoryCounts[s.category] || 0) + 1;
      }
      const analysisId = recordAnalysis(docId, {
        suggestionCount: result.suggestions.length,
        categoryCounts,
        tone: result.overallTone,
        readabilityScore: 0,
        publishReady: result.publishReady,
      });
      saveLastResult(docId, result);
      res.json({ ...result, analysisId });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: err.message || "Analysis failed" });
  }
});

// Target tone per document
app.get("/documents/:docId/target-tone", (req, res) => {
  const tone = getTargetTone(req.params.docId);
  res.json({ tone });
});

app.put("/documents/:docId/target-tone", (req, res) => {
  const { tone } = req.body;
  if (tone !== null && typeof tone !== "string") {
    res.status(400).json({ error: "tone must be a string or null" });
    return;
  }
  setTargetTone(req.params.docId, tone || null);
  res.json({ ok: true });
});

app.get("/documents/:docId/last-result", (req, res) => {
  const result = getLastResult(req.params.docId);
  res.json({ result });
});

app.post("/chat", async (req, res) => {
  const { message, documentContext, docId, conversationId } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Missing 'message' field in request body" });
    return;
  }

  try {
    // Load chat history from DB if we have docId + conversationId
    let history: Array<{ role: string; content: string }> = [];
    if (docId && conversationId) {
      upsertDocument(docId);
      history = getChatHistory(docId, conversationId);
      saveChatMessage(docId, conversationId, "user", message);
    }

    const response = await chat(message, documentContext || "", history);

    // Save assistant response
    if (docId && conversationId) {
      saveChatMessage(docId, conversationId, "assistant", response);
    }

    res.json({ response, conversationId });
  } catch (err: any) {
    console.error("Chat error:", err);
    res.status(500).json({ error: err.message || "Chat failed" });
  }
});

// Fact-check: Step 1 — extract claims from document (no web access)
app.post("/fact-check/extract", async (req, res) => {
  const { text, docId } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  try {
    if (docId) upsertDocument(docId);
    const claims = await extractClaims(text);
    res.json({ claims });
  } catch (err: any) {
    console.error("Fact-check extract error:", err);
    res.status(500).json({ error: err.message || "Claim extraction failed" });
  }
});

// Fact-check: Step 2 — verify a single claim using web search
app.post("/fact-check/verify", async (req, res) => {
  const { claim, sourceText } = req.body;
  if (!claim || typeof claim !== "string") {
    res.status(400).json({ error: "Missing 'claim' field" });
    return;
  }
  try {
    const result = await verifyClaim({ claim, sourceText: sourceText || "" });
    res.json(result);
  } catch (err: any) {
    console.error("Fact-check verify error:", err);
    res.status(500).json({ error: err.message || "Claim verification failed" });
  }
});

// AI detection — analyze how AI-like the text is
app.post("/ai-detect", (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Missing 'text' field" });
    return;
  }
  // Library requires minimum ~50 chars
  if (text.trim().length < 50) {
    res.json({
      score: 0,
      isAIGenerated: false,
      reasons: ["Text too short for reliable AI detection (need at least 50 characters)"],
      perplexity: 0,
      burstiness: 0,
    });
    return;
  }
  try {
    const result = detectAIText(text);
    res.json({
      score: Math.max(0, Math.min(100, Math.round((result.confidence ?? result.score ?? 0) * 100))),
      isAIGenerated: Boolean(result.isAIGenerated),
      reasons: Array.isArray(result.reasons) ? result.reasons.map(String) : [],
      perplexity: Number(result.perplexityScore) || 0,
      burstiness: Number(result.burstinessScore) || 0,
    });
  } catch (err: any) {
    // Gracefully handle library errors (e.g., unexpected input)
    res.json({
      score: 0,
      isAIGenerated: false,
      reasons: [String(err.message || "Analysis could not be completed")],
      perplexity: 0,
      burstiness: 0,
    });
  }
});

// Record a suggestion action (accept/dismiss)
const VALID_ACTIONS = new Set(["accepted", "dismissed"]);
const VALID_CATEGORIES = new Set(["grammar", "tone", "style", "clarity", "conciseness"]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const VALID_SOURCES = new Set(["analyze", "chat"]);

app.post("/memory/suggestion-action", (req, res) => {
  const { docId, analysisId, category, severity, originalText, replacement, action, source } =
    req.body;
  if (!docId || !action || !VALID_ACTIONS.has(action)) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }
  try {
    recordSuggestionAction({
      docId: String(docId),
      analysisId: analysisId != null ? Number(analysisId) : undefined,
      category: VALID_CATEGORIES.has(category) ? category : "style",
      severity: VALID_SEVERITIES.has(severity) ? severity : "info",
      originalText: String(originalText ?? ""),
      replacement: String(replacement ?? ""),
      action,
      source: VALID_SOURCES.has(source) ? source : "analyze",
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard — aggregated writing analytics
app.get("/memory/dashboard", (_req, res) => {
  try {
    res.json(getDashboard());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Memory summary — what DraftPilot has learned
app.get("/memory/summary", (_req, res) => {
  try {
    res.json(getMemorySummary());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Document history
app.get("/memory/document/:docId", (req, res) => {
  try {
    res.json(getDocumentHistory(req.params.docId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all memory
app.delete("/memory", (_req, res) => {
  try {
    clearMemory();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Clear memory for one document
app.delete("/memory/document/:docId", (req, res) => {
  try {
    clearDocumentMemory(req.params.docId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);
server.listen(Number(PORT), "127.0.0.1", () => {
  console.log(`DraftPilot server running on http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  server.close();
  closeDb();
  await stopCopilotClient();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  server.close();
  closeDb();
  await stopCopilotClient();
  process.exit(0);
});
