// /api/analyze/index.js
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
      context.res = { status: 400, body: { error: "Missing url in request body" } };
      return;
    }

    let target;
    try {
      target = new URL(inputUrl);
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("Bad protocol");
    } catch {
      context.res = { status: 400, body: { error: "Invalid URL format (must be http/https)" } };
      return;
    }

    // Basic SSRF safety (public endpoint)
    const host = target.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0") {
      context.res = { status: 400, body: { error: "URL host not allowed" } };
      return;
    }
    if (isPrivateIp(host)) {
      context.res = { status: 400, body: { error: "Private IP hosts are not allowed" } };
      return;
    }

    // ---- 2) Load prompt template (kept with this function) ----
    const promptPath = path.join(__dirname, "prompt.txt");
    const basePrompt = fs.readFileSync(promptPath, "utf8");

    // ---- 3) Collect evidence (homepage + key policy pages) ----
    const evidence = await collectEvidence(target.href);

    // ---- 4) Collect reputation signals (external review sites) ----
    const reputationSignals = await collectReputationSignals(target.hostname);

    // ---- 5) Build final prompt ----
    const finalPrompt =
      `${basePrompt}\n\nWebsite URL: ${target.href}\n\n` +
      `EVIDENCE (use ONLY this evidence; if missing, mark Not verifiable):\n` +
      `${JSON.stringify({ ...evidence, reputationSignals }, null, 2)}`;

    // ---- 6) Azure OpenAI config ----
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;     // e.g. https://xxxx.openai.azure.com
    const apiKey = process.env.AZURE_OPENAI_KEY;            // key for SAME resource
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT; // deployment NAME (not model name)
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!endpoint || !apiKey || !deployment) {
      context.res = { status: 500, body: { error: "Azure OpenAI not configured (missing env vars)" } };
      return;
    }

    // ---- 7) Call model (JSON-only) ----
    // Some newer models require max_completion_tokens instead of max_tokens.
    const modelText = await callChatCompletionsWithTokenFallback({
      endpoint,
      apiKey,
      deployment,
      apiVersion,
      prompt: finalPrompt,
      temperature: 0.2,
      maxOutTokens: 1300
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
        maxOutTokens: 1300
      });

      result = safeJsonParse(retryText);
      if (!result) {
        context.res = { status: 502, body: { error: "Model did not return valid JSON" } };
        return;
      }
    }

    // ---- 9) Minimal schema sanity checks ----
    if (!result || typeof result.totalScore !== "number" || !result.breakdown || !result.keyFindings || !result.verdict) {
      context.res = { status: 502, body: { error: "Invalid JSON structure from model" } };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: result
    };
  } catch (e) {
    context.res = { status: 500, body: { error: "Server error", detail: String(e) } };
  }
};

