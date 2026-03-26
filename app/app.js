const siteInput = document.getElementById("siteUrl");
const analyzeBtn = document.getElementById("analyzeBtn");

const resultsEl = document.getElementById("results");
const errorEl = document.getElementById("error");
const totalScoreEl = document.getElementById("totalScore");
const verdictEl = document.getElementById("verdict");
const breakdownEl = document.getElementById("breakdown");
const findingsEl = document.getElementById("findings");

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

    const text = await response.text();

    if (!response.ok) {
      // Show generic message to user; log detail for troubleshooting.
      console.error("API error:", response.status, text);
      throw new Error("API error");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("Invalid JSON from API:", text);
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
  totalScoreEl.textContent = typeof data.totalScore === "number" ? data.totalScore : "–";
  verdictEl.textContent = data.verdict || "";

  breakdownEl.innerHTML = "";
  const breakdown = data.breakdown || {};
  for (const [key, value] of Object.entries(breakdown)) {
    const li = document.createElement("li");
    li.textContent = `${humanize(key)}: ${value}`;
    breakdownEl.appendChild(li);
  }

  findingsEl.innerHTML = "";
  const keyFindings = data.keyFindings || {};
  for (const [key, items] of Object.entries(keyFindings)) {
    const li = document.createElement("li");
    if (Array.isArray(items)) {
      li.textContent = `${humanize(key)}: ${items.join("; ")}`;
    } else {
      li.textContent = `${humanize(key)}: ${String(items)}`;
    }
    findingsEl.appendChild(li);
  }

  resultsEl.classList.remove("hidden");
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
``
