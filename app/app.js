// app/app.js

const siteUrlEl = document.getElementById("siteUrl");
const analyzeBtnEl = document.getElementById("analyzeBtn");
const errorEl = document.getElementById("error");
const resultsEl = document.getElementById("results");
const totalScoreEl = document.getElementById("totalScore");
const verdictEl = document.getElementById("verdict");
const breakdownEl = document.getElementById("breakdown");
const findingsEl = document.getElementById("findings");

// Labels for the backend schema keys
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
  return Array.isArray(x) ? x.filter(v => typeof v === "string" && v.trim().length > 0) : [];
}

function makeUl(items) {
  const ul = document.createElement("ul");
  const arr = safeArray(items);

  if (arr.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(none)";
    ul.appendChild(li);
    return ul;
  }

  for (const item of arr) {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

function makeSectionLi(title, items) {
  const li = document.createElement("li");
  const strong = document.createElement("strong");
  strong.textContent = title;
  li.appendChild(strong);
  li.appendChild(makeUl(items));
  return li;
}

function renderKeyFindings(keyFindings) {
  findingsEl.innerHTML = "";

  const risks = keyFindings?.topRisks;
  const positives = keyFindings?.topPositives;
  const unknowns = keyFindings?.unknowns;

  findingsEl.appendChild(makeSectionLi("Top risks", risks));
  findingsEl.appendChild(makeSectionLi("Top positives", positives));
  findingsEl.appendChild(makeSectionLi("Unknowns / not verified", unknowns));
}

function renderBreakdown(breakdown) {
  breakdownEl.innerHTML = "";

  const keysInOrder = [
    "paymentSecurity",
    "businessCredibility",
    "domainWebsiteAge",
    "shippingReturns",
    "customerReviewsReputation",
    "contactInfo",
    "scamIndicators",
    "overseasFulfilmentRisk"
  ];

  for (const key of keysInOrder) {
    const cat = breakdown?.[key];
    if (!cat) continue;

    const outerLi = document.createElement("li");

    const heading = document.createElement("div");
    const title = CATEGORY_LABELS[key] || key;

    const score = typeof cat.score === "number" ? cat.score : 0;
    const max = typeof cat.max === "number" ? cat.max : 0;

    heading.innerHTML = `<strong>${title}</strong> — ${score}/${max}`;
    outerLi.appendChild(heading);

    // Evidence / Risks / Unable to verify as bullet lists
    const evidenceTitle = document.createElement("div");
    evidenceTitle.innerHTML = "<em>Evidence found</em>";
    outerLi.appendChild(evidenceTitle);
    outerLi.appendChild(makeUl(cat.evidenceFound));

    const risksTitle = document.createElement("div");
    risksTitle.innerHTML = "<em>Risks identified</em>";
    outerLi.appendChild(risksTitle);
    outerLi.appendChild(makeUl(cat.risksIdentified));

    const unknownTitle = document.createElement("div");
    unknownTitle.innerHTML = "<em>Unable to verify</em>";
    outerLi.appendChild(unknownTitle);
    outerLi.appendChild(makeUl(cat.unableToVerify));

    breakdownEl.appendChild(outerLi);
  }
}

async function postAnalyze(url) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  // Read text first so we can show a helpful error even if JSON parse fails
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }

  if (!res.ok) {
    // If backend returns JSON error shape, show it. Otherwise show text.
    const msg = data?.error ? `${data.error}${data.detail ? `: ${data.detail}` : ""}` : (text || `HTTP ${res.status}`);
    throw new Error(msg);
  }

  // Should be your full result object
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

    // These fields are required by your backend validation:
    // totalScore, maxScore, verdict, keyFindings, breakdown [1](https://microsoftapc-my.sharepoint.com/personal/benrobinson_microsoft_com/Documents/Microsoft%20Copilot%20Chat%20Files/index.js)
    totalScoreEl.textContent = typeof data.totalScore === "number" ? data.totalScore : "–";
    verdictEl.textContent = data.verdict || "";

    renderBreakdown(data.breakdown);
    renderKeyFindings(data.keyFindings);

    showResults();
  } catch (e) {
    showError(e?.message || "Analysis failed.");
  } finally {
    setBusy(false);
  }
}

analyzeBtnEl.addEventListener("click", handleAnalyze);

// Enter key to submit
siteUrlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleAnalyze();
});
``
