// ==UserScript==
// @name         Ankored Reset Logger
// @namespace    fotf
// @version      0.66
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

// === DEV PROBE: auth presence (no behavior change) ===
let __ankoredDevSawBearer = false;

(function installAuthPresenceProbe() {
  const noteSeen = (where) => {
    if (__ankoredDevSawBearer) return;
    __ankoredDevSawBearer = true;
    console.log(`[Ankored DEV] Saw Authorization: Bearer (${where})`);
  };

  // 1) fetch: capture auth from BOTH init.headers and Request.headers
  const origFetch = window.fetch;
  if (typeof origFetch === "function" && !origFetch.__ankoredDevPatched) {
    const patchedFetch = function(input, init) {
      try {
        // Case A: fetch(url, {headers})
        const h = init && init.headers;
        const authFromInit =
          (h && h instanceof Headers && (h.get("Authorization") || h.get("authorization"))) ||
          (h && typeof h === "object" && (h.Authorization || h.authorization)) ||
          "";

        if (typeof authFromInit === "string" && /Bearer\s+\S+/i.test(authFromInit)) {
          noteSeen("fetch init.headers");
        }

        // Case B: fetch(new Request(...))
        if (input && typeof input === "object" && input.headers && typeof input.headers.get === "function") {
          const authFromReq = input.headers.get("Authorization") || input.headers.get("authorization") || "";
          if (typeof authFromReq === "string" && /Bearer\s+\S+/i.test(authFromReq)) {
            noteSeen("fetch Request.headers");
          }
        }
      } catch {}
      return origFetch.apply(this, arguments);
    };
    patchedFetch.__ankoredDevPatched = true;
    window.fetch = patchedFetch;
  }

  // 2) XHR: capture Authorization header set via setRequestHeader
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__ankoredDevPatched) {
    const origSetRequestHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.setRequestHeader = function(name, value) {
      try {
        if (String(name).toLowerCase() === "authorization" && /Bearer\s+\S+/i.test(String(value || ""))) {
          noteSeen("XHR setRequestHeader");
        }
      } catch {}
      return origSetRequestHeader.apply(this, arguments);
    };
    XHR.prototype.__ankoredDevPatched = true;
  }

  // 3) Storage: slightly broader scan (still no secrets printed)
  try {
    const stores = [window.localStorage, window.sessionStorage].filter(Boolean);
    let tokenHints = 0;
    for (const store of stores) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        const k = key.toLowerCase();
        const v = String(store.getItem(key) || "");

        // Key hints
        if (k.includes("token") || k.includes("auth") || k.includes("oidc") || k.includes("cognito")) tokenHints++;

        // Value hints: JWT-ish or "access_token"/"id_token" inside JSON
        if (/eyj[a-z0-9_-]*\./i.test(v)) tokenHints++;
        if (v[0] === "{" && (v.includes("access_token") || v.includes("id_token") || v.includes("refresh_token"))) tokenHints++;
      }
    }
    console.log(`[Ankored DEV] Storage token hints: ${tokenHints}`);
  } catch {
    console.log("[Ankored DEV] Storage scan error (non-fatal)");
  }
})();



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

    // --- Week lookup GET helper (Patch C) ---
const fetchWeekInfo = (userName, parentEmail) => {
  return new Promise((resolve) => {
    const url =
      `${WEB_APP_URL}?op=weekLookup` +
      `&userName=${encodeURIComponent(userName || "")}` +
      `&parentEmail=${encodeURIComponent(parentEmail || "")}`;

    GM_xmlhttpRequest({
      method: "GET",
      url,
      onload: (resp) => {
        try {
          const data = JSON.parse(resp.responseText || "{}");
          resolve(data);
        } catch {
          resolve({ ok: false, error: "Invalid JSON from weekLookup" });
        }
      },
      onerror: () => resolve({ ok: false, error: "Network error calling weekLookup" }),
    });
  });
};


     // --- Week UI injection (Patch A) ---
  const injectWeekPlaceholder = () => {
    // Only run on review pages
    if (!location.pathname.startsWith("/review/")) return false;

    // Avoid duplicates
    if (document.querySelector("[data-fotf-week-line='1']")) return true;

    // Find the "User Group(s):" label (falls back to "User Group:" just in case)
    const label =
      findLabelEl("User Group(s):") ||
      findLabelEl("User Group:") ||
      null;

    if (!label) return false;

    // Create a new line styled similar to existing fields
    const line = document.createElement("div");
    line.setAttribute("data-fotf-week-line", "1");
    line.style.marginTop = "6px";
    line.innerHTML = `<strong>Week:</strong> <span data-fotf-week-value="1">(loading...)</span>`;

    // Insert right after the container that holds the label/value
    const container = label.parentElement;
    if (container && container.parentElement) {
      container.parentElement.insertBefore(line, container.nextSibling);
      return true;
    }

    // Fallback: insert right after the label itself
    label.insertAdjacentElement("afterend", line);
    return true;
  };

