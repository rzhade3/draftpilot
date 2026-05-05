// Content script for Google Docs
// With Google Docs API, text extraction and edits happen via the API.
// This content script handles UI overlays and message routing.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
    return;
  }
});

console.log("[DraftPilot] Content script loaded on Google Docs");
