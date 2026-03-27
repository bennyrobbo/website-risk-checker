// /api/analyze/index.js
// Azure Static Web Apps (managed Functions) - Node.js (CommonJS)

const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  try {
    // ---- 1) Parse + validate input ----
    let body = req.body;

    // Some runtimes pass body as string
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

    // ---- 4) Build final prompt ----
    const finalPrompt =
      `${basePrompt}\n\nWebsite URL: ${target.href}\n\n` +
      `EVIDENCE (use ONLY this evidence; if missing, mark Not verifiable):\n` +
      `${JSON.stringify(evidence, null, 2)}`;

    // ---- 5) Azure OpenAI config ----
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;      // e.g. https://xxxx.openai.azure.com
    const apiKey = process.env.AZURE_OPENAI_KEY;             // key for SAME resource
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;  // deployment NAME (not model name)
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!endpoint || !apiKey || !deployment) {
      context.res = {
        status: 500,
        body: { error: "Azure OpenAI not configured (missing env vars)" }
      };
      return;
    }

    // ---- 6) Call model (JSON-only) ----
    // Newer GPT-5.x deployments may reject max_tokens and require max_completion_tokens. [2](https://tiegear.com/collections/glow)[3](https://play.google.com/store/apps/details/PayPal_Pay_Send_Save?id=com.paypal.android.p2pmobile&hl=en)
    // We try max_completion_tokens first, then fall back to max_tokens only if needed.
    const modelText = await callChatCompletionsWithTokenFallback({
      endpoint,
      apiKey,
      deployment,
      apiVersion,
      prompt: finalPrompt,
      temperature: 0.2,
      maxOutTokens: 1100
    });

    // ---- 7) Parse JSON (retry once if invalid) ----
    let result = safeJsonParse(modelText);
    if (!result) {
      const retryPrompt =
        `${finalPrompt}\n\nIMPORTANT: Return VALID JSON ONLY. No markdown. No extra text.`;

      const retryText = await callChatCompletionsWithTokenFallback({
        endpoint,
        apiKey,
        deployment,
        apiVersion,
        prompt: retryPrompt,
        temperature: 0.1,
        maxOutTokens: 1100
      });

      result = safeJsonParse(retryText);
      if (!result) {
        context.res = { status: 502, body: { error: "Model did not return valid JSON" } };
        return;
      }
    }

    // ---- 8) Minimal schema sanity checks ----
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
/*
  Uses Azure OpenAI Chat Completions REST endpoint format. [1](https://tiegear.com/collections/pax)
*/
async function callChatCompletionsWithTokenFallback({ endpoint, apiKey, deployment, apiVersion, prompt, temperature, maxOutTokens }) {
  // Try max_completion_tokens first (required for some newer models). [2](https://tiegear.com/collections/glow)[3](https://play.google.com/store/apps/details/PayPal_Pay_Send_Save?id=com.paypal.android.p2pmobile&hl=en)
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

    // If the model complains about max_completion_tokens, retry with max_tokens
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

    // Otherwise bubble up
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

  // Add correct token parameter name
  payload[tokenParamName] = maxOutTokens;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  if (!res.ok) {
    // Keep the full body so the UI can show the exact error
    throw new Error(`Azure OpenAI error ${res.status}: ${text}`);
  }

  // Azure chat completions response is JSON; content sits at choices[0].message.content
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // If the service returned non-JSON for some reason
    return text;
  }

  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

function safeJsonParse(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ----------------------------- Evidence gathering ---------------------------- */

async function collectEvidence(siteUrl) {
  const MAX_CHARS = 18000;     // cap prompt size
  const TIMEOUT_MS = 9000;     // fast fail
  const MAX_POLICY_PAGES = 3;  // keep cheap + quick

  const base = new URL(siteUrl);

  const homepageHtml = await fetchText(base.href, TIMEOUT_MS);

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
      policyPages.push({
        url: link,
        error: `Fetch failed: ${String(e)}`
      });
    }
  }

  return {
    fetchedAtUtc: new Date().toISOString(),
    inputUrl: siteUrl,
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
      headers: {
        // Helps with basic bot filtering
        "User-Agent": "Mozilla/5.0 (compatible; WebsiteRiskChecker/1.0)"
      }
    });

    // We still return the HTML even if non-200; the model can use any text available.
    const text = await res.text();
    return text || "";
  } finally {
    clearTimeout(t);
  }
}

function parseSignals(html, pageUrl) {
  const lower = (html || "").toLowerCase();

  // Payment keyword signals (logos often appear in HTML filenames/alt text too)
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
    "privacy policy", "terms", "about", "store locator"
  ].filter(k => lower.includes(k));

  return {
    pageUrl,
    paymentKeywords: uniq(payment),
    shippingKeywords: uniq(shipping),
    returnsKeywords: uniq(returns),
    credibilityKeywords: uniq(credibility)
  };
}

function findPolicyLinks(html, baseUrl) {
  const links = [];
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;

  let m;
  while ((m = hrefRe.exec(html || "")) !== null) {
    const href = m[1];
    if (!href) continue;

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

  // same-origin only + de-dupe
  const base = new URL(baseUrl);
  return uniq(links).filter(l => {
    try { return new URL(l).origin === base.origin; } catch { return false; }
  });
}

function toAbsoluteUrl(href, baseUrl) {
  try {
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
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

/* ----------------------------- SSRF helper ----------------------------- */

function isPrivateIp(hostname) {
  // Only applies if hostname is an IPv4 address
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;

  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4]);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return true;

  // 10.0.0.0/8
  if (a === 10) return true;

  // 127.0.0.0/8
  if (a === 127) return true;

  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}
``
