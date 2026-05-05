// State
let currentSuggestions = [];
let chatHistory = [];
let currentDocText = "";
let currentDocId = "";
let currentTabId = null;
let currentAnalysisId = null;
let conversationId = crypto.randomUUID();
let isAnalyzing = false;
let isChatting = false;

// DOM elements
const btnAnalyze = document.getElementById("btn-analyze");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const suggestionCount = document.getElementById("suggestion-count");
const suggestionsList = document.getElementById("suggestions-list");
const suggestionsEmpty = document.getElementById("suggestions-empty");
const publishBadge = document.getElementById("publish-badge");
const publishSummary = document.getElementById("publish-summary");
const issueBreakdown = document.getElementById("issue-breakdown");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// Health check
async function checkServer() {
  try {
    const response = await sendMessage({ type: "HEALTH_CHECK" });
    if (response?.status === "ok") {
      statusDot.className = "connected";
      statusText.textContent = "Server connected";
      btnAnalyze.disabled = false;
      return true;
    }
  } catch {
    // falls through
  }
  statusDot.className = "error";
  statusText.textContent = "Server offline — run: cd server && npm run dev";
  btnAnalyze.disabled = true;
  return false;
}

// Message helper
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

// Get document text from content script
async function getDocumentText() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_DOC_TEXT" }, (response) => {
      if (response?.docId) {
        currentDocId = response.docId;
        loadTargetTone(response.docId);
      }
      if (response?.tabId) currentTabId = response.tabId;
      resolve(response?.text || "");
    });
  });
}

// Target tone — inline editable pill
let currentTargetTone = null;
const tonePill = document.getElementById("tone-pill");
const toneInput = document.getElementById("tone-input");

async function loadTargetTone(docId) {
  try {
    const result = await sendMessage({ type: "GET_TARGET_TONE", docId });
    currentTargetTone = result.tone || null;
    tonePill.textContent = currentTargetTone || "None set";
    tonePill.classList.toggle("tone-pill-active", !!currentTargetTone);
  } catch {
    // Ignore — tone is optional
  }
}

async function saveTargetTone(tone) {
  currentTargetTone = tone || null;
  tonePill.textContent = currentTargetTone || "None set";
  tonePill.classList.toggle("tone-pill-active", !!currentTargetTone);
  if (!currentDocId) return;
  try {
    await sendMessage({ type: "SET_TARGET_TONE", docId: currentDocId, tone: currentTargetTone });
  } catch {
    // Ignore — best effort
  }
}

// Double-click to edit
tonePill.addEventListener("dblclick", () => {
  tonePill.style.display = "none";
  toneInput.style.display = "inline-block";
  toneInput.value = currentTargetTone || "";
  toneInput.focus();
  toneInput.select();
});

function commitToneEdit() {
  const val = toneInput.value.trim();
  toneInput.style.display = "none";
  tonePill.style.display = "inline-block";
  const changed = val !== (currentTargetTone || "");
  saveTargetTone(val);
  // Trigger re-analysis if tone changed and we have doc text
  if (changed && currentDocText) {
    btnAnalyze.click();
  }
}

toneInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitToneEdit();
  } else if (e.key === "Escape") {
    toneInput.style.display = "none";
    tonePill.style.display = "inline-block";
  }
});

toneInput.addEventListener("blur", commitToneEdit);

