module.exports = async function (context, req) {
  if (!req.body || !req.body.url) {
    context.res = { status: 400, body: { error: "Missing url in request body" } };
    return;
  }

  const url = String(req.body.url).trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    context.res = { status: 400, body: { error: "Invalid URL format (must be http/https)" } };
    return;
  }

  context.res = {
    status: 200,
    body: {
      site: { name: url.replace(/^https?:\/\//, ""), url },
      breakdown: {
        paymentSafety: 20,
        shipping: 10,
        returnsProcess: 10,
        returnCosts: 5,
        overseasRisk: 10,
        policyClarity: 8,
        customerExperience: 10,
        credibility: 5
      },
      totalScore: 78,
      keyFindings: {
        paymentMethods: ["PayPal (logo)", "Visa/Mastercard (text)"],
        shipping: ["Same-day dispatch claimed; delivery window unclear"],
        returns: ["30-day returns; return shipping not confirmed"],
        overseasRisk: ["Australian brand signals found"],
        reviews: ["Mostly positive customer feedback"]
      },
      verdict: "Low risk"
    }
  };
};
``
