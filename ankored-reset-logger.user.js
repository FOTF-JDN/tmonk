// ==UserScript==
// @name         Ankored Requirement Logger (Reset + Approve)
// @namespace    fotf
// @version      0.3
// @description  Logs Ankored "Reset Requirement" to Rejections tab and "Approve Requirement" to Approved tab in Google Sheets
// @match        https://app.ankored.com/*
// @downloadURL  https://fotf-jdn.github.io/tmonk/ankored-reset-logger.user.js
// @updateURL    https://fotf-jdn.github.io/tmonk/ankored-reset-logger.user.js
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  console.log("[Ankored Logger] Script loaded on:", location.href);

  const WEB_APP_URL =
    "https://script.google.com/a/macros/focusonthefield.com/s/AKfycbxmwB5U0H84mnne95a46A7vDyvk6TtKFI8qTt5K0KYW5av0KfC_Zs2ud6SR67U7J1fh/exec";
  const SHARED_SECRET = "casv_rejectons_2026_alskejrlealkjereres";

  // --- Small utilities ---
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  const findButtonByText = (text) => {
    const target = text.toLowerCase();
    return (
      Array.from(document.querySelectorAll("button")).find(
        (b) => norm(b.textContent).toLowerCase() === target
      ) || null
    );
  };

  const findLabelEl = (labelText) => {
    const t = labelText.toLowerCase();
    return (
      Array.from(document.querySelectorAll("body *")).find(
        (el) =>
          el.childElementCount === 0 && norm(el.textContent).toLowerCase() === t
      ) || null
    );
  };

  // Generic "value next to label" extractor
  const valueAfterLabel = (labelText) => {
    const label = findLabelEl(labelText);
    if (!label) return "";

    // adjacent sibling
    const sib = label.nextElementSibling;
    if (sib && norm(sib.textContent)) return norm(sib.textContent);

    // same parent container fallback
    const parent = label.parentElement;
    if (parent) {
      const full = norm(parent.textContent);
      const l = norm(label.textContent);
      if (full && l && full !== l) return norm(full.replace(l, ""));
    }
    return "";
  };

  const getReviewerInitials = () => {
    const candidates = Array.from(
      document.querySelectorAll("header, nav, [role='banner'], body")
    )
      .flatMap((root) => Array.from(root.querySelectorAll("button, div, span, a")))
      .map((el) => ({ el, txt: norm(el.textContent) }))
      .filter((x) => /^[A-Z]{1,3}$/.test(x.txt));

    const headerCand = candidates.find((x) =>
      x.el.closest("header, nav, [role='banner']")
    );
    return headerCand?.txt || candidates[0]?.txt || "";
  };

  const getReviewDecisionText = () => {
    const label = findLabelEl("Review Decision:");
    if (!label) return "";

    const container = label.closest("div") || label.parentElement;
    if (!container) return "";

    // Native select
    const sel = container.querySelector("select");
    if (sel) {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      return norm(opt ? opt.textContent : sel.value);
    }

    // Heuristic fallback
    return norm(norm(container.textContent).replace(norm(label.textContent), ""));
  };

  const getReasonForRejection = () => {
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
        const ok = navigator.sendBeacon(WEB_APP_URL, blob);
        console.log("[Ankored Logger] sendBeacon fired:", ok ? "OK" : "FAILED");
        return;
      }

      fetch(WEB_APP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      })
        .then(() => console.log("[Ankored Logger] fetch fired: OK"))
        .catch((err) => console.warn("[Ankored Logger] fetch failed:", err));
    } catch (e) {
      console.error("[Ankored Logger] send failed", e);
    }
  };

  const buildBasePayload = (decisionRaw) => ({
    secret: SHARED_SECRET,
    reviewDecision: decisionRaw, // IMPORTANT: Apps Script routes based on this
    requirement: valueAfterLabel("Requirement:"),
    originallyCompleted: valueAfterLabel("Originally Completed:"), // Date Submitted
    userName: valueAfterLabel("User Name:"),
    parentName: valueAfterLabel("Parent Name:"),
    parentEmail: valueAfterLabel("Parent Email:"),
    pageUrl: location.href,
  });

  const onSubmit = () => {
    const decisionRaw = getReviewDecisionText();
    console.log("[Ankored Logger] decisionRaw =", JSON.stringify(decisionRaw));
    const decision = (decisionRaw || "").toLowerCase();

    const isReset =
      decision.includes("reset") && decision.includes("requirement");
    const isApprove =
      decision.includes("approve") && decision.includes("requirement");

    if (!isReset && !isApprove) {
      console.log("[Ankored Logger] Ignored submit; decision =", decisionRaw);
      return;
    }

    const reviewer = getReviewerInitials();
    const basePayload = buildBasePayload(decisionRaw);

    if (isReset) {
      const payload = {
        ...basePayload,
        rejectedBy: reviewer,
        reasonForReset: getReasonForRejection(),
      };

      // Log without exposing secret
      console.log("[Ankored Logger] Sending REJECTION payload:", {
        ...payload,
        secret: "***",
      });
      send(payload);
      return;
    }

    // isApprove
    const payload = {
      ...basePayload,
      approvedBy: reviewer,
      notes: "", // reserved for future use
    };

    console.log("[Ankored Logger] Sending APPROVAL payload:", {
      ...payload,
      secret: "***",
    });
    send(payload);
  };

  const attach = () => {
    const btn = findButtonByText("Submit Review");
    if (!btn) return false;

    if (btn.dataset.fotfLoggerAttached === "1") return true;
    btn.dataset.fotfLoggerAttached = "1";

    btn.addEventListener("click", onSubmit, true);
    console.log("[Ankored Logger] Attached to Submit Review button");

    const reviewer = getReviewerInitials();
    console.log("[Ankored Logger] Reviewer detected:", reviewer || "(not detected)");
    return true;
  };

  // Keep trying longer because Ankored UI may mount after initial load
  const start = () => {
    if (attach()) return;

    const t0 = Date.now();
    const timer = setInterval(() => {
      if (attach()) {
        clearInterval(timer);
        return;
      }
      // try for up to 60 seconds
      if (Date.now() - t0 > 60000) {
        clearInterval(timer);
        console.warn("[Ankored Logger] Could not find Submit Review button within 60s");
      }
    }, 500);
  };

  start();
})();
