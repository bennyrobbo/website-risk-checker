// app/app.js

const siteUrlEl = document.getElementById("siteUrl");
const analyzeBtnEl = document.getElementById("analyzeBtn");

const errorEl = document.getElementById("error");
const resultsEl = document.getElementById("results");

const totalScoreEl = document.getElementById("totalScore");
const verdictEl = document.getElementById("verdict");

const breakdownEl = document.getElementById("breakdown");
const findingsEl = document.getElementById("findings");

const CATEGORY_LABELS = {
  paymentSecurity: "Payment Security",
  businessCredibility: "Business Credibility",
  domainWebsiteAge: "Domain & Website Age",
  shippingReturns: "Shipping & Returns",
  customerReviewsReputation: "Customer Reviews & Reputation",
  contactInfo: "Contact Information",
  scamIndicators: "Scam Indicators",
  overseasFulfilmentRisk: "Overseas / Fulfilment Risk"
};

const BREAKDOWN_ORDER = [
  "paymentSecurity",
  "businessCredibility",
  "domainWebsiteAge",
  "shippingReturns",
  "customerReviewsReputation",
  "contactInfo",
  "scamIndicators",
  "overseasFulfilmentRisk"
];

function showError(message) {
  errorEl.textContent = message || "Something went wrong.";
  errorEl.classList.remove("hidden");
}

function clearError() {
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
}

function showResults() {
  resultsEl.classList.remove("hidden");
}

function hideResults() {
  resultsEl.classList.add("hidden");
}

function setBusy(isBusy) {
  analyzeBtnEl.disabled = isBusy;
  analyzeBtnEl.textContent = isBusy ? "Analyzing…" : "Analyze";
}

function isValidHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function safeArray(x) {
  return Array.isArray(x)
    ? x.filter(v => typeof v === "string" && v.trim().length > 0)
    : [];
}

function addBullets(parent, items) {
  const arr = safeArray(items);
  const ul = document.createElement("ul");

  if (arr.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(none)";
    ul.appendChild(li);
  } else {
    for (const t of arr) {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    }
  }

  parent.appendChild(ul);
}

function renderFindings(keyFindings) {
  findingsEl.innerHTML = "";

  const topRisks = safeArray(keyFindings?.topRisks);
  const topPositives = safeArray(keyFindings?.topPositives);
  const unknowns = safeArray(keyFindings?.unknowns);

  const makeGroup = (title, items) => {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = title;
    li.appendChild(strong);
    addBullets(li, items);
    return li;
  };

  findingsEl.appendChild(makeGroup("Top risks", topRisks));
  findingsEl.appendChild(makeGroup("Top positives", topPositives));
  findingsEl.appendChild(makeGroup("Unknowns / not verified", unknowns));
}

function renderBreakdownScoresOnly(breakdown) {
  breakdownEl.innerHTML = "";

  for (const key of BREAKDOWN_ORDER) {
    const cat = breakdown?.[key];
    if (!cat) continue;

    const score = Number.isFinite(Number(cat.score)) ? Number(cat.score) : 0;
    const max = Number.isFinite(Number(cat.max)) ? Number(cat.max) : 0;

    const li = document.createElement("li");
    li.textContent = `${CATEGORY_LABELS[key] || key}: ${score}/${max}`;
    breakdownEl.appendChild(li);
  }
}

function renderVerdictAndConfidence(verdict, confidence) {
  verdictEl.innerHTML = "";

  const v = (verdict || "").trim() || "Caution";

  const cScore = Number.isFinite(Number(confidence?.score)) ? Number(confidence.score) : null;
  const cLabel = (confidence?.label || "").trim();
  const cReason = (confidence?.reason || "").trim();

  const headline = document.createElement("div");
  headline.style.fontWeight = "700";

  if (cScore !== null && cLabel) {
    headline.textContent = `${v} — Confidence: ${cLabel} (${cScore}/100)`;
  } else if (cScore !== null) {
    headline.textContent = `${v} — Confidence: ${cScore}/100`;
  } else {
    headline.textContent = v;
  }

  verdictEl.appendChild(headline);

  if (cReason) {
    const sub = document.createElement("div");
    sub.style.marginTop = "6px";
    sub.style.opacity = "0.9";
    sub.textContent = cReason;
    verdictEl.appendChild(sub);
  }
}

async function postAnalyze(url) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }

  if (!res.ok) {
    const msg = data?.error
      ? `${data.error}${data.detail ? `: ${data.detail}` : ""}`
      : (text || `HTTP ${res.status}`);
    throw new Error(msg);
  }

  return data;
}

async function handleAnalyze() {
  clearError();
  hideResults();

  const url = (siteUrlEl.value || "").trim();
  if (!isValidHttpUrl(url)) {
    showError("Please enter a valid URL starting with http:// or https://");
    return;
  }

  setBusy(true);

  try {
    const data = await postAnalyze(url);

    totalScoreEl.textContent = Number.isFinite(Number(data.totalScore)) ? data.totalScore : "–";

    renderVerdictAndConfidence(data.verdict, data.confidence);
    renderBreakdownScoresOnly(data.breakdown);
    renderFindings(data.keyFindings);

    showResults();
  } catch (e) {
    showError(e?.message || "Analysis failed.");
  } finally {
    setBusy(false);
  }
}

analyzeBtnEl.addEventListener("click", handleAnalyze);
siteUrlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleAnalyze();
});
``
