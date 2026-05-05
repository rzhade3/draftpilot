const SERVER_URL = "http://127.0.0.1:3847";

function serverHeaders(extra = {}) {
  return { "Content-Type": "application/json", ...extra };
}

// --- Google Docs API via chrome.identity OAuth ---

// Get OAuth token using chrome.identity
function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error("No auth token received"));
      } else {
        resolve(token);
      }
    });
  });
}

// Extract document ID from a Google Docs URL
function extractDocId(url) {
  const match = url?.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// Extract tab ID from a Google Docs URL (e.g., ?tab=t.abc123)
function extractTabId(url) {
  const match = url?.match(/[?&]tab=t\.([a-zA-Z0-9_-]+)/);
  return match ? `t.${match[1]}` : null;
}

// Fetch document content via Google Docs API (with tabs support)
async function getDocumentText(docId) {
  const token = await getAuthToken();
  const apiUrl = `https://docs.googleapis.com/v1/documents/${docId}?includeTabsContent=true`;
  const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    const newToken = await getAuthToken();
    const retry = await fetch(apiUrl, { headers: { Authorization: `Bearer ${newToken}` } });
    if (!retry.ok) throw new Error(`Docs API error: ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`Docs API error: ${res.status}`);
  return res.json();
}

// Find a specific tab in the document by tabId (searches nested child tabs)
function findTab(tabs, tabId) {
  if (!tabs || !tabId) return null;
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    if (tab.childTabs) {
      const found = findTab(tab.childTabs, tabId);
      if (found) return found;
    }
  }
  return null;
}

// Get the body content for a specific tab (or the first tab if no tabId)
function getTabBody(doc, tabId) {
  if (doc.tabs && doc.tabs.length > 0) {
    const tab = tabId ? findTab(doc.tabs, tabId) : doc.tabs[0];
    if (tab?.documentTab?.body) return tab.documentTab.body;
  }
  // Fallback: use doc.body (single-tab or includeTabsContent not supported)
  return doc.body || { content: [] };
}

// Get list of all tabs for display
function getTabList(doc) {
  if (!doc.tabs || doc.tabs.length <= 1) return [];
  const result = [];
  function walk(tabs, depth) {
    for (const tab of tabs) {
      result.push({
        tabId: tab.tabProperties?.tabId,
        title: tab.tabProperties?.title || "Untitled",
        depth,
      });
      if (tab.childTabs) walk(tab.childTabs, depth + 1);
    }
  }
  walk(doc.tabs, 0);
  return result;
}

// Extract plain text from a body object
function extractTextFromBody(body) {
  const content = body?.content || [];
  const texts = [];
  for (const element of content) {
    if (element.paragraph) {
      const paraText = element.paragraph.elements
        .map((el) => el.textRun?.content || "")
        .join("");
      texts.push(paraText);
    }
  }
  return texts.join("");
}

// Extract plain text from doc (uses tab-aware body)
function extractTextFromDoc(doc, tabId) {
  const body = getTabBody(doc, tabId);
  return extractTextFromBody(body);
}

// Find all occurrences of a substring and return their {startIndex, endIndex} in the doc
function findTextRanges(doc, searchText) {
  const ranges = [];
  const content = doc.body?.content || [];
  for (const element of content) {
    if (element.paragraph) {
      for (const el of element.paragraph.elements) {
        if (el.textRun?.content) {
          const text = el.textRun.content;
          const baseIndex = el.startIndex;
          let pos = 0;
          while ((pos = text.indexOf(searchText, pos)) !== -1) {
            ranges.push({
              startIndex: baseIndex + pos,
              endIndex: baseIndex + pos + searchText.length,
            });
            pos += searchText.length;
          }
        }
      }
    }
  }
  return ranges;
}



// Apply a text replacement via the Docs API batchUpdate
// Uses index-based delete+insert for precision (falls back to replaceAllText)
async function applyReplacement(docId, originalText, replacement, tabId) {
  const token = await getAuthToken();

  // Fetch the current doc to find the exact position
  const doc = await getDocumentText(docId);
  const body = getTabBody(doc, tabId);

  // Find the target text in the tab's body
  const range = findFirstTextRange(body, originalText);

  let requests;
  if (range) {
    // Precise index-based replacement: delete the range, then insert new text
    const tabScope = tabId ? { tabId } : {};
    requests = [
      {
        deleteContentRange: {
          range: {
            startIndex: range.startIndex,
            endIndex: range.endIndex,
            ...tabScope,
          },
        },
      },
      {
        insertText: {
          location: { index: range.startIndex, ...tabScope },
          text: replacement,
        },
      },
    ];
  } else {
    // Fallback: replaceAllText (applies to all tabs by default, or scoped via tabsCriteria)
    const replaceReq = {
      containsText: { text: originalText, matchCase: true },
      replaceText: replacement,
    };
    if (tabId) {
      replaceReq.tabsCriteria = { tabIds: [tabId] };
    }
    requests = [{ replaceAllText: replaceReq }];
  }

  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Docs API error: ${res.status}`);
  }
  return res.json();
}

