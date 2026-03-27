// api/analyze/index.jsCredibility: 20,
    domainWebsiteAge: 10,
    shippingReturns: 10,
    customerReviewsReputation: 10,
    contactInfo: 10,
    scamIndicators: 10,
    overseasFulfilmentRisk: 10
  };

  const out = {};
  for (const [key, max] of Object.entries(spec)) {
    const raw = breakdown && breakdown[key] ? breakdown[key] : {};
    out[key] = {
      score: clampInt(raw.score, 0, max),
      max
    };
  }
  return out;
}

function computeTotalFromNormalizedBreakdown(normalized) {
  let total = 0;
  for (const item of Object.values(normalized || {})) {
    total += Number(item.score) || 0;
  }
  return total;
}

function neutralBaselineBreakdown() {
  // Neutral-ish baseline for low-confidence / access-blocked situations (Option A).
  // Keeps output sensible (not scary), while verdict remains "Caution" due to low confidence.
  return {
    paymentSecurity: { score: 10, max: 20 },
    businessCredibility: { score: 10, max: 20 },
    domainWebsiteAge: { score: 8, max: 10 },
    shippingReturns: { score: 5, max: 10 },
    customerReviewsReputation: { score: 5, max: 10 },
    contactInfo: { score: 5, max: 10 },
    scamIndicators: { score: 6, max: 10 },
    overseasFulfilmentRisk: { score: 6, max: 10 }
  };
}

function computeVerdict(totalScore, confidenceScore, accessBlocked) {
  // If we couldn't properly access content, always show Caution.
  if (accessBlocked || confidenceScore < 45) return "Caution";
  if (totalScore >= 75) return "Lower risk";
  if (totalScore >= 50) return "Medium risk";
  return "Higher risk";
}

function safeStringArray(arr, maxItems) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(x => typeof x === "string" && x.trim().length > 0)
    .slice(0, maxItems);
}

function uniqStrings(arr) {
  return Array.from(new Set((arr || []).map(s => String(s).trim()).filter(Boolean)));
}

/* ----------------------------- Confidence ----------------------------- */

function computeConfidence(evidence, reputationSignals) {
  // Confidence is: "How much real content did we successfully observe?"
  // Not: "How safe is the site?"
  const homepageSnippet = evidence?.homepage?.textSnippet || "";
  const homepageLen = homepageSnippet.trim().length;

  const policyPages = Array.isArray(evidence?.policyPages) ? evidence.policyPages : [];
  const policyFetchedCount = policyPages.filter(p => p && !p.error && (p.textSnippet || "").length > 200).length;

  const hpSignals = evidence?.homepage?.signals || {};
  const signalCount =
    (hpSignals.paymentKeywords || []).length +
    (hpSignals.shippingKeywords || []).length +
    (hpSignals.returnsKeywords || []).length +
    (hpSignals.credibilityKeywords || []).length;

  const repFoundCount =
    (reputationSignals?.trustpilot?.found ? 1 : 0) +
    (reputationSignals?.scamadviser?.found ? 1 : 0);

  const accessBlocked = Boolean(evidence && evidence.accessBlocked === true);
  const homepageFetchFailed = Boolean(evidence && evidence.homepageFetchError);

  // Score components (0–100)
  let score = 0;

  // Homepage content richness (0–45)
  if (homepageLen >= 5000) score += 45;
  else if (homepageLen >= 2000) score += 35;
  else if (homepageLen >= 800) score += 25;
  else if (homepageLen >= 300) score += 15;
  else score += 5;

  // Signals found (0–25)
  score += Math.min(25, signalCount * 4);

  // Policy pages successfully fetched (0–20)
  score += Math.min(20, policyFetchedCount * 7);

  // Reputation signals available (0–10)
  score += Math.min(10, repFoundCount * 5);

  // Penalties
  if (homepageFetchFailed) score -= 20;
  if (accessBlocked) score -= 35;

  score = clampInt(score, 0, 100);

  let label = "High";
  if (score < 45) label = "Low";
  else if (score < 70) label = "Medium";

  let reason = "We could view enough information to judge.";
  if (accessBlocked) reason = "The site limited what our checker could access.";
  else if (homepageFetchFailed) reason = "We could not reliably load the homepage.";
  else if (score < 70) reason = "Some important details could not be confirmed.";

  return { score, label, reason };
}

/* ----------------------------- Azure OpenAI call ----------------------------- */

