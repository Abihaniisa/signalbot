// api/proxy.js — Vercel serverless function for CORS
// Your actual API keys are hardcoded below

export default async function handler(req, res) {
  // Enable CORS for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Your actual API keys (hardcoded)
  const TWELVE_DATA_API_KEY = "64b0ff83311a4eada579b609b9306ed7";
  const FMP_API_KEY = "X9TGXoXgdEr7IefdDomc6xXe2xMqpuxB";

  // Determine which API to call
  let targetUrl;
  if (req.url.startsWith('/api/td/')) {
    // Twelve Data API
    const path = req.url.replace('/api/td/', '');
    targetUrl = `https://api.twelvedata.com/${path}`;
    // Inject API key
    const separator = path.includes('?') ? '&' : '?';
    targetUrl += `${separator}apikey=${TWELVE_DATA_API_KEY}`;
  } else if (req.url.startsWith('/api/fmp/')) {
    // FMP API
    const path = req.url.replace('/api/fmp/', '');
    targetUrl = `https://financialmodelingprep.com/stable/${path}`;
    // Inject API key
    const separator = path.includes('?') ? '&' : '?';
    targetUrl += `${separator}apikey=${FMP_API_KEY}`;
  } else {
    res.status(404).json({ error: 'Unknown API endpoint' });
    return;
  }

  try {
    const response = await fetch(targetUrl);
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
}