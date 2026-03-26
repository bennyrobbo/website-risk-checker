const siteInput = document.getElementById("siteUrl");
const analyzeBtn = document.getElementById("analyzeBtn");

const resultsEl = document.getElementById("results");
const errorEl = document.getElementById("error");
const totalScoreEl = document.getElementById("totalScore");
const verdictEl = document.getElementById("verdict");
const breakdownEl = document.getElementById("breakdown");
const findingsEl = document.getElementById("findings");

analyzeBtn.addEventListener("click", analyze);

async function analyze() {
  clearUI();

  const url = siteInput.value.trim();

  if (!isValidUrl(url)) {
    showError("Please enter a valid website URL (https://...).");
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

    if (!response.ok) {
      throw new Error("Analysis failed.");
    }

    const data = await response.json();
    renderResults(data);

  } catch (err) {
    showError("Unable to analyze this website at the moment.");
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze";
  }
}

function renderResults(data) {
  totalScoreEl.textContent = data.totalScore ?? "–";
  verdictEl.textContent = data.verdict ?? "";

  breakdownEl.innerHTML = "";
  for (const [key, value] of Object.entries(data.breakdown || {})) {
    const li = document.createElement("li");
    li.textContent = `${humanize(key)}: ${value}`;
    breakdownEl.appendChild(li);
  }

  findingsEl.innerHTML = "";
  for (const [key, items] of Object.entries(data.keyFindings || {})) {
    const li = document.createElement("li");
    li.textContent = `${humanize(key)}: ${items.join("; ")}`;
    findingsEl.appendChild(li);
  }

  resultsEl.classList.remove("hidden");
}

function clearUI() {
  resultsEl.classList.add("hidden");
  errorEl.classList.add("hidden");
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
    .replace(/^./, c => c.toUpperCase());
}
``