async function callChatCompletionsWithTokenFallback({ endpoint, apiKey, deployment, apiVersion, prompt, temperature, maxOutTokens }) {
  try {
    return await callChatCompletions({
      endpoint,
      apiKey,
      deployment,
      apiVersion,
      prompt,
      temperature,
      tokenParamName: "max_completion_tokens",
      maxOutTokens
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes("Unsupported parameter") && msg.includes("max_completion_tokens")) {
      return await callChatCompletions({
        endpoint,
        apiKey,
        deployment,
        apiVersion,
        prompt,
        temperature,
        tokenParamName: "max_tokens",
        maxOutTokens
      });
    }
    throw err;
  }
}

async function callChatCompletions({ endpoint, apiKey, deployment, apiVersion, prompt, temperature, tokenParamName, maxOutTokens }) {
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const payload = {
    messages: [
      { role: "system", content: "You are a strict JSON generator. Output JSON only." },
      { role: "user", content: prompt }
    ],
    temperature
  };
  payload[tokenParamName] = maxOutTokens;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Azure OpenAI error ${res.status}: ${text}`);

  let json;
  try { json = JSON.parse(text); } catch { return text; }
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* ----------------------------- Evidence gathering ---------------------------- */

async function collectEvidence(siteUrl) {
  const MAX_CHARS = 18000;
  const TIMEOUT_MS = 9000;
  const MAX_POLICY_PAGES = 3;

  const base = new URL(siteUrl);

  let homepageHtml = "";
  let homepageFetchError = null;

  try {
    homepageHtml = await fetchText(base.href, TIMEOUT_MS);
  } catch (e) {
    homepageHtml = "";
    homepageFetchError = `Homepage fetch failed: ${String(e)}`;
  }

  const homepageText = compactText(homepageHtml, MAX_CHARS);
  const accessBlocked = looksLikeAccessBlocked(homepageText);

  const homepageSignals = parseSignals(homepageHtml, base.href);
  const policyLinks = findPolicyLinks(homepageHtml, base.href).slice(0, MAX_POLICY_PAGES);

  const policyPages = [];
  for (const link of policyLinks) {
    try {
      const html = await fetchText(link, TIMEOUT_MS);
      policyPages.push({
        url: link,
        signals: parseSignals(html, link),
        textSnippet: compactText(html, MAX_CHARS)
      });
    } catch (e) {
      policyPages.push({ url: link, error: `Fetch failed: ${String(e)}` });
    }
  }

  return {
    fetchedAtUtc: new Date().toISOString(),
    inputUrl: siteUrl,
    homepageFetchError,
    accessBlocked,
    homepage: {
      url: base.href,
      signals: homepageSignals,
      textSnippet: homepageText
    },
    policyPages
  };
}

function looksLikeAccessBlocked(text) {
  const t = String(text || "").toLowerCase();
  const patterns = [
    "server busy",
    "temporarily unavailable",
    "access denied",
    "request blocked",
    "unusual traffic",
    "are you a robot",
    "captcha",
    "verify you are a human",
    "please enable cookies",
    "service unavailable",
    "error 503",
    "bot detection"
  ];
  return patterns.some(p => t.includes(p));
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteRiskChecker/1.0)" }
    });

    if (!res.ok) return "";
    const text = await res.text();
    return text || "";
  } finally {
    clearTimeout(t);
  }
}

function parseSignals(html, pageUrl) {
  const lower = (html || "").toLowerCase();

  const payment = [
    "paypal", "apple pay", "google pay", "visa", "mastercard", "american express", "amex",
    "afterpay", "zip", "klarna", "shop pay", "stripe",
    "bank transfer", "direct deposit", "crypto", "bitcoin", "unionpay"
  ].filter(k => lower.includes(k));

  const shipping = [
    "shipping", "delivery", "dispatch", "tracking", "track", "australia post", "origin",
    "warehouse", "fulfil", "fulfillment", "same day", "business days"
  ].filter(k => lower.includes(k));

  const returns = [
    "returns", "refund", "exchange", "return policy", "refund policy",
    "30-day", "30 day", "14-day", "14 day", "store credit", "restocking"
  ].filter(k => lower.includes(k));

  const credibility = [
    "abn", "acn", "gst", "contact", "address", "phone",
    "privacy policy", "terms", "about", "store locator", "jurisdiction", "company"
  ].filter(k => lower.includes(k));

  const currency = [
    "aud", "a$", "usd", "us$", "charged in", "foreign transaction",
    "presentment currency", "shop_currency", "presentment_currency", "currencycode", "money_format",
    "shopify.currency", "localization"
  ].filter(k => lower.includes(k));

  return {
    pageUrl,
    paymentKeywords: uniq(payment),
    shippingKeywords: uniq(shipping),
    returnsKeywords: uniq(returns),
    credibilityKeywords: uniq(credibility),
    currencyKeywords: uniq(currency)
  };
}

function findPolicyLinks(html, baseUrl) {
  const links = [];
  const hrefRe = /href\s*=\s*[^"']+["']/gi;

  let m;
  while ((m = hrefRe.exec(html || "")) !== null) {
    const href = m[1];
    const abs = toAbsoluteUrl(href, baseUrl);
    if (!abs) continue;

    const u = abs.toLowerCase();
    if (
      u.includes("shipping") ||
      u.includes("delivery") ||
      u.includes("refund") ||
      u.includes("return") ||
      u.includes("terms") ||
      u.includes("privacy") ||
      u.includes("/policies/")
    ) {
      links.push(abs);
    }
  }

  const base = new URL(baseUrl);
  return uniq(links).filter(l => {
    try { return new URL(l).origin === base.origin; } catch { return false; }
  });
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    if (!href) return null;
    if (href.startsWith("#")) return null;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return null;
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function compactText(html, maxChars) {
  const noScript = (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const text = noScript.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

/* --------------------------- Reputation signals (lightweight) --------------------------- */

async function collectReputationSignals(hostname) {
  const domain = normalizeDomain(hostname);
  const TIMEOUT_MS = 9000;

  const out = {
    domain,
    trustpilot: { checked: false, found: false },
    scamadviser: { checked: false, found: false }
  };

  try {
    out.trustpilot.checked = true;
    const url = `https://www.trustpilot.com/review/${domain}`;
    const html = await fetchText(url, TIMEOUT_MS);
    const agg = extractAggregateRatingFromJsonLd(html);
    out.trustpilot = {
      checked: true,
      url,
      found: Boolean(agg),
      rating: agg?.ratingValue ?? null,
      reviewCount: agg?.reviewCount ?? null
    };
  } catch (e) {
    out.trustpilot = { checked: true, found: false, error: String(e) };
  }

  try {
    out.scamadviser.checked = true;
    const url = `https://www.scamadviser.com/check-website/${domain}`;
    const html = await fetchText(url, TIMEOUT_MS);
    const score = parseScamadviserTrustScore(html);
    out.scamadviser = {
      checked: true,
      url,
      found: score !== null,
      trustScoreOutOf100: score
    };
  } catch (e) {
    out.scamadviser = { checked: true, found: false, error: String(e) };
  }

  return out;
}

