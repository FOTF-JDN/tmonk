// ==UserScript==
// @name         Ankored Requirement Logger (Reset + Approve)
// @namespace    fotf
// @version      0.64
// @description  Logs Ankored "Reset Requirement" to Rejections tab and "Approve Requirement" to Approved tab in Google Sheets
// @match        https://app.ankored.com/*
// @downloadURL  https://fotf-jdn.github.io/tmonk/ankored-reset-logger.user.js
// @updateURL    https://fotf-jdn.github.io/tmonk/ankored-reset-logger.user.js
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      googleusercontent.com

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
    // Match label like "Review Decision:", "Review Decision: *", etc.
    const label = Array.from(document.querySelectorAll("body *"))
      .find(el =>
        el.childElementCount === 0 &&
        norm(el.textContent).toLowerCase().startsWith("review decision")
      );

    if (!label) return "";

    const scope = label.closest("div") || label.parentElement || document.body;

    // Look for common custom-select controls near the label
    const candidates = [
      ...scope.querySelectorAll('[role="combobox"]'),
      ...scope.querySelectorAll('[aria-haspopup="listbox"]'),
      ...scope.querySelectorAll("select"),
      ...scope.querySelectorAll("input"),
      ...scope.querySelectorAll("button"),
    ];

    for (const el of candidates) {
      if (el === label) continue;

      // Native select
      if (el.tagName === "SELECT") {
        const opt = el.selectedOptions && el.selectedOptions[0];
        return norm(opt ? opt.textContent : el.value);
      }

      // Inputs sometimes hold the value
      if (el.tagName === "INPUT" && el.value) {
        return norm(el.value);
      }

      // ARIA attributes often contain the selected value
      const ariaValueText = el.getAttribute("aria-valuetext");
      if (ariaValueText) return norm(ariaValueText);

      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel && /approve|reset|requirement/i.test(ariaLabel)) return norm(ariaLabel);

      // Visible text (often the selected option is rendered in a button/div)
      const txt = norm(el.textContent);
      if (txt && txt !== norm(label.textContent)) return txt;
    }

    // Last resort: remove label from scope text and return remainder
    const containerText = norm(scope.textContent);
    const labelText = norm(label.textContent);
    return norm(containerText.replace(labelText, ""));
  };


const getReasonForRejection = () => {
  // Try likely label variants in order (most specific first)
  const labelsToTry = [
    "Reason for Rejection:",   // handles when colon exists (we'll also match with *)
    "Reason for Rejection: *", // in case it's literally rendered this way
    "Review Reason:"           // fallback
  ];

  // Helper: find a label element by "startsWith" (handles trailing * and spacing)
  const findLabelStartsWith = (prefix) => {
    const p = prefix.toLowerCase().replace(/\*/g, "").trim();
    return Array.from(document.querySelectorAll("body *"))
      .find(el =>
        el.childElementCount === 0 &&
        norm(el.textContent).toLowerCase().replace(/\*/g, "").trim().startsWith(p)
      ) || null;
  };

  const readValueNear = (labelEl) => {
    if (!labelEl) return "";

    const scope = labelEl.closest("div") || labelEl.parentElement;
    if (!scope) return "";

    // textarea/input first
    const ta = scope.querySelector("textarea");
    if (ta) return norm(ta.value);

    const inp = scope.querySelector("input");
    if (inp) return norm(inp.value);

    // custom textbox / contenteditable
    const roleTb = scope.querySelector('[role="textbox"]');
    if (roleTb) return norm(roleTb.textContent);

    const ce = scope.querySelector('[contenteditable="true"]');
    if (ce) return norm(ce.textContent);

    return "";
  };

  for (const labelText of labelsToTry) {
    const labelEl = findLabelStartsWith(labelText);
    const val = readValueNear(labelEl);
    if (val) return val;
  }

  return "";
};


const send = (payload) => {
  try {
    const body = JSON.stringify(payload);

    // Use Tampermonkey's request layer (bypasses page CSP/CORS)
    GM_xmlhttpRequest({
      method: "POST",
      url: WEB_APP_URL,
      data: body,
      headers: {
        "Content-Type": "application/json",
      },
      onload: (resp) => {
        console.log("[Ankored Logger] POST response:", resp.status, resp.responseText);
      },
      onerror: (err) => {
        console.error("[Ankored Logger] POST error:", err);
      },
    });
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

  // Re-attach after tab becomes visible again (sleep / wake / tab switch)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    console.log("[Ankored Logger] Tab visible again — re-attaching");
    start();
  }
});

})();