// Find the first occurrence of text across paragraph elements
// Handles text that may span multiple textRun elements within a paragraph
function findFirstTextRange(body, searchText) {
  const content = body?.content || [];

  // Build a flat list of {text, startIndex} from the doc
  for (const element of content) {
    if (!element.paragraph) continue;

    // Concatenate all textRuns in this paragraph
    let paraText = "";
    let paraStart = Infinity;
    const runs = [];
    for (const el of element.paragraph.elements) {
      if (el.textRun?.content) {
        if (paraStart === Infinity) paraStart = el.startIndex;
        runs.push({ text: el.textRun.content, startIndex: el.startIndex });
        paraText += el.textRun.content;
      }
    }

    // Search within the concatenated paragraph text
    const pos = paraText.indexOf(searchText);
    if (pos !== -1) {
      // Map back to document indices
      // paraText[pos] corresponds to paraStart + pos in the doc
      return {
        startIndex: paraStart + pos,
        endIndex: paraStart + pos + searchText.length,
      };
    }
  }

  // Also try searching across the entire extracted text for cross-paragraph matches
  const fullText = extractTextFromBody(body);
  const fullPos = fullText.indexOf(searchText);
  if (fullPos !== -1) {
    // Map fullPos back to document index by walking through elements
    let charCount = 0;
    for (const element of content) {
      if (!element.paragraph) continue;
      for (const el of element.paragraph.elements) {
        if (el.textRun?.content) {
          const runLen = el.textRun.content.length;
          if (charCount + runLen > fullPos) {
            const offset = fullPos - charCount;
            return {
              startIndex: el.startIndex + offset,
              endIndex: el.startIndex + offset + searchText.length,
            };
          }
          charCount += runLen;
        }
      }
    }
  }

  return null; // Not found — will fall back to replaceAllText
}

// --- Side panel & extension plumbing ---

// Disable the side panel globally by default — only enable on Google Docs tabs
chrome.sidePanel.setOptions({ enabled: false });

function isDocsUrl(url) {
  return url?.startsWith("https://docs.google.com/document/");
}

// Enable/disable side panel based on the current tab's URL
async function updateSidePanelForTab(tabId, url) {
  if (isDocsUrl(url)) {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  } else {
    await chrome.sidePanel.setOptions({ tabId, enabled: false });
  }
}

// When the user clicks the extension icon, open the side panel on Docs tabs
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && isDocsUrl(tab.url)) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// When a tab finishes loading, toggle the side panel
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    updateSidePanelForTab(tabId, tab.url);
  }
});

// When the user switches tabs, toggle the side panel for the new active tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    updateSidePanelForTab(activeInfo.tabId, tab.url);
  } catch {}
});

// Serialize replacement requests to prevent race conditions
let replacementQueue = Promise.resolve();