function normalizeDomain(hostname) {
  let h = String(hostname || "").toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

function extractAggregateRatingFromJsonLd(html) {
  const blocks = extractJsonLdBlocks(html);
  for (const obj of blocks) {
    const found = findAggregateRatingObject(obj);
    if (found) {
      const ratingValue = toNumber(found.ratingValue);
      const reviewCount = toInt(found.reviewCount) ?? toInt(found.ratingCount);
      if (ratingValue !== null || reviewCount !== null) return { ratingValue, reviewCount };
    }
  }
  return null;
}

function extractJsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html || "")) !== null) {
    const raw = (m[1] || "").trim();
    if (!raw) continue;
    try { out.push(JSON.parse(raw)); } catch { /* ignore */ }
  }
  return out;
}

function findAggregateRatingObject(obj) {
  if (!obj) return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findAggregateRatingObject(item);
      if (r) return r;
    }
    return null;
  }

  if (obj["@graph"]) return findAggregateRatingObject(obj["@graph"]);
  if (obj.aggregateRating && typeof obj.aggregateRating === "object") return obj.aggregateRating;

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === "object") {
      const r = findAggregateRatingObject(v);
      if (r) return r;
    }
  }
  return null;
}

function parseScamadviserTrustScore(html) {
  return (
    firstIntMatch(html, /Trustscore\s*[:\-]?\s*([0-9]{1,3})/i) ||
    firstIntMatch(html, /([0-9]{1,3})\s*\/\s*100/i) ||
    null
  );
}

