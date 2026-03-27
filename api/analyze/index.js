// api/analyze/index.js (temporary stability stub)

module.exports = async function (context, req) {
  try {
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

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ok: true, url: inputUrl }
    };
  } catch (e) {
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Server error", detail: String(e) }
    };
  }
};