// --- Week UI updater (Patch C) ---
  let __fotfWeekLastPersonKey = "";
  let __fotfWeekInFlight = false;
  const updateWeekLine = async () => {
  if (!location.pathname.startsWith("/review/")) return false;

  // Ensure placeholder exists
  const injected = injectWeekPlaceholder();
  if (!injected) return false;

  const userName = valueAfterLabel("User Name:");
  const parentEmail = valueAfterLabel("Parent Email:");

  const valueEl = document.querySelector("[data-fotf-week-value='1']");
  if (!valueEl) return false;

    // If SPA navigated to a different player, force refresh Week (avoid showing previous player's week)
  const personKey = (norm(userName) + "|" + norm(parentEmail)).toLowerCase();
  if (personKey && personKey !== __fotfWeekLastPersonKey) {
    __fotfWeekLastPersonKey = personKey;
    __fotfWeekInFlight = false; // allow new fetch
    valueEl.textContent = "(loading...)";
    valueEl.title = "";
  }

    // Prevent flicker / repeated network calls during SPA re-renders
  if (__fotfWeekInFlight) return true;

  // If already resolved (week text OR not found), don't keep reloading
  const current = norm(valueEl.textContent).toLowerCase();
  const resolved =
    current &&
    current !== "(loading...)" &&
    current !== "(waiting for user data...)" &&
    current !== "(loading)" &&
    current !== "(waiting)";
    if (resolved && personKey === __fotfWeekLastPersonKey) return true;



  if (!userName || !parentEmail) {
    valueEl.textContent = "(waiting for user data...)";
    return true;
  }

  const cacheKey = `fotf_week_${norm(userName)}|${norm(parentEmail)}`;

  try {
      const cached = localStorage.getItem(cacheKey);
    if (cached) {
        const parsed = JSON.parse(cached);

        // Show instantly if we have it
        if (parsed.week) valueEl.textContent = parsed.week;
        if (parsed.allWeeks) valueEl.title = parsed.allWeeks;

        // If cache is fresh (< 7 days), don't refetch
        const ageMs = Date.now() - (parsed.ts || 0);
        if (ageMs < 7 * 24 * 60 * 60 * 1000) {
            __fotfWeekInFlight = false;
            return true;
}

// Otherwise allow background refresh (fall through)

    }
  } catch {}

  __fotfWeekInFlight = true;
  valueEl.textContent = "(loading...)";

  try {
    const res = await fetchWeekInfo(userName, parentEmail);
    const week = (res && res.ok && res.week) ? res.week : "(not found)";
    valueEl.textContent = week;

    if (res && res.ok && res.allWeeks) {
      valueEl.title = res.allWeeks;
    }

    try {
        localStorage.setItem(cacheKey, JSON.stringify({
            week,
            allWeeks: res?.allWeeks || "",
            ts: Date.now()
}));

    } catch {}
  } finally {
    __fotfWeekInFlight = false;
  }

  return true;

};

  // --- Week SPA observer (Patch C.1) ---
let __fotfWeekObserverInstalled = false;

const installWeekObserver = () => {
  if (__fotfWeekObserverInstalled) return;
  __fotfWeekObserverInstalled = true;

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      updateWeekLine();
    }, 50);
  };

  // Run once immediately
  updateWeekLine();

  const obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("popstate", () => setTimeout(updateWeekLine, 100));
  window.addEventListener("hashchange", () => setTimeout(updateWeekLine, 100));

  console.log("[Ankored Logger] Week observer installed");
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
    installWeekObserver();
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
    attach();
    updateWeekLine();

  }
});

})();
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
