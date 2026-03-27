// /app/app.js

const siteInput = document.getElementById("siteUrl");
const analyzeBtn = document.getElementById("analyzeBtn");

const resultsEl = document.getElementById("results");
const errorEl = document.getElementById("error");
const totalScoreEl = document.getElementById("totalScore");
const verdictEl = document.getElementById("verdict");
const breakdownEl = document.getElementById("breakdown");
const findingsEl = document.getElementById("findings");

// Max points per category (matches the updated scoring model)
const MAX_POINTS = {
  paymentSafety: 20,
  shipping: 15,
  returnsProcess: 20,
  returnCosts: 10,
  scamRisk: 10,
  policyClarity: 10,
  customerExperience: 10,
  credibility: 5
};

// Render order (consistent every time)
const BREAKDOWN_ORDER = [
  "paymentSafety",
  "shipping",
  "returnsProcess",
  "returnCosts",
  "scamRisk",
  "policyClarity",
  "customerExperience",
  "credibility"
];

analyzeBtn.addEventListener("click", analyze);
siteInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyze();
});

async function analyze() {
  clearUI();

  const url = siteInput.value.trim();

  if (!isValidUrl(url)) {
    showError("Please enter a valid website URL (must start with https:// or http://).");
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtn.textContent = "Analyzing...";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("API error:", response.status, raw);
      throw new Error("API error");
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON from API:", raw);
      throw new Error("Invalid JSON");
    }

    renderResults(data);
  } catch (err) {
    showError("Unable to analyze this website at the moment.");
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze";
  }
}

function renderResults(data) {
  // Total score
  totalScoreEl.textContent = typeof data.totalScore === "number" ? data.totalScore : "–";

  // Verdict
  verdictEl.textContent = data.verdict || "";

  // Score breakdown: show X/Y
  breakdownEl.innerHTML = "";
  const breakdown = data.breakdown || {};

  for (const key of BREAKDOWN_ORDER) {
    const value = breakdown[key];
    const max = MAX_POINTS[key];

    const li = document.createElement("li");
    if (typeof value === "number" && typeof max === "number") {
      li.textContent = `${humanize(key)}: ${value}/${max}`;
    } else {
      li.textContent = `${humanize(key)}: Not scored`;
    }
    breakdownEl.appendChild(li);
  }

  // Key findings
  findingsEl.innerHTML = "";
  const keyFindings = data.keyFindings || {};

  // Render in a consistent order if present (optional)
  const FINDINGS_ORDER = ["paymentMethods", "shipping", "returns", "scamRisk", "reviews"];

  for (const k of FINDINGS_ORDER) {
    if (!(k in keyFindings)) continue;
    appendFinding(k, keyFindings[k]);
  }

  // Render any extra keys (if model returns additional keys)
  for (const [k, v] of Object.entries(keyFindings)) {
    if (FINDINGS_ORDER.includes(k)) continue;
    appendFinding(k, v);
  }

  resultsEl.classList.remove("hidden");
}

function appendFinding(key, items) {
  const li = document.createElement("li");
  if (Array.isArray(items)) {
    li.textContent = `${humanize(key)}: ${items.join("; ")}`;
  } else {
    li.textContent = `${humanize(key)}: ${String(items)}`;
  }
  findingsEl.appendChild(li);
}

function clearUI() {
  resultsEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function humanize(str) {
  return str
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
