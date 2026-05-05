import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { getUserPreferences, getDocumentHistory } from "./database.js";

let client: CopilotClient | null = null;

export async function getCopilotClient(): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient();
    await client.start();
  }
  return client;
}

export async function stopCopilotClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = null;
  }
}

// Allowlist for sessions that need no tools (pure LLM reasoning)
const NO_TOOLS: string[] = [];

// Allowlist for research sessions (fact-checking)
const RESEARCH_TOOLS = ["web_search"];

export interface Suggestion {
  id: string;
  category: "grammar" | "tone" | "style" | "clarity" | "conciseness";
  severity: "error" | "warning" | "info";
  originalText: string;
  replacement: string;
  explanation: string;
  paragraphIndex: number;
  contextBefore: string;
  contextAfter: string;
}

export interface AnalysisResult {
  suggestions: Suggestion[];
  overallTone: string;
  publishReady: boolean;
  publishReadySummary: string;
}

export interface FactCheckClaim {
  claim: string;
  sourceText: string;
  verdict: "supported" | "disputed" | "insufficient_evidence" | "unverifiable";
  confidence: "low" | "medium" | "high";
  sources: Array<{ url: string; title: string; snippet: string }>;
  explanation: string;
}

export interface FactCheckResult {
  claims: FactCheckClaim[];
  summary: string;
}

const VALID_CATEGORIES = new Set(["grammar", "tone", "style", "clarity", "conciseness"]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);
const VALID_VERDICTS = new Set(["supported", "disputed", "insufficient_evidence", "unverifiable"]);
const VALID_CONFIDENCES = new Set(["low", "medium", "high"]);

function sanitizeSuggestion(raw: any, index: number): Suggestion {
  return {
    id: typeof raw.id === "string" ? raw.id : `s${index}`,
    category: VALID_CATEGORIES.has(raw.category) ? raw.category : "style",
    severity: VALID_SEVERITIES.has(raw.severity) ? raw.severity : "info",
    originalText: String(raw.originalText ?? ""),
    replacement: String(raw.replacement ?? ""),
    explanation: String(raw.explanation ?? ""),
    paragraphIndex: typeof raw.paragraphIndex === "number" ? raw.paragraphIndex : 0,
    contextBefore: String(raw.contextBefore ?? ""),
    contextAfter: String(raw.contextAfter ?? ""),
  };
}

function sanitizeAnalysisResult(raw: any): AnalysisResult {
  const suggestions = Array.isArray(raw.suggestions)
    ? raw.suggestions.map(sanitizeSuggestion)
    : [];

  return {
    suggestions,
    overallTone: String(raw.overallTone ?? "neutral"),
    publishReady: Boolean(raw.publishReady),
    publishReadySummary: String(raw.publishReadySummary ?? ""),
  };
}

function sanitizeUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {}
  return null;
}

function sanitizeFactCheckResult(raw: any): FactCheckResult {
  const claims = Array.isArray(raw.claims)
    ? raw.claims.slice(0, 10).map((c: any): FactCheckClaim => {
        const sources = Array.isArray(c.sources)
          ? c.sources
              .slice(0, 5)
              .map((s: any) => {
                const url = sanitizeUrl(s.url);
                if (!url) return null;
                return {
                  url,
                  title: String(s.title ?? "").slice(0, 200),
                  snippet: String(s.snippet ?? "").slice(0, 300),
                };
              })
              .filter(Boolean)
          : [];

        return {
          claim: String(c.claim ?? "").slice(0, 500),
          sourceText: String(c.sourceText ?? "").slice(0, 200),
          verdict: VALID_VERDICTS.has(c.verdict) ? c.verdict : "unverifiable",
          confidence: VALID_CONFIDENCES.has(c.confidence) ? c.confidence : "low",
          sources: sources as Array<{ url: string; title: string; snippet: string }>,
          explanation: String(c.explanation ?? "").slice(0, 500),
        };
      })
    : [];

  return {
    claims,
    summary: String(raw.summary ?? `${claims.length} claim(s) checked`),
  };
}