// Analyze
btnAnalyze.addEventListener("click", async () => {
  if (isAnalyzing) return;
  isAnalyzing = true;
  btnAnalyze.disabled = true;
  btnAnalyze.classList.add("loading");
  btnAnalyze.innerHTML = `
    <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Analyzing...
  `;

  try {
    currentDocText = await getDocumentText();
    if (!currentDocText.trim()) {
      showError("Could not extract document text. Make sure you're on a Google Docs page.");
      return;
    }

    const result = await sendMessage({ type: "ANALYZE", text: currentDocText, docId: currentDocId });
    currentAnalysisId = result.analysisId || null;
    displayResults(result);
    displayFlesch(currentDocText);
    runAIDetection(currentDocText);
  } catch (err) {
    showError(`Analysis failed: ${err.message}`);
  } finally {
    isAnalyzing = false;
    btnAnalyze.disabled = false;
    btnAnalyze.classList.remove("loading");
    btnAnalyze.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      Analyze
    `;
  }
});

function showError(message) {
  suggestionsEmpty.innerHTML = `<p style="color: var(--error);">${escapeHtml(message)}</p>`;
  suggestionsEmpty.style.display = "flex";
  suggestionsList.style.display = "none";
}

// Display results
function displayResults(result) {
  currentSuggestions = result.suggestions || [];

  // Suggestions tab
  suggestionCount.textContent = currentSuggestions.length;
  if (currentSuggestions.length === 0) {
    suggestionsEmpty.innerHTML = `
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.5">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <p>Your document looks great! No suggestions.</p>
    `;
    suggestionsEmpty.style.display = "flex";
    suggestionsList.style.display = "none";
  } else {
    suggestionsEmpty.style.display = "none";
    suggestionsList.style.display = "block";
    suggestionsList.innerHTML = currentSuggestions.map((s, i) => renderSuggestion(s, i)).join("");
    attachSuggestionListeners();
  }

  // Overview tab — update cards
  // Publish readiness
  publishBadge.textContent = result.publishReady ? "Ready" : "Not Ready";
  publishBadge.className = `publish-badge ${result.publishReady ? "ready" : "not-ready"}`;
  publishSummary.textContent = result.publishReadySummary || "";

  // Tone detected
  document.getElementById("tone-detected").textContent = result.overallTone ? `Detected: ${result.overallTone}` : "—";

  // Writing Quality (computed from suggestions + Flesch)
  document.getElementById("wq-empty").style.display = "none";
  document.getElementById("wq-content").style.display = "block";
  displayWritingQuality(currentDocText, currentSuggestions);

  // Issue breakdown
  const categories = {};
  currentSuggestions.forEach((s) => {
    categories[s.category] = (categories[s.category] || 0) + 1;
  });
  issueBreakdown.innerHTML = Object.entries(categories)
    .map(([cat, count]) => `<span class="issue-chip"><span class="count">${count}</span> ${escapeHtml(cat)}</span>`)
    .join("") || `<span class="score-label">No issues found</span>`;
}

const VALID_CATEGORIES = new Set(["grammar", "tone", "style", "clarity", "conciseness"]);
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

function sanitizeEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function renderSuggestion(suggestion, index) {
  const category = sanitizeEnum(suggestion.category, VALID_CATEGORIES, "style");
  const severity = sanitizeEnum(suggestion.severity, VALID_SEVERITIES, "info");
  return `
    <div class="suggestion-card" data-index="${index}">
      <div class="suggestion-header">
        <span class="suggestion-category ${category}">${escapeHtml(category)}</span>
        <span class="severity-dot ${severity}" title="${escapeHtml(severity)}"></span>
      </div>
      <div class="suggestion-diff">
        <span class="diff-remove">${escapeHtml(suggestion.originalText)}</span>
        →
        <span class="diff-add">${escapeHtml(suggestion.replacement)}</span>
      </div>
      <p class="suggestion-explanation">${escapeHtml(suggestion.explanation)}</p>
      <div class="suggestion-actions">
        <button class="btn-accept" data-index="${index}">Accept</button>
        <button class="btn-dismiss" data-index="${index}">Dismiss</button>
      </div>
    </div>
  `;
}

function attachSuggestionListeners() {
  document.querySelectorAll(".btn-accept").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const idx = parseInt(e.target.dataset.index);
      const suggestion = currentSuggestions[idx];
      if (!suggestion) return;

      btn.textContent = "Applying...";
      btn.disabled = true;

      try {
        await sendMessage({
          type: "APPLY_SUGGESTION",
          originalText: suggestion.originalText,
          replacement: suggestion.replacement,
          contextBefore: suggestion.contextBefore,
          contextAfter: suggestion.contextAfter,
        });

        // Report accepted action to memory
        sendMessage({
          type: "SUGGESTION_ACTION",
          data: {
            docId: currentDocId,
            analysisId: currentAnalysisId,
            category: suggestion.category,
            severity: suggestion.severity,
            originalText: suggestion.originalText,
            replacement: suggestion.replacement,
            action: "accepted",
          },
        }).catch(() => {});

        // Remove the card with animation
        const card = btn.closest(".suggestion-card");
        card.style.opacity = "0";
        card.style.transform = "translateX(20px)";
        card.style.transition = "all 0.3s";
        setTimeout(() => {
          card.remove();
          currentSuggestions.splice(idx, 1);
          suggestionCount.textContent = currentSuggestions.length;
          if (currentSuggestions.length === 0) {
            suggestionsEmpty.innerHTML = `<p>All suggestions applied! ✨</p>`;
            suggestionsEmpty.style.display = "flex";
          }
        }, 300);
      } catch (err) {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Accept"; btn.disabled = false; }, 2000);
      }
    });
  });

  document.querySelectorAll(".btn-dismiss").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.index);
      const suggestion = currentSuggestions[idx];

      // Report dismissed action to memory
      if (suggestion) {
        sendMessage({
          type: "SUGGESTION_ACTION",
          data: {
            docId: currentDocId,
            analysisId: currentAnalysisId,
            category: suggestion.category,
            severity: suggestion.severity,
            originalText: suggestion.originalText,
            replacement: suggestion.replacement,
            action: "dismissed",
          },
        }).catch(() => {});
      }

      const card = btn.closest(".suggestion-card");
      card.style.opacity = "0";
      card.style.transform = "translateX(-20px)";
      card.style.transition = "all 0.3s";
      setTimeout(() => {
        card.remove();
        currentSuggestions.splice(idx, 1);
        suggestionCount.textContent = currentSuggestions.length;
      }, 300);
    });
  });
}

// Chat
btnSend.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || isChatting) return;

  isChatting = true;
  btnSend.disabled = true;
  chatInput.value = "";

  // Add user message
  appendChatMessage("user", message);

  // Add typing indicator
  const typingEl = document.createElement("div");
  typingEl.className = "chat-typing";
  typingEl.innerHTML = "<span></span><span></span><span></span>";
  chatMessages.appendChild(typingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    // Get fresh doc text for context
    if (!currentDocText) {
      currentDocText = await getDocumentText();
    }

    const result = await sendMessage({
      type: "CHAT",
      message,
      documentContext: currentDocText,
      docId: currentDocId,
      conversationId,
    });

    typingEl.remove();

    const responseText = result.response || "Sorry, I couldn't generate a response.";

    // Parse response for edit blocks
    appendChatMessage("assistant", responseText);
  } catch (err) {
    typingEl.remove();
    appendChatMessage("assistant", `Error: ${err.message}`);
  } finally {
    isChatting = false;
    btnSend.disabled = false;
    chatInput.focus();
  }
}

function appendChatMessage(role, content) {
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;

  if (role === "assistant") {
    // Parse SUGGESTED_EDIT blocks
    const parts = content.split(/(SUGGESTED_EDIT:[\s\S]*?END_EDIT)/g);
    let html = "";

    for (const part of parts) {
      const editMatch = part.match(/SUGGESTED_EDIT:\s*Original:\s*(.*?)\s*Replacement:\s*(.*?)\s*END_EDIT/s);
      if (editMatch) {
        const original = editMatch[1].trim();
        const replacement = editMatch[2].trim();
        html += `
          <div class="chat-edit-block">
            <div><span class="diff-remove">${escapeHtml(original)}</span></div>
            <div>→ <span class="diff-add">${escapeHtml(replacement)}</span></div>
            <button class="chat-edit-accept" data-original="${escapeAttr(original)}" data-replacement="${escapeAttr(replacement)}">Accept Edit</button>
          </div>
        `;
      } else {
        html += escapeHtml(part).replace(/\n/g, "<br>");
      }
    }
    div.innerHTML = html;

    // Attach edit accept listeners
    div.querySelectorAll(".chat-edit-accept").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const original = btn.dataset.original;
        const replacement = btn.dataset.replacement;
        btn.textContent = "Applying...";
        btn.disabled = true;
        try {
          await sendMessage({
            type: "APPLY_SUGGESTION",
            originalText: original,
            replacement: replacement,
            contextBefore: "",
            contextAfter: "",
          });
          btn.textContent = "Applied ✓";
        } catch {
          btn.textContent = "Failed — copied to clipboard";
        }
      });
    });
  } else {
    div.textContent = content;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Utilities
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Flesch Reading Ease calculation
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function calculateFlesch(text) {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.split(/\s+/).filter((w) => w.replace(/[^a-zA-Z]/g, "").length > 0);
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const numSentences = Math.max(sentences.length, 1);
  const numWords = Math.max(words.length, 1);

  const score = 206.835 - 1.015 * (numWords / numSentences) - 84.6 * (totalSyllables / numWords);
  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  let grade, detail;
  if (clamped >= 90) { grade = "5th grade"; detail = "Very easy to read"; }
  else if (clamped >= 80) { grade = "6th grade"; detail = "Easy to read"; }
  else if (clamped >= 70) { grade = "7th grade"; detail = "Fairly easy to read"; }
  else if (clamped >= 60) { grade = "8th–9th grade"; detail = "Plain English"; }
  else if (clamped >= 50) { grade = "10th–12th grade"; detail = "Fairly difficult"; }
  else if (clamped >= 30) { grade = "College"; detail = "Difficult to read"; }
  else { grade = "College graduate"; detail = "Very difficult to read"; }

  return { score: clamped, grade, detail, words: numWords, sentences: numSentences, syllables: totalSyllables };
}

function displayFlesch(text) {
  const f = calculateFlesch(text);
  document.getElementById("flesch-empty").style.display = "none";
  document.getElementById("flesch-content").style.display = "block";
  document.getElementById("flesch-number").textContent = f.score;
  document.getElementById("flesch-grade").textContent = f.grade;
  document.getElementById("flesch-bar").style.width = `${f.score}%`;
  document.getElementById("flesch-bar").style.background =
    f.score >= 60 ? "var(--success)" : f.score >= 40 ? "var(--warning)" : "var(--error)";
  document.getElementById("flesch-detail").textContent =
    `${f.detail} · ${f.words} words · ${f.sentences} sentences · ${f.syllables} syllables`;
}

// Writing Quality — hybrid score from suggestions + text metrics
function calculateWritingQuality(text, suggestions) {
  const breakdown = [];
  let score = 100;

  // 1. Deduct for suggestions by severity
  const errors = suggestions.filter((s) => s.severity === "error").length;
  const warnings = suggestions.filter((s) => s.severity === "warning").length;
  const infos = suggestions.filter((s) => s.severity === "info").length;

  const errorPenalty = errors * 5;
  const warningPenalty = warnings * 3;
  const infoPenalty = infos * 1;
  score -= errorPenalty + warningPenalty + infoPenalty;

  if (errors > 0) breakdown.push(`−${errorPenalty} pts: ${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) breakdown.push(`−${warningPenalty} pts: ${warnings} warning${warnings > 1 ? "s" : ""}`);
  if (infos > 0) breakdown.push(`−${infoPenalty} pts: ${infos} suggestion${infos > 1 ? "s" : ""}`);

  // 2. Flesch readability factor — penalize extremes
  const flesch = calculateFlesch(text);
  if (flesch.score < 30) {
    const penalty = Math.round((30 - flesch.score) / 3);
    score -= penalty;
    breakdown.push(`−${penalty} pts: very difficult readability (Flesch ${flesch.score})`);
  } else if (flesch.score > 95) {
    const penalty = Math.round((flesch.score - 95) / 2);
    score -= penalty;
    breakdown.push(`−${penalty} pts: overly simplistic (Flesch ${flesch.score})`);
  }

  // 3. Vocabulary diversity (type-token ratio)
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.replace(/[^a-z]/g, "").length > 0);
  const uniqueWords = new Set(words.map((w) => w.replace(/[^a-z]/g, "")));
  const numWords = Math.max(words.length, 1);
  // TTR drops with length, so normalize: use first 200 words for fair comparison
  const sampleSize = Math.min(numWords, 200);
  const sampleWords = words.slice(0, sampleSize).map((w) => w.replace(/[^a-z]/g, ""));
  const sampleUnique = new Set(sampleWords);
  const ttr = sampleUnique.size / Math.max(sampleSize, 1);

  if (ttr < 0.4) {
    const penalty = Math.round((0.4 - ttr) * 20);
    score -= penalty;
    breakdown.push(`−${penalty} pts: low vocabulary diversity (${Math.round(ttr * 100)}%)`);
  }

  // 4. Sentence variety — penalize uniform sentence lengths
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length >= 3) {
    const lengths = sentences.map((s) => s.trim().split(/\s+/).length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((sum, l) => sum + Math.pow(l - avg, 2), 0) / lengths.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 3) {
      const penalty = Math.round((3 - stdDev) * 2);
      score -= penalty;
      breakdown.push(`−${penalty} pts: low sentence variety`);
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  let label;
  if (clamped >= 90) label = "Excellent";
  else if (clamped >= 75) label = "Good";
  else if (clamped >= 55) label = "Fair";
  else label = "Needs work";

  if (breakdown.length === 0) breakdown.push("No deductions — great writing!");

  return { score: clamped, label, breakdown };
}

function displayWritingQuality(text, suggestions) {
  const wq = calculateWritingQuality(text, suggestions);
  document.getElementById("wq-number").textContent = wq.score;
  document.getElementById("wq-label").textContent = wq.label;
  document.getElementById("wq-bar").style.width = `${wq.score}%`;
  document.getElementById("wq-bar").style.background =
    wq.score >= 75 ? "var(--success)" : wq.score >= 55 ? "var(--warning)" : "var(--error)";

  const details = document.getElementById("wq-details");
  details.style.display = "block";
  document.getElementById("wq-breakdown").innerHTML = wq.breakdown
    .map((line) => `<div class="wq-breakdown-item">${escapeHtml(line)}</div>`)
    .join("");
}

// AI Detection
async function runAIDetection(text) {
  const loading = document.getElementById("ai-detect-loading");
  const content = document.getElementById("ai-detect-content");
  const empty = document.getElementById("ai-detect-empty");

  empty.style.display = "none";
  loading.style.display = "block";
  content.style.display = "none";

  try {
    const result = await sendMessage({ type: "AI_DETECT", text });
    loading.style.display = "none";
    content.style.display = "block";

    const score = result.score;
    let label, color;
    if (score >= 75) {
      label = "Likely AI-generated";
      color = "var(--error)";
    } else if (score >= 50) {
      label = "Possibly AI-generated";
      color = "var(--warning)";
    } else if (score >= 25) {
      label = "Mostly human-written";
      color = "var(--info)";
    } else {
      label = "Likely human-written";
      color = "var(--success)";
    }

    document.getElementById("ai-score-number").textContent = `${score}%`;
    document.getElementById("ai-score-label").textContent = label;
    document.getElementById("ai-score-bar").style.width = `${score}%`;
    document.getElementById("ai-score-bar").style.background = color;

    const reasons = result.reasons || [];
    const reasonsEl = document.getElementById("ai-reasons");
    if (reasons.length > 0) {
      reasonsEl.innerHTML = reasons
        .slice(0, 4)
        .map((r) => `<p class="ai-reason">${escapeHtml(r)}</p>`)
        .join("");
    } else {
      reasonsEl.innerHTML = "";
    }
  } catch (err) {
    loading.style.display = "none";
    empty.style.display = "block";
    empty.textContent = "Detection failed";
  }
}

// --- Fact Check ---
let extractedClaims = [];

const VERDICT_ICONS = {
  supported: "✅",
  disputed: "❌",
  insufficient_evidence: "⚠️",
  unverifiable: "❓",
};

function renderExtractedClaim(claim, index) {
  return `<div class="fact-claim" data-index="${index}">
    <div class="fact-claim-header">
      <span class="fact-claim-icon">📋</span>
      <span class="fact-claim-text">${escapeHtml(claim.claim)}</span>
      <button class="btn-verify" data-index="${index}" title="Verify this claim with web search">Verify</button>
    </div>
    ${claim.sourceText ? `<p class="fact-claim-source-text">"${escapeHtml(claim.sourceText)}"</p>` : ""}
  </div>`;
}

function renderVerifiedClaim(claim) {
  const icon = VERDICT_ICONS[claim.verdict] || "❓";
  const verdictClass = `verdict-${claim.verdict}`;

  let sourcesHtml = "";
  if (claim.sources && claim.sources.length > 0) {
    sourcesHtml = `<ul class="fact-claim-sources">${claim.sources.map((s) =>
      `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.url)}</a>${s.snippet ? `<br><span class="fact-claim-snippet">${escapeHtml(s.snippet)}</span>` : ""}</li>`
    ).join("")}</ul>`;
  }

  return `<div class="fact-claim fact-claim-verified">
    <div class="fact-claim-header">
      <span class="fact-claim-icon">${icon}</span>
      <span class="fact-claim-text">${escapeHtml(claim.claim)}</span>
      <span class="fact-claim-verdict ${verdictClass}">${escapeHtml(claim.verdict.replace(/_/g, " "))}</span>
    </div>
    <details>
      <summary>Details · ${escapeHtml(claim.confidence)} confidence</summary>
      <p class="fact-claim-explanation">${escapeHtml(claim.explanation)}</p>
      ${sourcesHtml}
    </details>
  </div>`;
}

