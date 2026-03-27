const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  try {
    // 1) Validate request body
    let body = req.body;

    // Sometimes body may be a string depending on runtime
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const url = (body && body.url ? String(body.url).trim() : "");
    if (!url) {
      context.res = { status: 400, body: { error: "Missing url in request body" } };
      return;
    }

    // 2) Validate URL + basic SSRF protection
    let parsed;
    try {
      parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Bad protocol");
    } catch {
      context.res = { status: 400, body: { error: "Invalid URL format (must be http/https)" } };
      return;
    }

    const host = parsed.hostname.toLowerCase();

    // block localhost-like
    if (host === "localhost" || host.endsWith(".local")) {
      context.res = { status: 400, body: { error: "URL host not allowed" } };
      return;
    }

    // block common private IP ranges if user enters an IP
    if (isPrivateIp(host)) {
      context.res = { status: 400, body: { error: "Private IP hosts are not allowed" } };
      return;
    }

    // 3) Load prompt from local file (deployed with the function)
    const promptPath = path.join(__dirname, "prompt.txt");
    const basePrompt = fs.readFileSync(promptPath, "utf8");

    // Add the URL into the prompt
    const finalPrompt = `${basePrompt}\n\nWebsite URL: ${url}`;

    // 4) Read Azure OpenAI config (set in Static Web App > Configuration)
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

    if (!endpoint || !apiKey || !deployment) {
      context.res = {
        status: 500,
        body: { error: "Azure OpenAI not configured (missing env vars)" }
      };
      return;
    }

    // 5) Call Chat Completions
    const result = await callChatCompletions({
      endpoint,
      apiKey,
      deployment,
      apiVersion,
      prompt: finalPrompt,
      temperature: 0.2,
      maxTokens: 1100
    });

    // 6) Parse JSON from model (retry once if invalid)
    let parsedJson = safeJsonParse(result);
    if (!parsedJson) {
      const retryPrompt = `${finalPrompt}\n\nIMPORTANT: Return VALID JSON ONLY. No markdown. No extra text.`;
      const retry = await callChatCompletions({
        endpoint,
        apiKey,
        deployment,
        apiVersion,
        prompt: retryPrompt,
        temperature: 0.1,
        maxTokens: 1100
      });

      parsedJson = safeJsonParse(retry);
      if (!parsedJson) {
        context.res = { status: 502, body: { error: "Model did not return valid JSON" } };
        return;
      }
    }

    // 7) Minimal sanity check
    if (
      typeof parsedJson.totalScore !== "number" ||
      !parsedJson.breakdown ||
      !parsedJson.keyFindings ||
      !parsedJson.verdict
    ) {
      context.res = { status: 502, body: { error: "Invalid JSON structure from model" } };
      return;
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: parsedJson
    };
  } catch (e) {
    context.res = { status: 500, body: { error: "Server error", detail: String(e) } };
  }
};

async function callChatCompletions({ endpoint, apiKey, deployment, apiVersion, prompt, temperature, maxTokens }) {
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const payload = {
    messages: [
      { role: "system", content: "You are a strict JSON generator. Output JSON only." },
      { role: "user", content: prompt }
    ],
    temperature,
    max_completion_tokens: maxTokens
  };

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
    throw new Error(`Azure OpenAI error ${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // If response isn't JSON, return raw text and let caller fail.
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
