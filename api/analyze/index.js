const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  try {
    // 1) Validate input
    const url = req?.body?.url?.trim();
    if (!url) {
      context.res = { status: 400, body: { error: "Missing url in request body" } };
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Bad protocol");
    } catch {
      context.res = { status: 400, body: { error: "Invalid URL format (must be http/https)" } };
      return;
    }

    // Basic SSRF safety for a public endpoint (lightweight)
    const host = parsed.hostname.toLowerCase();
    const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0"];
    if (blockedHosts.includes(host) || host.endsWith(".local")) {
      context.res = { status: 400, body: { error: "URL host not allowed" } };
      return;
    }

    // 2) Load prompt text from /shared/prompt.txt
    
    const fs = require("fs");
    const path = require("path");

    // ...
    const promptPath = path.join(__dirname, "prompt.txt");
    const basePrompt = fs.readFileSync(promptPath, "utf8");


    // 3) Azure OpenAI config
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

    // 4) Call Azure OpenAI (Responses API)
    const response = await fetch(
      `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/responses?api-version=${apiVersion}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey
        },
        body: JSON.stringify({
          input: finalPrompt,
          temperature: 0.2,
          max_output_tokens: 900
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      context.res = { status: 502, body: { error: "Azure OpenAI call failed", detail } };
      return;
    }

    const respJson = await response.json();
    const outputText = extractText(respJson);

    // 5) Parse JSON (retry once if invalid)
    let result;
    try {
      result = JSON.parse(outputText);
    } catch {
      const retryPrompt =
        `${finalPrompt}\n\nIMPORTANT: Return VALID JSON ONLY. No markdown. No extra text.`;

      const retryRes = await fetch(
        `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/responses?api-version=${apiVersion}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": apiKey },
          body: JSON.stringify({
            input: retryPrompt,
            temperature: 0.1,
            max_output_tokens: 900
          })
        }
      );

      if (!retryRes.ok) {
        const detail = await retryRes.text();
        context.res = { status: 502, body: { error: "Retry failed", detail } };
        return;
      }

      const retryJson = await retryRes.json();
      const retryText = extractText(retryJson);

      try {
        result = JSON.parse(retryText);
      } catch {
        context.res = { status: 502, body: { error: "Model did not return valid JSON" } };
        return;
      }
    }

    // 6) Minimal sanity checks
    if (!result || typeof result.totalScore !== "number" || !result.breakdown) {
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

// Extract text from Azure OpenAI Responses API result
function extractText(resp) {
  const parts = [];
  const output = resp?.output || [];
  for (const item of output) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("").trim();
}