function renderVerifyingClaim(claim) {
  return `<div class="fact-claim fact-claim-pending">
    <div class="fact-claim-header">
      <span class="fact-claim-icon">⏳</span>
      <span class="fact-claim-text">${escapeHtml(claim.claim)}</span>
      <span class="fact-claim-verdict verdict-pending">verifying...</span>
    </div>
  </div>`;
}

// Extract claims button
document.getElementById("btn-fact-extract").addEventListener("click", async () => {
  if (!currentDocText) return;

  const loading = document.getElementById("fact-check-loading");
  const content = document.getElementById("fact-check-content");
  const empty = document.getElementById("fact-check-empty");
  const btn = document.getElementById("btn-fact-extract");

  empty.style.display = "none";
  content.style.display = "none";
  loading.style.display = "block";
  btn.disabled = true;
  extractedClaims = [];

  document.getElementById("fact-check-summary").textContent = "";
  document.getElementById("fact-check-claims").innerHTML = "";

  try {
    const result = await sendMessage({ type: "FACT_CHECK_EXTRACT", text: currentDocText, docId: currentDocId });

    loading.style.display = "none";

    if (!result.claims || result.claims.length === 0) {
      empty.style.display = "block";
      empty.textContent = "No verifiable factual claims found in this document.";
      return;
    }

    extractedClaims = result.claims;
    content.style.display = "block";
    document.getElementById("fact-check-summary").textContent = `${extractedClaims.length} claims found — click Verify to check each one.`;
    document.getElementById("fact-check-claims").innerHTML = extractedClaims.map(renderExtractedClaim).join("");
  } catch (err) {
    loading.style.display = "none";
    empty.style.display = "block";
    empty.textContent = "Extraction failed: " + (err.message || "Unknown error");
  } finally {
    btn.disabled = false;
  }
});