/* ----------------------------- Azure OpenAI call ----------------------------- */
/* Uses Azure OpenAI Chat Completions REST endpoint format. */
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

  // Make homepage fetch non-fatal
  let homepageHtml = "";
  let homepageFetchError = null;
  try {
    homepageHtml = await fetchText(base.href, TIMEOUT_MS);
  } catch (e) {
    homepageHtml = "";
    homepageFetchError = `Homepage fetch failed: ${String(e)}`;
  }

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
    homepage: {
      url: base.href,
      signals: homepageSignals,
      textSnippet: compactText(homepageHtml, MAX_CHARS)
    },
    policyPages
  };
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
    "bank transfer", "direct deposit", "crypto", "bitcoin"
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
    "privacy policy", "terms", "about", "store locator", "jurisdiction"
  ].filter(k => lower.includes(k));

  const currency = [
    "aud", "a$", "usd", "us$", "currency", "charged in", "fx", "foreign transaction",
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
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;

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

/* --------------------------- Reputation signals --------------------------- */
async function collectReputationSignals(hostname) {
  const domain = normalizeDomain(hostname);
  const TIMEOUT_MS = 9000;

  const out = {
    domain,
    trustpilot: { checked: false, found: false },
    scamadviser: { checked: false, found: false },
    productReviewAu: { checked: false, found: false }
  };

  // Trustpilot
  try {
    out.trustpilot.checked = true;
    const url = `https://www.trustpilot.com/review/${domain}`;
    const html = await fetchText(url, TIMEOUT_MS);
    const agg = extractAggregateRatingFromJsonLd(html);
    const fallback = parseTrustpilotFallback(html);
    out.trustpilot = {
      checked: true,
      url,
      found: Boolean(agg || fallback.found),
      rating: agg?.ratingValue ?? fallback.rating,
      reviewCount: agg?.reviewCount ?? fallback.reviewCount
    };
  } catch (e) {
    out.trustpilot = { checked: true, found: false, error: String(e) };
  }

  // ScamAdviser
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

  // ProductReview.com.au (search then listing)
  try {
    out.productReviewAu.checked = true;

    const searchUrl = `https://www.productreview.com.au/search?q=${encodeURIComponent(domain)}`;
    const searchHtml = await fetchText(searchUrl, TIMEOUT_MS);
    const firstListingPath = extractFirstProductReviewListingPath(searchHtml);

    if (!firstListingPath) {
      out.productReviewAu = { checked: true, url: searchUrld: false };
    } else {
      const listingUrl = `https://www.productreview.com.au${firstListingPath}`;
      const listingHtml = await fetchText(listingUrl, TIMEOUT_MS);
      const agg = extractAggregateRatingFromJsonLd(listingHtml);
      const fallback = parseProductReviewListingFallback(listingHtml);

      out.productReviewAu = {
        checked: true,
        url: searchUrl,
        found: true,
        listingUrl,
        rating: agg?.ratingValue ?? fallback.rating,
        reviewCount: agg?.reviewCount ?? fallback.reviewCount
      };
    }
  } catch (e) {
    out.productReviewAu = { checked: true, found: false, error: String(e) };
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
      if (ratingValue !== null || reviewCount !== null) {
        return { ratingValue, reviewCount };
      }
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

function parseTrustpilotFallback(html) {
  const lower = (html || "").toLowerCase();
  const notFound = lower.includes("couldn't find any reviews") || lower.includes("not found");
  const found = !notFound && lower.includes("trustpilot");

  const rating =
    firstNumberMatch(html, /Rated\s*([0-9.]+)\s*\/\s*5/i) ||
    firstNumberMatch(html, /TrustScore\s*([0-9.]+)/i) ||
    null;

  const reviews =
    firstIntMatch(html, /([0-9,]+)\s+reviews/i) ||
    firstIntMatch(html, /Based on\s+([0-9,]+)\s+reviews/i) ||
    null;

  return { found, rating: rating !== null ? Number(rating) : null, reviewCount: reviews };
}

function parseScamadviserTrustScore(html) {
  return (
    firstIntMatch(html, /ScamAdviser\s*Trust\s*Score\s*[:\-]?\s*([0-9]{1,3})/i) ||
    firstIntMatch(html, /Trustscore\s*[:\-]?\s*([0-9]{1,3})/i) ||
    firstIntMatch(html, /Trust\s*Score\s*[:\-]?\s*([0-9]{1,3})/i) ||
    firstIntMatch(html, /([0-9]{1,3})\s*\/\s*100/i) ||
    null
  );
}

function extractFirstProductReviewListingPath(html) {
  const m = String(html || "").match(/href="(\/listings\/[^"']+)"/i);
  return m && m[1] ? m[1] : null;
}

function parseProductReviewListingFallback(html) {
  const rating =
    firstNumberMatch(html, /([0-9.]+)\s*out of\s*5/i) ||
    firstNumberMatch(html, /Rated\s*([0-9.]+)\s*\/\s*5/i) ||
    null;

  const count =
    firstIntMatch(html, /([0-9,]+)\s+reviews/i) ||
    firstIntMatch(html, /based on\s+([0-9,]+)\s+reviews/i) ||
    null;

  return { rating: rating !== null ? Number(rating) : null, reviewCount: count };
}

function firstNumberMatch(text, regex) {
  const m = String(text || "").match(regex);
  return m && m[1] ? m[1] : null;
}

function firstIntMatch(text, regex) {
  const m = String(text || "").match(regex);
  if (!m || !m[1]) return null;
  const n = parseInt(String(m[1]).replace(/,/g, ""), 10);
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
