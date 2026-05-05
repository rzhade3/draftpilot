import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "draftpilot.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      title TEXT,
      target_tone TEXT,
      last_result TEXT,
      last_analyzed_at TEXT,
      analysis_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS analysis_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES documents(doc_id),
      timestamp TEXT NOT NULL,
      suggestion_count INTEGER,
      tone TEXT,
      readability_score REAL,
      flesch_score REAL,
      publish_ready INTEGER DEFAULT 0,
      model TEXT,
      prompt_version TEXT DEFAULT 'v1'
    );

    CREATE TABLE IF NOT EXISTS analysis_category_counts (
      analysis_id INTEGER NOT NULL REFERENCES analysis_history(id),
      category TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (analysis_id, category)
    );

    CREATE TABLE IF NOT EXISTS suggestion_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES documents(doc_id),
      analysis_id INTEGER REFERENCES analysis_history(id),
      timestamp TEXT NOT NULL,
      category TEXT,
      severity TEXT,
      original_text TEXT,
      replacement TEXT,
      action TEXT NOT NULL CHECK (action IN ('accepted', 'dismissed')),
      source TEXT DEFAULT 'analyze' CHECK (source IN ('analyze', 'chat'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES documents(doc_id),
      conversation_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_doc_time ON analysis_history(doc_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_suggestion_doc_time ON suggestion_actions(doc_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_doc_conv ON chat_history(doc_id, conversation_id, timestamp);
  `);

  // Migration: add target_tone column if missing (for existing DBs)
  const cols = d.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "target_tone")) {
    d.exec("ALTER TABLE documents ADD COLUMN target_tone TEXT");
  }
  if (!cols.some((c) => c.name === "last_result")) {
    d.exec("ALTER TABLE documents ADD COLUMN last_result TEXT");
  }
}

// --- Document helpers ---

export function upsertDocument(docId: string, title?: string) {
  const d = getDb();
  d.prepare(`
    INSERT INTO documents (doc_id, title) VALUES (?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET title = COALESCE(?, title)
  `).run(docId, title ?? null, title ?? null);
}

export function getTargetTone(docId: string): string | null {
  const d = getDb();
  const row = d.prepare("SELECT target_tone FROM documents WHERE doc_id = ?").get(docId) as
    | { target_tone: string | null }
    | undefined;
  return row?.target_tone ?? null;
}

export function setTargetTone(docId: string, tone: string | null) {
  const d = getDb();
  // Ensure document exists
  d.prepare(`
    INSERT INTO documents (doc_id) VALUES (?)
    ON CONFLICT(doc_id) DO NOTHING
  `).run(docId);
  d.prepare("UPDATE documents SET target_tone = ? WHERE doc_id = ?").run(tone, docId);
}

export function saveLastResult(docId: string, result: object) {
  const d = getDb();
  d.prepare("UPDATE documents SET last_result = ? WHERE doc_id = ?").run(
    JSON.stringify(result),
    docId
  );
}

export function getLastResult(docId: string): object | null {
  const d = getDb();
  const row = d.prepare("SELECT last_result FROM documents WHERE doc_id = ?").get(docId) as
    | { last_result: string | null }
    | undefined;
  if (!row?.last_result) return null;
  try {
    return JSON.parse(row.last_result);
  } catch {
    return null;
  }
}

export function recordAnalysis(
  docId: string,
  data: {
    suggestionCount: number;
    categoryCounts: Record<string, number>;
    tone: string;
    readabilityScore: number;
    fleschScore?: number;
    publishReady: boolean;
    model?: string;
  }
) {
  const d = getDb();
  const now = new Date().toISOString();

  // Update document
  d.prepare(`
    UPDATE documents SET last_analyzed_at = ?, analysis_count = analysis_count + 1
    WHERE doc_id = ?
  `).run(now, docId);

  // Insert analysis
  const result = d.prepare(`
    INSERT INTO analysis_history (doc_id, timestamp, suggestion_count, tone, readability_score, flesch_score, publish_ready, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docId,
    now,
    data.suggestionCount,
    data.tone,
    data.readabilityScore,
    data.fleschScore ?? null,
    data.publishReady ? 1 : 0,
    data.model ?? null
  );

  const analysisId = result.lastInsertRowid as number;

  // Insert category counts
  const insertCat = d.prepare(
    "INSERT INTO analysis_category_counts (analysis_id, category, count) VALUES (?, ?, ?)"
  );
  for (const [cat, count] of Object.entries(data.categoryCounts)) {
    insertCat.run(analysisId, cat, count);
  }

  return analysisId;
}

export function recordSuggestionAction(data: {
  docId: string;
  analysisId?: number;
  category: string;
  severity: string;
  originalText: string;
  replacement: string;
  action: "accepted" | "dismissed";
  source?: "analyze" | "chat";
}) {
  const d = getDb();
  d.prepare(`
    INSERT INTO suggestion_actions (doc_id, analysis_id, timestamp, category, severity, original_text, replacement, action, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.docId,
    data.analysisId ?? null,
    new Date().toISOString(),
    data.category,
    data.severity,
    data.originalText,
    data.replacement,
    data.action,
    data.source ?? "analyze"
  );
}

// --- Chat history ---

export function saveChatMessage(
  docId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string
) {
  const d = getDb();
  d.prepare(`
    INSERT INTO chat_history (doc_id, conversation_id, timestamp, role, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(docId, conversationId, new Date().toISOString(), role, content);
}

export function getChatHistory(
  docId: string,
  conversationId: string,
  limit = 20
): Array<{ role: string; content: string; timestamp: string }> {
  const d = getDb();
  return d
    .prepare(
      `SELECT role, content, timestamp FROM chat_history
       WHERE doc_id = ? AND conversation_id = ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(docId, conversationId, limit)
    .reverse() as any;
}

// --- User preferences (learned from repeated dismissals) ---

const DISMISSAL_THRESHOLD = 3; // must dismiss same pattern 3+ times to learn

export function getUserPreferences(): string[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT category, original_text, COUNT(*) as cnt
       FROM suggestion_actions
       WHERE action = 'dismissed' AND category IN ('tone', 'style', 'clarity', 'conciseness')
       GROUP BY category, original_text
       HAVING cnt >= ?
       ORDER BY cnt DESC
       LIMIT 10`
    )
    .all(DISMISSAL_THRESHOLD) as Array<{
    category: string;
    original_text: string;
    cnt: number;
  }>;

  return rows.map(
    (r) =>
      `User has repeatedly dismissed ${r.category} suggestions about "${r.original_text.slice(0, 50)}" (${r.cnt} times) — skip similar suggestions.`
  );
}

// Get a structured summary of what DraftPilot has learned
export function getMemorySummary() {
  const d = getDb();

  // Learned preferences (from repeated dismissals)
  const preferences = d
    .prepare(
      `SELECT category, original_text, replacement, COUNT(*) as cnt
       FROM suggestion_actions
       WHERE action = 'dismissed' AND category IN ('tone', 'style', 'clarity', 'conciseness')
       GROUP BY category, original_text
       HAVING cnt >= ?
       ORDER BY cnt DESC LIMIT 10`
    )
    .all(DISMISSAL_THRESHOLD) as Array<{
    category: string;
    original_text: string;
    replacement: string;
    cnt: number;
  }>;

  // Frequently accepted patterns (what the user agrees with)
  const acceptedPatterns = d
    .prepare(
      `SELECT category, COUNT(*) as cnt
       FROM suggestion_actions
       WHERE action = 'accepted'
       GROUP BY category
       ORDER BY cnt DESC`
    )
    .all() as Array<{ category: string; cnt: number }>;

  // Total suggestion actions
  const totalActions = d
    .prepare("SELECT COUNT(*) as n FROM suggestion_actions")
    .get() as any;

  // Chat message count
  const chatCount = d
    .prepare("SELECT COUNT(*) as n FROM chat_history")
    .get() as any;

  // Number of unique conversations
  const convCount = d
    .prepare("SELECT COUNT(DISTINCT conversation_id) as n FROM chat_history")
    .get() as any;

  // Analysis count
  const analysisCount = d
    .prepare("SELECT COUNT(*) as n FROM analysis_history")
    .get() as any;

  return {
    preferences: preferences.map((p) => ({
      category: p.category,
      pattern: p.original_text.slice(0, 80),
      dismissals: p.cnt,
    })),
    acceptedPatterns,
    totalSuggestionActions: totalActions?.n ?? 0,
    totalChatMessages: chatCount?.n ?? 0,
    totalConversations: convCount?.n ?? 0,
    totalAnalyses: analysisCount?.n ?? 0,
  };
}

// --- Dashboard / analytics ---

export function getDashboard() {
  const d = getDb();

  const totalDocs =
    (d.prepare("SELECT COUNT(*) as n FROM documents").get() as any)?.n ?? 0;
  const totalAnalyses =
    (d.prepare("SELECT COUNT(*) as n FROM analysis_history").get() as any)
      ?.n ?? 0;

  // Category breakdown across all analyses
  const categoryBreakdown = d
    .prepare(
      `SELECT category, SUM(count) as total
       FROM analysis_category_counts
       GROUP BY category ORDER BY total DESC`
    )
    .all() as Array<{ category: string; total: number }>;

  // Acceptance rate
  const actions = d
    .prepare(
      `SELECT action, COUNT(*) as cnt FROM suggestion_actions GROUP BY action`
    )
    .all() as Array<{ action: string; cnt: number }>;
  const accepted = actions.find((a) => a.action === "accepted")?.cnt ?? 0;
  const dismissed = actions.find((a) => a.action === "dismissed")?.cnt ?? 0;
  const acceptanceRate =
    accepted + dismissed > 0
      ? Math.round((accepted / (accepted + dismissed)) * 100)
      : null;

  // Trend: last 10 analyses with issue counts (improvement over time)
  const trend = d
    .prepare(
      `SELECT timestamp, suggestion_count, readability_score, publish_ready
       FROM analysis_history ORDER BY timestamp DESC LIMIT 10`
    )
    .all()
    .reverse() as Array<{
    timestamp: string;
    suggestion_count: number;
    readability_score: number;
    publish_ready: number;
  }>;

  // Recent documents
  const recentDocs = d
    .prepare(
      `SELECT doc_id, title, last_analyzed_at, analysis_count
       FROM documents WHERE last_analyzed_at IS NOT NULL
       ORDER BY last_analyzed_at DESC LIMIT 5`
    )
    .all() as Array<{
    doc_id: string;
    title: string;
    last_analyzed_at: string;
    analysis_count: number;
  }>;

  return {
    totalDocs,
    totalAnalyses,
    categoryBreakdown,
    acceptanceRate,
    trend,
    recentDocs,
  };
}

export function getDocumentHistory(docId: string) {
  const d = getDb();
  const doc = d
    .prepare("SELECT * FROM documents WHERE doc_id = ?")
    .get(docId) as any;
  const analyses = d
    .prepare(
      "SELECT * FROM analysis_history WHERE doc_id = ? ORDER BY timestamp DESC LIMIT 10"
    )
    .all(docId);
  return { doc, analyses };
}

export function clearMemory() {
  const d = getDb();
  d.exec(`
    DELETE FROM chat_history;
    DELETE FROM suggestion_actions;
    DELETE FROM analysis_category_counts;
    DELETE FROM analysis_history;
    DELETE FROM documents;
  `);
}

export function clearDocumentMemory(docId: string) {
  const d = getDb();
  d.prepare("DELETE FROM chat_history WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM suggestion_actions WHERE doc_id = ?").run(docId);
  d.prepare(`
    DELETE FROM analysis_category_counts WHERE analysis_id IN
    (SELECT id FROM analysis_history WHERE doc_id = ?)
  `).run(docId);
  d.prepare("DELETE FROM analysis_history WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM documents WHERE doc_id = ?").run(docId);
}

export function closeDb() {
  if (db) {
    db.close();
  }
}
