// ==UserScript==
// @name         Ankored Reset Requirement Logger
// @namespace    fotf
// @version      0.1
// @description  Logs Ankored "Reset Requirement" review submissions to Google Sheets
// @match        https://app.ankored.com/*
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const WEB_APP_URL = "https://script.google.com/a/macros/focusonthefield.com/s/AKfycbxmwB5U0H84mnne95a46A7vDyvk6TtKFI8qTt5K0KYW5av0KfC_Zs2ud6SR67U7J1fh/exec";
  const SHARED_SECRET = "casv_rejectons_2026_alskejrlealkjereres";

  // --- Small utilities ---
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const findButtonByText = (text) => {
    const target = text.toLowerCase();
    return Array.from(document.querySelectorAll("button"))
      .find(b => norm(b.textContent).toLowerCase() === target) || null;
  };

  const findLabelEl = (labelText) => {
    const t = labelText.toLowerCase();
    return Array.from(document.querySelectorAll("body *"))
      .find(el => el.childElementCount === 0 && norm(el.textContent).toLowerCase() === t) || null;
  };

  // Generic "value next to label" extractor — we’ll tighten if Ankored DOM differs
  const valueAfterLabel = (labelText) => {
    const label = findLabelEl(labelText);
    if (!label) return "";

    // try adjacent sibling
    const sib = label.nextElementSibling;
    if (sib && norm(sib.textContent)) return norm(sib.textContent);

    // try within same parent container (common in definition lists)
    const parent = label.parentElement;
    if (parent) {
      const full = norm(parent.textContent);
      const l = norm(label.textContent);
      if (full && l && full !== l) return norm(full.replace(l, ""));
    }
    return "";
  };

  const getReviewerInitials = () => {
    // From your screenshot: initials like "JN" in top right inside a circle.
    // We’ll look for a small avatar-like element with 2-3 letters.
    const candidates = Array.from(document.querySelectorAll("header, nav, [role='banner'], body"))
      .flatMap(root => Array.from(root.querySelectorAll("button, div, span, a")))
      .map(el => ({ el, txt: norm(el.textContent) }))
      .filter(x => /^[A-Z]{1,3}$/.test(x.txt));

    // Prefer ones near top-right by looking for elements inside header/nav first
    const headerCand = candidates.find(x => x.el.closest("header, nav, [role='banner']"));
    return (headerCand?.txt) || (candidates[0]?.txt) || "";
  };

  const getReviewDecisionText = () => {
    // Try to find "Review Decision:" area and read the selected value
    const label = findLabelEl("Review Decision:");
    if (!label) return "";

    const container = label.closest("div") || label.parentElement;
    if (!container) return "";

    // If it's a native select:
    const sel = container.querySelector("select");
    if (sel) {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      return norm(opt ? opt.textContent : sel.value);
    }

    // Otherwise, heuristically remove the label text and return remainder
    return norm(norm(container.textContent).replace(norm(label.textContent), ""));
  };

  const getReasonForReset = () => {
    // You said "Reason for Rejection" is a text field.
    // We’ll locate the label "Reason for Rejection:" and read the textarea/input nearby.
    const label = findLabelEl("Reason for Rejection:");
    if (!label) return "";

    const container = label.closest("div") || label.parentElement;
    if (!container) return "";

    const ta = container.querySelector("textarea");
    if (ta) return norm(ta.value);

    const inp = container.querySelector("input");
    if (inp) return norm(inp.value);

    return "";
  };

  const send = (payload) => {
    try {
      const body = JSON.stringify(payload);

      // Best for page navigation: doesn't block, survives unload
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(WEB_APP_URL, blob);
        return;
      }

      // Fallback
      fetch(WEB_APP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true
      }).catch(() => {});
    } catch (e) {
      console.error("[Ankored Logger] send failed", e);
    }
  };

  const onSubmit = () => {
    const decision = getReviewDecisionText();
    const isReset = decision.toLowerCase().includes("reset") && decision.toLowerCase().includes("requirement");
    if (!isReset) return;

    const payload = {
      secret: SHARED_SECRET,
      requirement: valueAfterLabel("Requirement:"),
      originallyCompleted: valueAfterLabel("Originally Completed:"),
      userName: valueAfterLabel("User Name:"),
      parentName: valueAfterLabel("Parent Name:"),
      parentEmail: valueAfterLabel("Parent Email:"),
      rejectedBy: getReviewerInitials(),
      reasonForReset: getReasonForReset(),
      pageUrl: location.href
    };

    console.log("[Ankored Logger] Sending payload:", payload);
    send(payload);
  };

  const attach = () => {
    const btn = findButtonByText("Submit Review");
    if (!btn) return false;

    if (btn.dataset.fotfLoggerAttached === "1") return true;
    btn.dataset.fotfLoggerAttached = "1";

    btn.addEventListener("click", onSubmit, true);
    console.log("[Ankored Logger] Attached to Submit Review button");
    return true;
  };

  // Lightweight attach loop: tries for up to 15s, then stops
  const start = () => {
    if (attach()) return;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (attach() || (Date.now() - t0) > 15000) clearInterval(timer);
    }, 500);
  };

  start();
})();