function buildAnalyzePrompt(docId?: string, targetTone?: string | null): string {
  let memorySection = "";

  if (docId) {
    const prefs = getUserPreferences();
    if (prefs.length > 0) {
      memorySection += `\nUser preferences (learned from past interactions):\n${prefs.map((p) => `- ${p}`).join("\n")}\n`;
    }

    const history = getDocumentHistory(docId);
    if (history.doc && (history.doc as any).analysis_count > 0) {
      memorySection += `\nThis document has been analyzed ${(history.doc as any).analysis_count} time(s) before.\n`;
    }
  }

  let toneSection = "";
  if (targetTone) {
    toneSection = `\nIMPORTANT: The user is targeting a "${targetTone}" tone for this document. When analyzing:
- Flag any passages that deviate from this target tone as "tone" category suggestions with specific replacement text
- In overallTone, describe the document's current tone AND note whether it matches the target
- Factor tone alignment into publishReady — a document that doesn't match its target tone is not ready to publish\n`;
  }

  return `You are a professional writing assistant. Analyze the following document text and return a JSON response with writing suggestions.
${memorySection}${toneSection}
For each issue found, provide:
- id: a unique string id (e.g., "s1", "s2")
- category: one of "grammar", "tone", "style", "clarity", "conciseness"
- severity: one of "error", "warning", "info"
- originalText: the exact text that should be changed
- replacement: the suggested replacement text
- explanation: a brief explanation of why this change improves the writing
- paragraphIndex: which paragraph (0-indexed) contains the issue
- contextBefore: ~20 chars before the issue for anchoring
- contextAfter: ~20 chars after the issue for anchoring

Also provide:
- overallTone: a 2-3 word description of the document's tone (e.g., "professional and formal", "casual and friendly")
- publishReady: boolean - true if the document has no errors and is polished enough to publish
- publishReadySummary: a brief sentence explaining the publish readiness assessment

Return ONLY valid JSON matching this schema:
{
  "suggestions": [...],
  "overallTone": "...",
  "publishReady": true/false,
  "publishReadySummary": "..."
}

Document text:
`;
}

export async function analyzeDocument(
  text: string,
  docId?: string,
  targetTone?: string | null
): Promise<AnalysisResult> {
  const copilot = await getCopilotClient();
  const session = await copilot.createSession({
    model: "gpt-4.1",
    availableTools: NO_TOOLS,
    onPermissionRequest: approveAll,
  });

  try {
    const prompt = buildAnalyzePrompt(docId, targetTone) + text;
    const response = await session.sendAndWait({ prompt });

    const content = response?.data?.content ?? "";
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      content,
    ];
    const parsed = JSON.parse(jsonMatch[1]!.trim());
    return sanitizeAnalysisResult(parsed);
  } finally {
    await session.disconnect();
  }
}

export async function chat(
  message: string,
  documentContext: string,
  history: Array<{ role: string; content: string }>
): Promise<string> {
  const copilot = await getCopilotClient();
  const session = await copilot.createSession({
    model: "gpt-4.1",
    availableTools: NO_TOOLS,
    onPermissionRequest: approveAll,
  });

  const systemContext = `You are a helpful writing assistant embedded in a Google Docs editor. The user is working on a document and may ask you to help edit, rephrase, expand, or improve their writing.

Current document content:
---
${documentContext}
---

When suggesting edits, be specific about what text to change and what to change it to. You can also answer questions about writing style, tone, grammar rules, etc.

If the user asks you to make a change, respond with the change in this format:
SUGGESTED_EDIT:
Original: [exact text to find]
Replacement: [new text]
END_EDIT

You can include multiple SUGGESTED_EDIT blocks if needed. Include explanation outside the edit blocks.`;

  const fullPrompt =
    history.length > 0
      ? `${systemContext}\n\nConversation so far:\n${history.map((h) => `${h.role}: ${h.content}`).join("\n")}\n\nUser: ${message}`
      : `${systemContext}\n\nUser: ${message}`;

  try {
    const response = await session.sendAndWait({ prompt: fullPrompt });
    return response?.data?.content ?? "Sorry, I couldn't generate a response.";
  } finally {
    await session.disconnect();
  }
}