function firstIntMatch(text, regex) {
  const m = String(text || "").match(regex);
  if (!m || !m[1]) return null;
  const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function toNumber(x) {
  if (x === null || x === undefined) return null;
  const n = Number(String(x).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toInt(x) {
  if (x === null || x === undefined) return null;
  const n = parseInt(String(x).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/* ----------------------------- SSRF helper ----------------------------- */

function isPrivateIp(hostname) {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;

  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return true;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;

  return false;
}
// Azure Static Web Apps (managed Functions) - Node.js (CommonJS)

const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  try {
    // ---- 1) Parse + validate input ----
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const inputUrl = body && body.url ? String(body.url).trim() : "";
    if (!inputUrl) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Missing url in request body" }
      };
      return;
    }

    let target;
    try {
      target = new URL(inputUrl);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Bad protocol");
    } catch {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Invalid URL format (must be http/https)" }
      };
      return;
    }

    // Basic SSRF safety (public endpoint)
    const host = target.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "URL host not allowed" }
      };
      return;
    }
    if (isPrivateIp(host)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Private IP hosts are not allowed" }
      };
      return;
    }

    // ---- 2) Load prompt template ----
    const promptPath = path.join(__dirname, "prompt.txt");
    const basePrompt = fs.readFileSync(promptPath, "utf8");

    // ---- 3) Collect evidence ----
    const evidence = await collectEvidence(target.href);

    // ---- 4) Collect reputation signals (lightweight) ----
    const reputationSignals = await collectReputationSignals(target.hostname);

    // ---- 5) Build final prompt ----
    const finalPrompt =
      `${basePrompt}\n\nWebsite URL: ${target.href}\n\n` +
      `EVIDENCE (use ONLY this evidence; if missing, mark Unknown):\n` +
      `${JSON.stringify({ ...evidence, reputationSignals }, null, 2)}`;

    // ---- 6) Azure OpenAI config ----
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!endpoint || !apiKey || !deployment) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "Azure OpenAI not configured (missing env vars)" }
      };
      return;
    }

    // ---- 7) Call model (JSON-only) ----
    const modelText = await callChatCompletionsWithTokenFallback({
      endpoint,
      apiKey,
      deployment,
      apiVersion,
      prompt: finalPrompt,
      temperature: 0.2,
      maxOutTokens: 800
    });

    // ---- 8) Parse JSON (retry once if invalid) ----
    let result = safeJsonParse(modelText);

    if (!result) {
      const retryPrompt = `${finalPrompt}\n\nIMPORTANT: Return VALID JSON ONLY. No markdown. No extra text.`;
      const retryText = await callChatCompletionsWithTokenFallback({
        endpoint,
        apiKey,
        deployment,
        apiVersion,
        prompt: retryPrompt,
        temperature: 0.1,
        maxOutTokens: 800
      });

      result = safeJsonParse(retryText);
      if (!result) {
        context.res = {
          status: 502,
          headers: { "Content-Type": "application/json" },
          body: { error: "Model did not return valid JSON" }
        };
        return;
      }
    }

    // ---- 9) Minimal schema checks ----
    if (!result || !result.breakdown || !result.keyFindings) {
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "Invalid JSON structure from model" }
      };
      return;
    }

    // ---- 10) Confidence + access-block handling ----
    const confidence = computeConfidence(evidence, reputationSignals);
    const accessBlocked = Boolean(evidence && evidence.accessBlocked === true);

    // Normalize scores from model (hard clamp)
    const normalizedFromModel = normalizeBreakdown(result.breakdown);

    // If access was blocked / interstitial detected, use a neutral baseline (Option A)
    // so big sites don't look "scammy" purely due to fetch limitations.
    const breakdownFinal = accessBlocked
      ? neutralBaselineBreakdown()
      : normalizedFromModel;

    // Always compute totals server-side from FINAL breakdown
    const computedTotal = computeTotalFromNormalizedBreakdown(breakdownFinal);

    // Verdict: if confidence is low (or access blocked), force Caution; otherwise use thresholds
    const computedVerdict = computeVerdict(computedTotal, confidence.score, accessBlocked);

    const response = {
      totalScore: computedTotal,
      maxScore: 100,
      verdict: computedVerdict,

      confidence: {
        score: confidence.score,
        label: confidence.label,
        reason: confidence.reason
      },

      keyFindings: {
        topRisks: safeStringArray(result.keyFindings.topRisks, 5),
        topPositives: safeStringArray(result.keyFindings.topPositives, 5),
        unknowns: safeStringArray(result.keyFindings.unknowns, 4)
      },

      breakdown: breakdownFinal
    };

    // If accessBlocked, help the user understand why the result is cautious
    if (accessBlocked) {
      response.keyFindings.topRisks = uniqStrings([
        "We could not access the full website content.",
        "Some sites block automated checks (common for big brands).",
        ...response.keyFindings.topRisks
      ]).slice(0, 5);

      response.keyFindings.unknowns = uniqStrings([
        "Some details may be hidden from our checker.",
        ...response.keyFindings.unknowns
      ]).slice(0, 4);
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: response
    };
  } catch (e) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Server error", detail: String(e) }
    };
  }
};

/* ----------------------------- Guardrails ----------------------------- */

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  const v = Math.round(x);
  return Math.max(min, Math.min(max, v));
}

function normalizeBreakdown(breakdown) {
  const spec = {
    paymentSecurity: 20,