// Handle messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CHECK_AUTH") {
    // Try to get a token non-interactively to see if user is signed in
    getAuthToken(false)
      .then((token) => sendResponse({ authenticated: true }))
      .catch(() => sendResponse({ authenticated: false }));
    return true;
  }

  if (message.type === "SIGN_IN") {
    // Trigger interactive OAuth flow
    getAuthToken(true)
      .then((token) => sendResponse({ authenticated: true }))
      .catch((err) => sendResponse({ authenticated: false, error: err.message }));
    return true;
  }

  if (message.type === "HEALTH_CHECK") {
    fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) })
      .then((res) => res.json())
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "GET_DOC_TEXT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      try {
        const url = tabs[0]?.url;
        const docId = extractDocId(url);
        if (!docId) {
          sendResponse({ error: "Not a Google Docs page" });
          return;
        }
        const tabId = extractTabId(url);
        const doc = await getDocumentText(docId);
        const text = extractTextFromDoc(doc, tabId);
        const tabList = getTabList(doc);
        sendResponse({ text, docId, tabId, tabList });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (message.type === "ANALYZE") {
    handleAnalyze(message.text, message.docId).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "CHAT") {
    handleChat(message.message, message.documentContext, message.docId, message.conversationId)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "SUGGESTION_ACTION") {
    handleSuggestionAction(message.data).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "GET_DASHBOARD") {
    handleGetDashboard().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "GET_MEMORY_SUMMARY") {
    handleGetMemorySummary().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "CLEAR_DOC_MEMORY") {
    handleClearMemory(message.docId).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "CLEAR_ALL_MEMORY") {
    handleClearAllMemory().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "AI_DETECT") {
    handleAIDetect(message.text).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "FACT_CHECK_EXTRACT") {
    handleFactCheckExtract(message.text, message.docId).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "FACT_CHECK_VERIFY") {
    handleFactCheckVerify(message.claim, message.sourceText).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "GET_TARGET_TONE") {
    handleGetTargetTone(message.docId).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "GET_LAST_RESULT") {
    handleGetLastResult(message.docId).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "SET_TARGET_TONE") {
    handleSetTargetTone(message.docId, message.tone).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "APPLY_SUGGESTION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url;
      const docId = extractDocId(url);
      if (!docId) {
        sendResponse({ error: "Not a Google Docs page" });
        return;
      }
      const tabId = extractTabId(url);
      replacementQueue = replacementQueue
        .then(() => applyReplacement(docId, message.originalText, message.replacement, tabId))
        .then((result) => sendResponse({ success: true, result }))
        .catch((err) => sendResponse({ error: err.message }));
    });
    return true;
  }
});

async function handleAnalyze(text, docId) {
  const res = await fetch(`${SERVER_URL}/analyze`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ text, docId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleGetTargetTone(docId) {
  const res = await fetch(`${SERVER_URL}/documents/${encodeURIComponent(docId)}/target-tone`, {
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleSetTargetTone(docId, tone) {
  const res = await fetch(`${SERVER_URL}/documents/${encodeURIComponent(docId)}/target-tone`, {
    method: "PUT",
    headers: serverHeaders(),
    body: JSON.stringify({ tone }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleGetLastResult(docId) {
  const res = await fetch(`${SERVER_URL}/documents/${encodeURIComponent(docId)}/last-result`, {
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleChat(message, documentContext, docId, conversationId) {
  const res = await fetch(`${SERVER_URL}/chat`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ message, documentContext, docId, conversationId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleSuggestionAction(data) {
  const res = await fetch(`${SERVER_URL}/memory/suggestion-action`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleGetDashboard() {
  const res = await fetch(`${SERVER_URL}/memory/dashboard`, {
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleGetMemorySummary() {
  const res = await fetch(`${SERVER_URL}/memory/summary`, {
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleClearMemory(docId) {
  const res = await fetch(`${SERVER_URL}/memory/document/${docId}`, {
    method: "DELETE",
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleClearAllMemory() {
  const res = await fetch(`${SERVER_URL}/memory`, {
    method: "DELETE",
    headers: serverHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleAIDetect(text) {
  const res = await fetch(`${SERVER_URL}/ai-detect`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleFactCheckExtract(text, docId) {
  const res = await fetch(`${SERVER_URL}/fact-check/extract`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ text, docId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}

async function handleFactCheckVerify(claim, sourceText) {
  const res = await fetch(`${SERVER_URL}/fact-check/verify`, {
    method: "POST",
    headers: serverHeaders(),
    body: JSON.stringify({ claim, sourceText }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: ${res.status}`);
  }
  return res.json();
}