// --- Fact-Checking (two-step: extract claims, then verify with web search) ---

const MAX_CLAIMS = 50;

interface ExtractedClaim {
  claim: string;
  sourceText: string;
}

// Extract claims from text (no web access)
export async function extractClaims(text: string): Promise<ExtractedClaim[]> {
  const copilot = await getCopilotClient();
  const session = await copilot.createSession({
    model: "gpt-4.1",
    availableTools: NO_TOOLS,
    onPermissionRequest: approveAll,
  });

  try {
    const prompt = `You are a fact-checking assistant. Extract factual claims from the following text that can be verified with a web search.

Rules:
- Only extract objective, verifiable factual claims (dates, statistics, named events, quotes, scientific facts)
- Ignore opinions, advice, subjective statements, and hypotheticals
- Deduplicate equivalent claims
- Return at most ${MAX_CLAIMS} claims, prioritizing the most important/impactful ones
- For each claim, include the approximate source text from the document

Return ONLY valid JSON:
{
  "claims": [
    { "claim": "concise statement to verify", "sourceText": "relevant excerpt from document" }
  ]
}

Document text:
${text}`;

    const response = await session.sendAndWait({ prompt });
    const content = response?.data?.content ?? "";
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const parsed = JSON.parse(jsonMatch[1]!.trim());
    const raw = Array.isArray(parsed.claims) ? parsed.claims.slice(0, MAX_CLAIMS) : [];
    return raw.map((c: any) => ({
      claim: String(c.claim ?? ""),
      sourceText: String(c.sourceText ?? ""),
    }));
  } finally {
    await session.disconnect();
  }
}

// Verify a single claim using web search
export async function verifyClaim(claim: ExtractedClaim): Promise<FactCheckClaim> {
  const copilot = await getCopilotClient();
  const session = await copilot.createSession({
    model: "gpt-4.1",
    availableTools: RESEARCH_TOOLS,
    onPermissionRequest: approveAll,
  });

  try {
    const prompt = `You are a fact-checking assistant with web search access. Verify the following claim by searching the web.

Claim: "${claim.claim}"
Source text from document: "${claim.sourceText}"

Steps:
1. Search for evidence using web_search
2. Evaluate whether the evidence supports, disputes, or is insufficient to verify the claim
3. Cite your sources with URLs

Return ONLY valid JSON:
{
  "claim": "the claim text",
  "sourceText": "the source text from the document",
  "verdict": "supported" | "disputed" | "insufficient_evidence" | "unverifiable",
  "confidence": "low" | "medium" | "high",
  "sources": [{ "url": "https://...", "title": "source title", "snippet": "relevant excerpt" }],
  "explanation": "brief explanation of the verdict"
}`;

    const response = await session.sendAndWait({ prompt });
    const content = response?.data?.content ?? "";
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
    const parsed = JSON.parse(jsonMatch[1]!.trim());

    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.slice(0, 5).map((s: any) => {
          const url = sanitizeUrl(s.url);
          if (!url) return null;
          return { url, title: String(s.title ?? "").slice(0, 200), snippet: String(s.snippet ?? "").slice(0, 300) };
        }).filter(Boolean) as Array<{ url: string; title: string; snippet: string }>
      : [];

    return {
      claim: String(parsed.claim ?? claim.claim).slice(0, 500),
      sourceText: String(parsed.sourceText ?? claim.sourceText).slice(0, 200),
      verdict: VALID_VERDICTS.has(parsed.verdict) ? parsed.verdict : "unverifiable",
      confidence: VALID_CONFIDENCES.has(parsed.confidence) ? parsed.confidence : "low",
      sources,
      explanation: String(parsed.explanation ?? "").slice(0, 500),
    };
  } catch (err: any) {
    // Return a failed result rather than crashing the whole stream
    return {
      claim: claim.claim.slice(0, 500),
      sourceText: claim.sourceText.slice(0, 200),
      verdict: "unverifiable",
      confidence: "low",
      sources: [],
      explanation: `Verification failed: ${String(err.message ?? "unknown error")}`,
    };
  } finally {
    await session.disconnect();
  }
}