// Verify individual claims (event delegation)
document.getElementById("fact-check-claims").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-verify");
  if (!btn) return;

  const index = parseInt(btn.dataset.index, 10);
  const claim = extractedClaims[index];
  if (!claim) return;

  const card = btn.closest(".fact-claim");
  card.outerHTML = renderVerifyingClaim(claim);

  try {
    const result = await sendMessage({ type: "FACT_CHECK_VERIFY", claim: claim.claim, sourceText: claim.sourceText });
    const cards = document.getElementById("fact-check-claims").children;
    if (cards[index]) {
      cards[index].outerHTML = renderVerifiedClaim(result);
    }

    // Update summary
    const verified = document.querySelectorAll(".fact-claim-verified").length;
    const total = extractedClaims.length;
    document.getElementById("fact-check-summary").textContent =
      verified === total
        ? `All ${total} claims verified.`
        : `${verified} of ${total} claims verified — click Verify on remaining claims.`;
  } catch (err) {
    // Restore the original card on failure
    const cards = document.getElementById("fact-check-claims").children;
    if (cards[index]) {
      cards[index].outerHTML = renderExtractedClaim(claim, index);
    }
  }
});

// Add spinning animation for loading
const style = document.createElement("style");
style.textContent = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s linear infinite; }
`;
document.head.appendChild(style);

// Auth gate
const authScreen = document.getElementById("auth-screen");
const mainContent = document.getElementById("main-content");
const btnSignin = document.getElementById("btn-signin");

async function checkAuth() {
  try {
    const result = await sendMessage({ type: "CHECK_AUTH" });
    if (result.authenticated) {
      showMainContent();
      return true;
    }
  } catch {}
  showAuthScreen();
  return false;
}

function showAuthScreen() {
  authScreen.style.display = "flex";
  mainContent.style.display = "none";
}

function showMainContent() {
  authScreen.style.display = "none";
  mainContent.style.display = "flex";
  checkServer();
  // Eagerly load doc context and target tone
  loadDocContext();
}

async function loadDocContext() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_DOC_TEXT" }, resolve);
    });
    if (response?.docId) {
      currentDocId = response.docId;
      loadTargetTone(response.docId);
      loadLastResult(response.docId);
    }
    if (response?.tabId) currentTabId = response.tabId;
    if (response?.text) {
      currentDocText = response.text;
      displayFlesch(currentDocText);
    }
  } catch {
    // Not on a Google Doc — that's fine
  }
}

async function loadLastResult(docId) {
  try {
    const response = await sendMessage({ type: "GET_LAST_RESULT", docId });
    if (response?.result) {
      displayResults(response.result);
      if (currentDocText) {
        displayWritingQuality(currentDocText, response.result.suggestions || []);
      }
    }
  } catch {
    // No previous results — that's fine
  }
}

btnSignin.addEventListener("click", async () => {
  btnSignin.disabled = true;
  btnSignin.textContent = "Signing in...";
  try {
    const result = await sendMessage({ type: "SIGN_IN" });
    if (result.authenticated) {
      showMainContent();
    } else {
      btnSignin.textContent = "Sign in failed — try again";
      btnSignin.disabled = false;
    }
  } catch (err) {
    btnSignin.textContent = "Sign in failed — try again";
    btnSignin.disabled = false;
  }
});

// Init — check auth first, then server
checkAuth().then((authed) => {
  if (authed) {
    checkServer();
    loadDocContext();
    setInterval(checkServer, 5000);
  }
});

// --- Settings Tab ---

async function loadMemoryList() {
  const memoryList = document.getElementById("memory-list");
  try {
    const data = await sendMessage({ type: "GET_MEMORY_SUMMARY" });

    if (data.totalAnalyses === 0 && data.totalChatMessages === 0) {
      memoryList.innerHTML = `<p class="score-label">No memories yet. Analyze a document or chat to start building memory.</p>`;
      return;
    }

    let html = "";

    // Learned preferences
    if (data.preferences.length > 0) {
      html += `<div class="memory-section-header">Learned Preferences</div>`;
      html += data.preferences
        .map(
          (p) => `
        <div class="memory-item preference">
          <span class="memory-icon">🧠</span>
          <div class="memory-detail">
            <span class="memory-text">Skips <strong>${escapeHtml(p.category)}</strong> suggestions like "${escapeHtml(p.pattern)}"</span>
            <span class="memory-meta">Dismissed ${p.dismissals}× — learned</span>
          </div>
        </div>`
        )
        .join("");
    }

    // Accepted patterns
    if (data.acceptedPatterns.length > 0) {
      html += `<div class="memory-section-header">What You Tend to Accept</div>`;
      html += data.acceptedPatterns
        .map(
          (p) => `
        <div class="memory-item">
          <span class="memory-icon">✓</span>
          <div class="memory-detail">
            <span class="memory-text"><strong>${escapeHtml(p.category)}</strong> suggestions</span>
            <span class="memory-meta">Accepted ${p.cnt}×</span>
          </div>
        </div>`
        )
        .join("");
    }

    // Storage summary
    html += `<div class="memory-section-header">Storage</div>`;
    html += `<div class="memory-storage">`;
    html += `<span>${data.totalAnalyses} analyses</span>`;
    html += `<span>${data.totalSuggestionActions} suggestion actions</span>`;
    html += `<span>${data.totalChatMessages} chat messages (${data.totalConversations} conversations)</span>`;
    html += `</div>`;

    memoryList.innerHTML = html;
  } catch (err) {
    memoryList.innerHTML = `<p class="score-label">Could not load memories</p>`;
  }
}

// Load memory list when settings tab is clicked
document.querySelector('[data-tab="settings"]').addEventListener("click", loadMemoryList);

// Clear memory buttons
document.getElementById("btn-clear-doc-memory").addEventListener("click", async () => {
  if (!currentDocId) return;
  if (!confirm("Clear all memory for this document?")) return;
  try {
    await sendMessage({ type: "CLEAR_DOC_MEMORY", docId: currentDocId });
    loadMemoryList();
  } catch (err) {
    alert("Failed: " + err.message);
  }
});

document.getElementById("btn-clear-all-memory").addEventListener("click", async () => {
  if (!confirm("Clear ALL memory across all documents? This cannot be undone.")) return;
  try {
    await sendMessage({ type: "CLEAR_ALL_MEMORY" });
    loadMemoryList();
  } catch (err) {
    alert("Failed: " + err.message);
  }
});
