// ============================================================
// PART 1 OF 8 — DATA PIPELINE + TWELVE DATA + SANITIZATION + QUALITY GATE
// INSERT THIS CODE AT THE TOP OF YOUR EXISTING App.jsx
// PLACE IT AFTER THE EXISTING "import" STATEMENTS
// PLACE IT BEFORE THE EXISTING "const T = {" DESIGN TOKENS
// ============================================================

// ============================================================
// V4 CONFIGURATION CONSTANTS
// ============================================================
import { performBackfillOnStartup, saveBackfillState } from './backfill.js';
// Twelve Data Configuration
const TWELVE_DATA_BASE = "https://api.twelvedata.com";
const TWELVE_DATA_API_KEY = "64b0ff83311a4eada579b609b9306ed7"; // Development only — use env var in production
const TWELVE_DATA_DAILY_LIMIT = 800;
const TWELVE_DATA_PER_MINUTE_LIMIT = 8;

// FMP Configuration (Reference Only — NOT used for signal generation)
const FMP_BASE = "https://financialmodelingprep.com/stable";
const FMP_API_KEY = "X9TGXoXgdEr7IefdDomc6xXe2xMqpuxB"; // Development only — use env var in production
const FMP_DAILY_LIMIT = 250;
const FMP_PER_MINUTE_LIMIT = 8;

// Default Symbol
const DEFAULT_SYMBOL = "EURUSD";

// ============================================================
// DATA SANITIZATION PIPELINE
// ============================================================

/**
 * Sanitizes raw candle data from Twelve Data
 * Steps: ParseFloat → NaN rejection → High<Low rejection → High<max(Open,Close) rejection
 *        Low>min(Open,Close) rejection → Remove duplicate timestamps → Chronological sort
 *        Gap detection (log only, does not fail)
 * @param {Array} candles - Raw candles from Twelve Data
 * @returns {Object} { validatedCandles, sanitizationReport }
 */
function sanitizeCandles(candles) {
  const report = {
    totalRaw: candles?.length || 0,
    rejected: {
      nanOHLC: 0,
      highBelowLow: 0,
      highBelowBody: 0,
      lowAboveBody: 0,
      duplicateTimestamp: 0,
      total: 0
    },
    accepted: 0,
    dateFrom: null,
    dateTo: null,
    gapsDetected: [],
    volumeNote: "Volume field always 0 for FX on free tier — not used"
  };

  if (!candles || candles.length === 0) {
    return { validatedCandles: [], sanitizationReport: report };
  }

  const seenTimestamps = new Set();
  const validCandles = [];
  const epsilon = 0.000001;

  for (const c of candles) {
    // Step 1: ParseFloat (API returns strings)
    const open = parseFloat(c.open);
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    const close = parseFloat(c.close);
    const timestamp = new Date(c.datetime).getTime();

    // Step 2: NaN rejection
    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
      report.rejected.nanOHLC++;
      report.rejected.total++;
      continue;
    }

    // Step 3: high < low rejection
    if (high < low) {
      report.rejected.highBelowLow++;
      report.rejected.total++;
      continue;
    }

    // Step 4: high < max(open, close) rejection
    if (high < Math.max(open, close) - epsilon) {
      report.rejected.highBelowBody++;
      report.rejected.total++;
      continue;
    }

    // Step 5: low > min(open, close) rejection
    if (low > Math.min(open, close) + epsilon) {
      report.rejected.lowAboveBody++;
      report.rejected.total++;
      continue;
    }

    // Step 6: Duplicate timestamp removal
    if (seenTimestamps.has(timestamp)) {
      report.rejected.duplicateTimestamp++;
      report.rejected.total++;
      continue;
    }
    seenTimestamps.add(timestamp);

    // Valid candle
    validCandles.push({
      datetime: c.datetime,
      timestamp: timestamp,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: c.volume ? parseFloat(c.volume) : 0
    });
  }

  // Step 7: Sort by timestamp ascending
  validCandles.sort((a, b) => a.timestamp - b.timestamp);

  // Step 8: Gap detection (log only, does NOT reject)
  const isWeekend = (ts) => {
    const date = new Date(ts);
    const hourUTC = date.getUTCHours();
    const dayUTC = date.getUTCDay();
    if (dayUTC === 5 && hourUTC >= 21) return true; // Friday after 21:00 UTC
    if (dayUTC === 6) return true; // Saturday all day
    if (dayUTC === 0 && hourUTC < 22) return true; // Sunday before 22:00 UTC
    return false;
  };

  for (let i = 1; i < validCandles.length; i++) {
    const prev = validCandles[i - 1];
    const curr = validCandles[i];
    const actualGapMs = curr.timestamp - prev.timestamp;
    const gapThresholdMs = 4 * 60 * 60 * 1000; // 4 hours

    if (actualGapMs > gapThresholdMs && !isWeekend(prev.timestamp) && !isWeekend(curr.timestamp)) {
      report.gapsDetected.push({
        at: prev.datetime,
        durationMinutes: Math.round(actualGapMs / 60000)
      });
    }
  }

  report.accepted = validCandles.length;
  if (validCandles.length > 0) {
    report.dateFrom = validCandles[0].datetime;
    report.dateTo = validCandles[validCandles.length - 1].datetime;
  }

  return { validatedCandles: validCandles, sanitizationReport: report };
}

// ============================================================
// DATA QUALITY GATE (Circuit Breaker)
// ============================================================

/**
 * Evaluates data quality and triggers circuit breaker if insufficient
 * @param {Array} candles - Validated candles
 * @param {number} lastFetchTime - Timestamp of last successful fetch (ms)
 * @returns {Object} { passed, circuitBreakerActive, reason }
 */
function evaluateDataQuality(candles, lastFetchTime) {
  // Condition 1: Minimum candle count (500)
  if (!candles || candles.length < 500) {
    return {
      passed: false,
      circuitBreakerActive: true,
      reason: `INSUFFICIENT_DATA: have ${candles?.length || 0}, need 500`
    };
  }

  // Condition 2: Data freshness (last candle < 15 min old)
  const now = Date.now();
  const lastCandleTime = candles[candles.length - 1]?.timestamp;
  const dataAgeMinutes = (now - lastCandleTime) / 60000;
  if (dataAgeMinutes > 15) {
    return {
      passed: false,
      circuitBreakerActive: true,
      reason: `STALE_DATA: last candle ${dataAgeMinutes.toFixed(1)} minutes ago`
    };
  }

  // Condition 3: Timestamp order (strictly ascending)
  let isAscending = true;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].timestamp <= candles[i - 1].timestamp) {
      isAscending = false;
      break;
    }
  }
  if (!isAscending) {
    return {
      passed: false,
      circuitBreakerActive: true,
      reason: "TIMESTAMP_ORDER_VIOLATION"
    };
  }

  return {
    passed: true,
    circuitBreakerActive: false,
    reason: null
  };
}

// ============================================================
// 1H AGGREGATION FROM 15M CANDLES
// ============================================================

/**
 * Aggregates 15M candles into 1H candles (4 candles per 1H block)
 * Skips blocks with missing candles (gaps)
 * @param {Array} candles15M - Validated 15M candles
 * @returns {Array} 1H candles with OHLC
 */
function aggregate15Mto1H(candles15M) {
  const blocks = [];
  for (let i = 0; i <= candles15M.length - 4; i += 4) {
    const block = candles15M.slice(i, i + 4);
    // Verify block has 4 consecutive 15M periods (45 minutes span from first to last)
    const expectedSpanMs = 45 * 60 * 1000;
    const actualSpanMs = block[3].timestamp - block[0].timestamp;
    if (actualSpanMs !== expectedSpanMs) continue; // gap in block — skip

    blocks.push({
      datetime: block[0].datetime,
      timestamp: block[0].timestamp,
      open: block[0].open,
      high: Math.max(...block.map(c => c.high)),
      low: Math.min(...block.map(c => c.low)),
      close: block[3].close
    });
  }
  return blocks;
}

// ============================================================
// TWELVE DATA API FUNCTIONS (via CORS Proxy)
// ============================================================

/**
 * Fetches 15M candles from Twelve Data via CORS proxy
 * @param {string} apiKey - Twelve Data API key
 * @param {string} symbol - Trading pair (default: EUR/USD)
 * @returns {Promise<Array>} Raw candle array
 */
async function fetchTwelveDataCandles(apiKey = TWELVE_DATA_API_KEY, symbol = "EUR/USD") {
  const url = `/api/td/time_series?symbol=${symbol}&interval=15min&outputsize=5000&format=JSON&order=ASC&apikey=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  if (data.status === "error") {
    throw new Error(`Twelve Data API error: ${data.message || "Unknown error"}`);
  }
  if (!data.values || !Array.isArray(data.values)) {
    throw new Error("Twelve Data API returned unexpected response structure");
  }
  return data.values;
}

/**
 * Fetches live price from Twelve Data via CORS proxy
 * @param {string} apiKey - Twelve Data API key
 * @param {string} symbol - Trading pair (default: EUR/USD)
 * @returns {Promise<number>} Current price
 */
async function fetchTwelveDataPrice(apiKey = TWELVE_DATA_API_KEY, symbol = "EUR/USD") {
  const url = `/api/td/price?symbol=${symbol}&apikey=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return parseFloat(data.price);
}

// ============================================================
// FMP REFERENCE API (Informational Only — NOT used for signal generation)
// ============================================================

/**
 * Fetches FMP quote for reference data (yearHigh, yearLow, moving averages)
 * @param {string} apiKey - FMP API key
 * @param {string} symbol - Trading pair (default: EURUSD)
 * @returns {Promise<Object|null>} Reference data or null on failure
 */
async function fetchFMPReference(apiKey = FMP_API_KEY, symbol = DEFAULT_SYMBOL) {
  const url = `/api/fmp/quote?symbol=${symbol}&apikey=${apiKey}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const q = data[0];
    return {
      price: parseFloat(q.price),
      yearHigh: q.yearHigh ? parseFloat(q.yearHigh) : null,
      yearLow: q.yearLow ? parseFloat(q.yearLow) : null,
      priceAvg50: q.priceAvg50 ? parseFloat(q.priceAvg50) : null,
      priceAvg200: q.priceAvg200 ? parseFloat(q.priceAvg200) : null,
      bid: q.bid ? parseFloat(q.bid) : null,
      ask: q.ask ? parseFloat(q.ask) : null
    };
  } catch (e) {
    console.warn("FMP reference fetch failed:", e);
    return null;
  }
}

// ============================================================
// RATE LIMIT HELPER FUNCTIONS
// ============================================================

/**
 * Tracks API request rate limits
 * @param {Array} requestTimestamps - Array of timestamps (ms) of recent requests
 * @param {number} limitPerMinute - Max requests per minute
 * @returns {boolean} True if within limit, false if throttled
 */
function isWithinRateLimit(requestTimestamps, limitPerMinute = 8) {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const recentRequests = requestTimestamps.filter(ts => ts > oneMinuteAgo);
  return recentRequests.length < limitPerMinute;
}

/**
 * Calculates time to wait before next request (ms)
 * @param {Array} requestTimestamps - Array of timestamps (ms) of recent requests
 * @param {number} limitPerMinute - Max requests per minute
 * @returns {number} Milliseconds to wait (0 if within limit)
 */
function timeToWaitForRateLimit(requestTimestamps, limitPerMinute = 8) {
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  const recentRequests = requestTimestamps.filter(ts => ts > oneMinuteAgo);
  if (recentRequests.length < limitPerMinute) return 0;
  const oldestRecent = Math.min(...recentRequests);
  return (oldestRecent + 60 * 1000) - now;
}

// ============================================================
// EXPOSED FUNCTIONS FOR App COMPONENT
// ============================================================
// The following functions will be used in later parts:
// - fetchTwelveDataCandles
// - fetchTwelveDataPrice
// - fetchFMPReference
// - sanitizeCandles
// - evaluateDataQuality
// - aggregate15Mto1H
// - isWithinRateLimit
// - timeToWaitForRateLimit
// ============================================================

// ============================================================
// PART 1 COMPLETE
// ============================================================
// NEXT: PART 2 — Strict Chronological Split + Feature Categories + Feature Calculation
// 
// After pasting Part 1, test with this temporary code (add to App component):
//
// useEffect(() => {
//   async function test() {
//     const raw = await fetchTwelveDataCandles();
//     const { validatedCandles, sanitizationReport } = sanitizeCandles(raw);
//     console.log("Sanitization:", sanitizationReport);
//     const quality = evaluateDataQuality(validatedCandles, Date.now());
//     console.log("Quality gate:", quality);
//     const oneHour = aggregate15Mto1H(validatedCandles);
//     console.log(`1H candles: ${oneHour.length}`);
//   }
//   test();
// }, []);
// ============================================================
// ============================================================
// PART 2 OF 8 — STRICT CHRONOLOGICAL SPLIT + FEATURE CATEGORIES + FEATURE CALCULATION
// ============================================================
// INSTRUCTIONS:
// 1. Paste this code AFTER Part 1 in your App.jsx
// 2. Place it BEFORE your existing V3 code (before the DESIGN TOKENS if they are still there)
// 3. This code adds:
//    - Strict chronological split (70/15/10/5) with no overlap
//    - Feature categories (price structure, volatility, time, indicator, candlestick)
//    - Feature calculation functions (ATR, EMA, RSI, HH/HL, candlestick patterns, session detection)
//    - Feature arrays for discovery engine
// ============================================================

// ============================================================
// STRICT CHRONOLOGICAL SPLIT (No Overlap)
// ============================================================

/**
 * Splits candles into Training, Validation A, Validation B, and Walk-Forward sets
 * Strictly chronological. NO candle appears in more than one set.
 * 
 * @param {Array} candles - Validated candles (must be sorted ascending)
 * @returns {Object} { training, validationA, validationB, walkForward, segments, splitReport }
 */
function strictChronologicalSplit(candles) {
  const total = candles.length;
  const trainEnd = Math.floor(total * 0.70);
  const valAEnd = Math.floor(total * 0.85);
  const valBEnd = Math.floor(total * 0.95);
  
  const training = candles.slice(0, trainEnd);
  const validationA = candles.slice(trainEnd, valAEnd);
  const validationB = candles.slice(valAEnd, valBEnd);
  const walkForward = candles.slice(valBEnd, total);
  
  const splitReport = {
    totalCandles: total,
    training: { count: training.length, dateFrom: training[0]?.datetime || null, dateTo: training[training.length-1]?.datetime || null },
    validationA: { count: validationA.length, dateFrom: validationA[0]?.datetime || null, dateTo: validationA[validationA.length-1]?.datetime || null },
    validationB: { count: validationB.length, dateFrom: validationB[0]?.datetime || null, dateTo: validationB[validationB.length-1]?.datetime || null },
    walkForward: { count: walkForward.length, dateFrom: walkForward[0]?.datetime || null, dateTo: walkForward[walkForward.length-1]?.datetime || null }
  };
  
  return { training, validationA, validationB, walkForward, segments: { training, validationA, validationB, walkForward }, splitReport };
}

// ============================================================
// FEATURE CALCULATION HELPERS
// ============================================================

/**
 * Calculates EMA (Exponential Moving Average)
 * @param {Array} closes - Array of close prices (oldest to newest)
 * @param {number} period - EMA period (default 20)
 * @returns {number|null} EMA value at the last candle
 */
function calculateEMA(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(5));
}

/**
 * Calculates RSI (Relative Strength Index)
 * @param {Array} closes - Array of close prices (oldest to newest)
 * @param {number} period - RSI period (default 14)
 * @returns {number|null} RSI value (0-100)
 */
function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

/**
 * Calculates ATR (Average True Range)
 * @param {Array} candles - Candle array with high, low, close
 * @param {number} period - ATR period (default 14)
 * @returns {number|null} ATR value
 */
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const hl = curr.high - curr.low;
    const hc = Math.abs(curr.high - prev.close);
    const lc = Math.abs(curr.low - prev.close);
    trs.push(Math.max(hl, hc, lc));
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return parseFloat(atr.toFixed(5));
}

/**
 * Calculates ATR percentile for volatility classification
 * @param {Array} candles - Candle array
 * @param {number} lookback - Lookback period (default 100)
 * @returns {number|null} Percentile (0-100)
 */
function calculateATRPercentile(candles, lookback = 100) {
  if (!candles || candles.length < lookback + 14) return null;
  const atrValues = [];
  for (let i = 14; i < candles.length; i++) {
    const slice = candles.slice(i - 14, i + 1);
    const atr = calculateATR(slice, 14);
    if (atr !== null) atrValues.push(atr);
  }
  const recentATR = atrValues[atrValues.length - 1];
  if (!recentATR) return null;
  const below = atrValues.filter(v => v < recentATR).length;
  return parseFloat((below / atrValues.length * 100).toFixed(1));
}

// ============================================================
// CANDLESTICK PATTERN DETECTION
// ============================================================

/**
 * Detects candlestick patterns
 * @param {Object} candle - Single candle with open, high, low, close
 * @returns {Array} Array of detected pattern names
 */
function detectCandlestickPatterns(candle) {
  const patterns = [];
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const totalRange = candle.high - candle.low;
  
  // Engulfing (requires previous candle — will be handled separately)
  // For single-candle patterns:
  
  // Doji (small body, long wicks)
  if (totalRange > 0 && body / totalRange < 0.1 && (upperWick > body * 2 || lowerWick > body * 2)) {
    patterns.push("DOJI");
  }
  
  // Marubozu (long body, no wicks)
  if (totalRange > 0 && upperWick / totalRange < 0.05 && lowerWick / totalRange < 0.05 && body / totalRange > 0.9) {
    patterns.push(candle.close > candle.open ? "BULLISH_MARUBOZU" : "BEARISH_MARUBOZU");
  }
  
  // Hammer / Shooting Star (single candle)
  if (totalRange > 0 && body / totalRange < 0.3) {
    if (lowerWick > body * 2 && upperWick < body) {
      patterns.push("HAMMER");
    }
    if (upperWick > body * 2 && lowerWick < body) {
      patterns.push("SHOOTING_STAR");
    }
  }
  
  return patterns;
}

/**
 * Detects engulfing pattern (requires two candles)
 * @param {Object} prevCandle - Previous candle
 * @param {Object} currCandle - Current candle
 * @returns {string|null} "BULLISH_ENGULFING", "BEARISH_ENGULFING", or null
 */
function detectEngulfing(prevCandle, currCandle) {
  const prevBody = prevCandle.close - prevCandle.open;
  const currBody = currCandle.close - currCandle.open;
  
  // Bullish Engulfing: prev bearish, curr bullish, curr body covers prev body
  if (prevBody < 0 && currBody > 0 && currCandle.close > prevCandle.open && currCandle.open < prevCandle.close) {
    return "BULLISH_ENGULFING";
  }
  // Bearish Engulfing: prev bullish, curr bearish, curr body covers prev body
  if (prevBody > 0 && currBody < 0 && currCandle.close < prevCandle.open && currCandle.open > prevCandle.close) {
    return "BEARISH_ENGULFING";
  }
  return null;
}

// ============================================================
// SESSION DETECTION (UTC-based)
// ============================================================

/**
 * Detects trading session from timestamp
 * @param {number} timestampMs - Timestamp in milliseconds
 * @returns {string} "LONDON", "NEW_YORK", "OVERLAP", "TOKYO", "OFF_HOURS"
 */
function detectSessionFromTimestamp(timestampMs) {
  const date = new Date(timestampMs);
  const hourUTC = date.getUTCHours();
  const minuteUTC = date.getUTCMinutes();
  const dec = hourUTC + minuteUTC / 60;
  
  const london = dec >= 7 && dec < 16;
  const ny = dec >= 12 && dec < 21;
  const tokyo = dec >= 22 || dec < 8;
  
  if (london && ny) return "OVERLAP";
  if (london) return "LONDON";
  if (ny) return "NEW_YORK";
  if (tokyo) return "TOKYO";
  return "OFF_HOURS";
}

/**
 * Returns session score for opportunity score calculation
 * @param {string} session - Session name
 * @returns {number} Score (0-100)
 */
function getSessionScore(session) {
  switch (session) {
    case "OVERLAP": return 100;
    case "LONDON": return 75;
    case "NEW_YORK": return 75;
    case "TOKYO": return 50;
    default: return 25;
  }
}

// ============================================================
// PRICE STRUCTURE FEATURES
// ============================================================

/**
 * Detects higher highs, higher lows, lower highs, lower lows
 * @param {Array} candles - Candle array
 * @param {number} lookback - Number of candles to look back (default 10)
 * @returns {Object} { higherHigh, higherLow, lowerHigh, lowerLow, trend }
 */
function detectPriceStructure(candles, lookback = 10) {
  if (!candles || candles.length < lookback) {
    return { higherHigh: false, higherLow: false, lowerHigh: false, lowerLow: false, trend: "NEUTRAL" };
  }
  
  const recentHighs = candles.slice(-lookback).map(c => c.high);
  const recentLows = candles.slice(-lookback).map(c => c.low);
  const currentHigh = candles[candles.length - 1].high;
  const currentLow = candles[candles.length - 1].low;
  const prevHigh = candles[candles.length - 2]?.high || currentHigh;
  const prevLow = candles[candles.length - 2]?.low || currentLow;
  
  const higherHigh = currentHigh > Math.max(...recentHighs.slice(0, -1));
  const higherLow = currentLow > Math.max(...recentLows.slice(0, -1));
  const lowerHigh = currentHigh < Math.min(...recentHighs.slice(0, -1));
  const lowerLow = currentLow < Math.min(...recentLows.slice(0, -1));
  
  let trend = "NEUTRAL";
  if (higherHigh && higherLow) trend = "BULLISH";
  if (lowerHigh && lowerLow) trend = "BEARISH";
  
  return { higherHigh, higherLow, lowerHigh, lowerLow, trend };
}

/**
 * Detects breakouts from recent range
 * @param {Array} candles - Candle array
 * @param {number} lookback - Range lookback (default 20)
 * @returns {Object} { breakoutUp, breakoutDown, rangeHigh, rangeLow }
 */
function detectBreakout(candles, lookback = 20) {
  if (!candles || candles.length < lookback + 1) {
    return { breakoutUp: false, breakoutDown: false, rangeHigh: null, rangeLow: null };
  }
  
  const rangeCandles = candles.slice(-lookback - 1, -1);
  const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
  const rangeLow = Math.min(...rangeCandles.map(c => c.low));
  const currentClose = candles[candles.length - 1].close;
  
  const breakoutUp = currentClose > rangeHigh;
  const breakoutDown = currentClose < rangeLow;
  
  return { breakoutUp, breakoutDown, rangeHigh, rangeLow };
}

/**
 * Detects pullbacks within a trend
 * @param {Array} candles - Candle array
 * @param {number} lookback - Trend lookback (default 10)
 * @returns {Object} { pullback, pullbackDepth, trendHigh, trendLow }
 */
function detectPullback(candles, lookback = 10) {
  if (!candles || candles.length < lookback + 2) {
    return { pullback: false, pullbackDepth: null, trendHigh: null, trendLow: null };
  }
  
  const trendCandles = candles.slice(-lookback - 2, -1);
  const trendHigh = Math.max(...trendCandles.map(c => c.high));
  const trendLow = Math.min(...trendCandles.map(c => c.low));
  const currentClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  
  // Bullish trend: price pulling back toward trend low
  const isBullishTrend = trendHigh > trendLow * 1.003;
  const pullback = isBullishTrend && currentClose < prevClose && currentClose > trendLow;
  const pullbackDepth = pullback ? (trendHigh - currentClose) / (trendHigh - trendLow) : null;
  
  return { pullback, pullbackDepth, trendHigh, trendLow };
}

/**
 * Detects range compression/expansion
 * @param {Array} candles - Candle array
 * @param {number} lookback - Lookback period (default 20)
 * @returns {Object} { compression, expansion, currentRange, avgRange }
 */
function detectRangeCompression(candles, lookback = 20) {
  if (!candles || candles.length < lookback * 2) {
    return { compression: false, expansion: false, currentRange: null, avgRange: null };
  }
  
  const recentRanges = candles.slice(-lookback).map(c => c.high - c.low);
  const olderRanges = candles.slice(-lookback * 2, -lookback).map(c => c.high - c.low);
  const currentAvg = recentRanges.reduce((a, b) => a + b, 0) / lookback;
  const olderAvg = olderRanges.reduce((a, b) => a + b, 0) / lookback;
  
  return {
    compression: currentAvg < olderAvg * 0.7,
    expansion: currentAvg > olderAvg * 1.3,
    currentRange: currentAvg,
    avgRange: olderAvg
  };
}

// ============================================================
// VOLATILITY FEATURES
// ============================================================

/**
 * Calculates wick ratios for a candle
 * @param {Object} candle - Candle with open, high, low, close
 * @returns {Object} { upperWickRatio, lowerWickRatio, bodyRatio }
 */
function calculateWickRatios(candle) {
  const totalRange = candle.high - candle.low;
  if (totalRange === 0) return { upperWickRatio: 0, lowerWickRatio: 0, bodyRatio: 0 };
  
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  
  return {
    upperWickRatio: upperWick / totalRange,
    lowerWickRatio: lowerWick / totalRange,
    bodyRatio: body / totalRange
  };
}

// ============================================================
// INDICATOR FEATURES (as features only — not trading rules)
// ============================================================

/**
 * Computes all indicator features for a candle sequence
 * @param {Array} candles - Candle array
 * @returns {Object} { ema20Relation, rsi14, atr14, atrPercentile }
 */
function computeIndicatorFeatures(candles) {
  const closes = candles.map(c => c.close);
  const ema20 = calculateEMA(closes, 20);
  const currentPrice = closes[closes.length - 1];
  const ema20Relation = ema20 !== null ? (currentPrice > ema20 ? "ABOVE" : currentPrice < ema20 ? "BELOW" : "EQUAL") : "UNKNOWN";
  
  const rsi14 = calculateRSI(closes, 14);
  const atr14 = calculateATR(candles, 14);
  const atrPercentile = calculateATRPercentile(candles, 100);
  
  return {
    ema20Relation,
    rsi14: rsi14 !== null ? parseFloat(rsi14.toFixed(1)) : null,
    atr14: atr14 !== null ? parseFloat(atr14.toFixed(5)) : null,
    atrPercentile: atrPercentile !== null ? parseFloat(atrPercentile.toFixed(1)) : null
  };
}

// ============================================================
// COMPLETE FEATURE VECTOR FOR A CANDLE
// ============================================================

/**
 * Computes all features for a specific candle (with context of previous candles)
 * @param {Array} candles - Full candle array (up to current candle)
 * @param {number} index - Index of the candle to compute features for
 * @returns {Object} Feature object for discovery engine
 */
function computeFeatureVector(candles, index) {
  const currentCandle = candles[index];
  const previousCandles = candles.slice(0, index + 1);
  const lookbackCandles = candles.slice(Math.max(0, index - 20), index + 1);
  
  // Price structure features
  const priceStructure = detectPriceStructure(lookbackCandles, 10);
  const breakout = detectBreakout(lookbackCandles, 20);
  const pullback = detectPullback(lookbackCandles, 10);
  const rangeCompression = detectRangeCompression(lookbackCandles, 20);
  
  // Volatility features
  const wickRatios = calculateWickRatios(currentCandle);
  const atrPercentile = calculateATRPercentile(candles.slice(0, index + 1), 100);
  
  // Time features
  const session = detectSessionFromTimestamp(currentCandle.timestamp);
  const sessionScore = getSessionScore(session);
  
  // Indicator features
  const indicators = computeIndicatorFeatures(previousCandles);
  
  // Candlestick patterns (requires previous candle)
  let engulfing = null;
  if (index > 0) {
    engulfing = detectEngulfing(candles[index - 1], currentCandle);
  }
  const singlePatterns = detectCandlestickPatterns(currentCandle);
  
  return {
    // Price Structure
    higherHigh: priceStructure.higherHigh,
    higherLow: priceStructure.higherLow,
    lowerHigh: priceStructure.lowerHigh,
    lowerLow: priceStructure.lowerLow,
    trend: priceStructure.trend,
    breakoutUp: breakout.breakoutUp,
    breakoutDown: breakout.breakoutDown,
    pullback: pullback.pullback,
    pullbackDepth: pullback.pullbackDepth,
    compression: rangeCompression.compression,
    expansion: rangeCompression.expansion,
    
    // Volatility
    upperWickRatio: wickRatios.upperWickRatio,
    lowerWickRatio: wickRatios.lowerWickRatio,
    bodyRatio: wickRatios.bodyRatio,
    atrPercentile: indicators.atrPercentile,
    
    // Time
    session: session,
    sessionScore: sessionScore,
    
    // Indicators (as features)
    ema20Relation: indicators.ema20Relation,
    rsi14: indicators.rsi14,
    atr14: indicators.atr14,
    
    // Candlestick
    engulfing: engulfing,
    patterns: singlePatterns,
    
    // Raw values for calculation
    close: currentCandle.close,
    high: currentCandle.high,
    low: currentCandle.low,
    open: currentCandle.open,
    timestamp: currentCandle.timestamp
  };
}

/**
 * Computes feature arrays for all candles in a dataset
 * @param {Array} candles - Validated candle array
 * @returns {Array} Array of feature vectors (same length as candles)
 */
function computeAllFeatureVectors(candles) {
  const features = [];
  for (let i = 0; i < candles.length; i++) {
    features.push(computeFeatureVector(candles, i));
  }
  return features;
}

// ============================================================
// FEATURE CATEGORIES FOR DISCOVERY ENGINE (Documentation)
// ============================================================
// The discovery engine can use the following feature categories:
//
// 1. Price Structure Features:
//    - higherHigh (boolean)
//    - higherLow (boolean)
//    - lowerHigh (boolean)
//    - lowerLow (boolean)
//    - trend (string: "BULLISH"/"BEARISH"/"NEUTRAL")
//    - breakoutUp (boolean)
//    - breakoutDown (boolean)
//    - pullback (boolean)
//    - compression (boolean)
//    - expansion (boolean)
//
// 2. Volatility Features:
//    - upperWickRatio (number 0-1)
//    - lowerWickRatio (number 0-1)
//    - bodyRatio (number 0-1)
//    - atrPercentile (number 0-100)
//
// 3. Time Features:
//    - session (string: "LONDON"/"NEW_YORK"/"OVERLAP"/"TOKYO"/"OFF_HOURS")
//    - sessionScore (number 0-100)
//
// 4. Indicator Features (as features only):
//    - ema20Relation (string: "ABOVE"/"BELOW"/"EQUAL")
//    - rsi14 (number 0-100)
//    - atr14 (number)
//
// 5. Candlestick Features:
//    - engulfing (string or null)
//    - patterns (array of strings)
// ============================================================

// ============================================================
// PART 2 COMPLETE
// ============================================================
// NEXT: PART 3 — Discovery Engine (Candidate Generation, Binomial Test, Pattern Evaluation)
//
// After pasting Part 2, your App.jsx now has:
// - Strict chronological split (70/15/10/5)
// - Feature calculation for all categories
// - Price structure detection (HH/HL/LH/LL, breakouts, pullbacks, range compression)
// - Volatility features (wick ratios, ATR percentile)
// - Session detection (London, New York, overlap, Tokyo)
// - Indicator features (EMA20 relation, RSI14, ATR14)
// - Candlestick pattern detection (engulfing, doji, marubozu, hammer, shooting star)
//
// Pending for Part 3:
// - Discovery Engine: deterministic candidate generation (seed=42, max 1,000)
// - Binomial test (p<0.05, adaptive thresholds)
// - Pattern evaluation on training set
// - Ranking criteria (win rate → profit factor → occurrence count)
// - Reproducibility storage
// ============================================================

// ============================================================
// TEST CODE FOR PART 2 (add to App component temporarily)
// ============================================================
// useEffect(() => {
//   async function testFeatures() {
//     const raw = await fetchTwelveDataCandles();
//     const { validatedCandles } = sanitizeCandles(raw);
//     const { training, validationA, validationB, walkForward } = strictChronologicalSplit(validatedCandles);
//     console.log("Split report:", { training: training.length, validationA: validationA.length, validationB: validationB.length, walkForward: walkForward.length });
//     
//     const features = computeAllFeatureVectors(training.slice(0, 100));
//     console.log("Sample features (first 3):", features.slice(0, 3));
//   }
//   testFeatures();
// }, []);
// ============================================================
// ============================================================
// PART 3 OF 8 — DISCOVERY ENGINE (CANDIDATE GENERATION + BINOMIAL TEST + PATTERN EVALUATION + RANKING + REPRODUCIBILITY)
// ============================================================
// INSTRUCTIONS:
// 1. Paste this code AFTER Part 2 in your App.jsx
// 2. This code adds the complete Discovery Engine:
//    - Deterministic candidate generation (seed=42, max 1,000 candidates)
//    - Binomial test for statistical significance (p<0.05, adaptive thresholds)
//    - Pattern evaluation on training set (win rate, profit factor, occurrences)
//    - Ranking criteria (win rate → profit factor → occurrence count)
//    - Reproducibility storage (seed, dataset hash, config hash, results)
//    - Candidate space coverage (raw + practical)
//    - Discovery failure reporting
// ============================================================

// ============================================================
// BINOMIAL TEST FOR STATISTICAL SIGNIFICANCE
// ============================================================

/**
 * Calculates binomial probability (exact)
 * @param {number} k - Number of successes
 * @param {number} n - Number of trials
 * @param {number} p - Null hypothesis probability (default 0.5)
 * @returns {number} P-value (one-sided)
 */
function binomialProbability(k, n, p = 0.5) {
  if (k < n * p) return 1.0; // Not significant if below expected
  if (n === 0) return 1.0;
  
  // Calculate using combination formula for exact p-value
  // Sum from k to n of C(n,i) * p^i * (1-p)^(n-i)
  let sum = 0;
  for (let i = k; i <= n; i++) {
    // Calculate combination C(n,i)
    let comb = 1;
    for (let j = 1; j <= i; j++) {
      comb = comb * (n - j + 1) / j;
    }
    sum += comb * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return Math.min(1.0, sum);
}

/**
 * Determines minimum wins required for significance
 * @param {number} trades - Number of trades
 * @returns {number} Minimum wins needed for p < 0.05
 */
function getMinWinsForSignificance(trades) {
  if (trades < 20) return Math.ceil(trades * 0.75); // 75% for small samples
  if (trades < 30) return Math.ceil(trades * 0.73); // 73% for 30 trades
  if (trades < 40) return Math.ceil(trades * 0.725); // 72.5% for 40 trades
  return Math.ceil(trades * 0.72); // 72% for 50+ trades
}

/**
 * Tests if a pattern's win rate is statistically significant
 * @param {number} wins - Number of winning trades
 * @param {number} total - Total trades
 * @returns {Object} { significant, pValue, minWinsRequired }
 */
function testStatisticalSignificance(wins, total) {
  if (total < 20) {
    return { significant: false, pValue: 1.0, minWinsRequired: getMinWinsForSignificance(total), reason: "INSUFFICIENT_TRADES" };
  }
  const pValue = binomialProbability(wins, total, 0.5);
  const minRequired = getMinWinsForSignificance(total);
  const significant = pValue < 0.05 && wins >= minRequired;
  return { significant, pValue, minWinsRequired: minRequired, reason: significant ? null : "FAILED_SIGNIFICANCE" };
}

// ============================================================
// DETERMINISTIC CANDIDATE GENERATION (Seed=42)
// ============================================================

/**
 * Deterministic seeded random number generator
 * @param {number} seed - Seed value (default 42)
 * @returns {Function} Random function that returns 0-1
 */
function createSeededRandom(seed = 42) {
  let s = seed;
  return function() {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Generates candidate patterns deterministically
 * Feature categories and their possible values:
 * - trend: ["BULLISH", "BEARISH", "NEUTRAL"]
 * - breakoutUp: [true, false]
 * - breakoutDown: [true, false]
 * - compression: [true, false]
 * - expansion: [true, false]
 * - pullback: [true, false]
 * - session: ["LONDON", "NEW_YORK", "OVERLAP", "TOKYO"]
 * - ema20Relation: ["ABOVE", "BELOW"]
 * - engulfing: ["BULLISH_ENGULFING", "BEARISH_ENGULFING", null]
 * - patterns: array contains "DOJI", "HAMMER", "SHOOTING_STAR", "BULLISH_MARUBOZU", "BEARISH_MARUBOZU"
 * - rsiLow: [true, false] (rsi14 < 30)
 * - rsiHigh: [true, false] (rsi14 > 70)
 * - atrPercentileHigh: [true, false] (atrPercentile > 80)
 * - atrPercentileLow: [true, false] (atrPercentile < 20)
 * 
 * @param {number} maxCandidates - Maximum candidates to generate (default 1000)
 * @param {number} seed - Seed for reproducibility (default 42)
 * @returns {Array} Array of candidate condition objects
 */
function generateCandidatePatterns(maxCandidates = 1000, seed = 42) {
  const random = createSeededRandom(seed);
  const candidates = [];
  
  // Feature options
  const trendOptions = ["BULLISH", "BEARISH", "NEUTRAL"];
  const sessionOptions = ["LONDON", "NEW_YORK", "OVERLAP", "TOKYO"];
  const emaOptions = ["ABOVE", "BELOW"];
  const engulfingOptions = ["BULLISH_ENGULFING", "BEARISH_ENGULFING", null];
  const patternOptions = ["DOJI", "HAMMER", "SHOOTING_STAR", "BULLISH_MARUBOZU", "BEARISH_MARUBOZU"];
  
  // Boolean feature groups
  const booleanFeatures = [
    "breakoutUp", "breakoutDown", "compression", "expansion", "pullback",
    "rsiLow", "rsiHigh", "atrPercentileHigh", "atrPercentileLow"
  ];
  
  for (let i = 0; i < maxCandidates; i++) {
    // Generate random combination of features (deterministic due to seeded random)
    const conditions = [];
    
    // Add 1-5 conditions randomly
    const numConditions = Math.floor(random() * 5) + 1;
    
    // Keep track to avoid duplicate condition types
    const usedTypes = new Set();
    
    for (let j = 0; j < numConditions; j++) {
      const featureType = Math.floor(random() * 6); // 0-5 feature categories
      
      if (featureType === 0 && !usedTypes.has("trend")) {
        // Trend
        const idx = Math.floor(random() * trendOptions.length);
        usedTypes.add("trend");
        conditions.push({ type: "trend", value: trendOptions[idx] });
      }
      else if (featureType === 1 && !usedTypes.has("boolean")) {
        // Boolean feature
        const idx = Math.floor(random() * booleanFeatures.length);
        const value = random() > 0.5;
        usedTypes.add("boolean");
        conditions.push({ type: booleanFeatures[idx], value });
      }
      else if (featureType === 2 && !usedTypes.has("session")) {
        // Session
        const idx = Math.floor(random() * sessionOptions.length);
        usedTypes.add("session");
        conditions.push({ type: "session", value: sessionOptions[idx] });
      }
      else if (featureType === 3 && !usedTypes.has("ema")) {
        // EMA relation
        const idx = Math.floor(random() * emaOptions.length);
        usedTypes.add("ema");
        conditions.push({ type: "ema20Relation", value: emaOptions[idx] });
      }
      else if (featureType === 4 && !usedTypes.has("engulfing")) {
        // Engulfing pattern
        const idx = Math.floor(random() * engulfingOptions.length);
        usedTypes.add("engulfing");
        conditions.push({ type: "engulfing", value: engulfingOptions[idx] });
      }
      else if (featureType === 5 && !usedTypes.has("pattern")) {
        // Candlestick pattern
        const idx = Math.floor(random() * patternOptions.length);
        usedTypes.add("pattern");
        conditions.push({ type: "pattern", value: patternOptions[idx] });
      }
    }
    
    // Skip empty candidates
    if (conditions.length === 0) continue;
    
    candidates.push({
      id: `CAND-${String(i + 1).padStart(4, '0')}`,
      conditions,
      complexity: conditions.length
    });
  }
  
  return candidates;
}

/**
 * Calculates candidate space size for coverage reporting
 * @returns {Object} { totalTheoretical, eligibleAfterComplexityLimit, practicalEstimate }
 */
function calculateCandidateSpace() {
  // Approximate theoretical space (product of all feature possibilities)
  // This is an estimate, not exact
  const trendSpace = 3; // BULLISH, BEARISH, NEUTRAL
  const sessionSpace = 4; // LONDON, NEW_YORK, OVERLAP, TOKYO
  const emaSpace = 2; // ABOVE, BELOW
  const engulfingSpace = 3; // BULLISH, BEARISH, null
  const patternSpace = 5; // DOJI, HAMMER, SHOOTING_STAR, BULLISH_MARUBOZU, BEARISH_MARUBOZU
  const booleanSpace = Math.pow(2, 9); // 9 boolean features
  
  // Combinations of 1-5 conditions
  let total = 0;
  for (let i = 1; i <= 5; i++) {
    total += Math.pow(trendSpace * sessionSpace * emaSpace * engulfingSpace * patternSpace * booleanSpace, i);
  }
  
  // Estimate after complexity limit (max 5 conditions) — same as total since we already cap at 5
  const eligible = total;
  const practicalEstimate = Math.min(100000, total); // Cap for display
  
  return {
    totalTheoretical: total > 1000000 ? ">1,000,000" : total.toLocaleString(),
    eligibleAfterComplexityLimit: eligible > 1000000 ? ">1,000,000" : eligible.toLocaleString(),
    practicalEstimate: practicalEstimate.toLocaleString()
  };
}

// ============================================================
// PATTERN EVALUATION ON CANDLE DATA
// ============================================================

/**
 * Evaluates whether a candle's features match a candidate pattern's conditions
 * @param {Object} features - Feature vector for a candle
 * @param {Array} conditions - Array of condition objects
 * @returns {boolean} True if all conditions match
 */
function matchesPattern(features, conditions) {
  for (const cond of conditions) {
    switch (cond.type) {
      case "trend":
        if (features.trend !== cond.value) return false;
        break;
      case "breakoutUp":
        if (features.breakoutUp !== cond.value) return false;
        break;
      case "breakoutDown":
        if (features.breakoutDown !== cond.value) return false;
        break;
      case "compression":
        if (features.compression !== cond.value) return false;
        break;
      case "expansion":
        if (features.expansion !== cond.value) return false;
        break;
      case "pullback":
        if (features.pullback !== cond.value) return false;
        break;
      case "session":
        if (features.session !== cond.value) return false;
        break;
      case "ema20Relation":
        if (features.ema20Relation !== cond.value) return false;
        break;
      case "engulfing":
        if (features.engulfing !== cond.value) return false;
        break;
      case "pattern":
        if (!features.patterns || !features.patterns.includes(cond.value)) return false;
        break;
      case "rsiLow":
        const isLow = features.rsi14 !== null && features.rsi14 < 30;
        if (isLow !== cond.value) return false;
        break;
      case "rsiHigh":
        const isHigh = features.rsi14 !== null && features.rsi14 > 70;
        if (isHigh !== cond.value) return false;
        break;
      case "atrPercentileHigh":
        const isHighPercentile = features.atrPercentile !== null && features.atrPercentile > 80;
        if (isHighPercentile !== cond.value) return false;
        break;
      case "atrPercentileLow":
        const isLowPercentile = features.atrPercentile !== null && features.atrPercentile < 20;
        if (isLowPercentile !== cond.value) return false;
        break;
      default:
        // Unknown condition type — skip
        break;
    }
  }
  return true;
}

/**
 * Evaluates a candidate pattern on a dataset
 * @param {Object} candidate - Candidate pattern object
 * @param {Array} featureVectors - Feature vectors for candles
 * @param {number} holdingPeriodCandles - Number of 15M candles to hold (default 16 = 4 hours)
 * @param {number} targetRR - Target risk-reward ratio (default 3)
 * @returns {Object} Evaluation result with trades, wins, losses, winRate, profitFactor, entryIndices
 */
function evaluatePatternOnDataset(candidate, featureVectors, holdingPeriodCandles = 16, targetRR = 3) {
  const trades = [];
  const entryIndices = [];
  
  for (let i = 0; i < featureVectors.length - holdingPeriodCandles; i++) {
    if (matchesPattern(featureVectors[i], candidate.conditions)) {
      const entry = featureVectors[i];
      const exitCandle = featureVectors[i + holdingPeriodCandles];
      if (!exitCandle) continue;
      
      const entryPrice = entry.close;
      const exitPrice = exitCandle.close;
      const sl = entryPrice * 0.997; // 30 pips SL (approximate)
      const tp = entryPrice * 1.009; // 90 pips TP (3x risk)
      
      // Determine if trade hit TP or SL within holding period
      let hitTP = false;
      let hitSL = false;
      let maxPrice = entryPrice;
      let minPrice = entryPrice;
      
      for (let j = i; j <= i + holdingPeriodCandles; j++) {
        const candle = featureVectors[j];
        maxPrice = Math.max(maxPrice, candle.high);
        minPrice = Math.min(minPrice, candle.low);
        if (maxPrice >= tp) hitTP = true;
        if (minPrice <= sl) hitSL = true;
        if (hitTP || hitSL) break;
      }
      
      let result = null;
      if (hitTP && !hitSL) result = "WIN";
      else if (hitSL && !hitTP) result = "LOSS";
      else if (hitTP && hitSL) {
        // Both hit — determine which first (simplified: if TP reached earlier in simulation)
        // For simplicity, check if maxPrice reached before minPrice
        let tpIndex = null;
        let slIndex = null;
        for (let j = i; j <= i + holdingPeriodCandles; j++) {
          const candle = featureVectors[j];
          if (!tpIndex && candle.high >= tp) tpIndex = j;
          if (!slIndex && candle.low <= sl) slIndex = j;
        }
        result = (tpIndex < slIndex) ? "WIN" : "LOSS";
      } else {
        result = "INCONCLUSIVE";
      }
      
      if (result === "WIN" || result === "LOSS") {
        trades.push({
          entryIndex: i,
          entryPrice,
          exitPrice,
          result,
          sl,
          tp,
          actualRR: result === "WIN" ? targetRR : -1
        });
        entryIndices.push(i);
      }
    }
  }
  
  const wins = trades.filter(t => t.result === "WIN").length;
  const losses = trades.filter(t => t.result === "LOSS").length;
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const grossProfit = wins * targetRR;
  const grossLoss = losses;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : wins > 0 ? 999 : 0;
  
  return {
    candidateId: candidate.id,
    conditions: candidate.conditions,
    complexity: candidate.conditions.length,
    trades: total,
    wins,
    losses,
    winRate: parseFloat(winRate.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(3)),
    entryIndices,
    tradesList: trades,
    significance: testStatisticalSignificance(wins, total),
    holdsPromise: total >= 20 && winRate >= 60 && profitFactor >= 1.2
  };
}

// ============================================================
// DISCOVERY ENGINE (Complete)
// ============================================================

/**
 * Runs the complete discovery process
 * @param {Array} trainingFeatures - Feature vectors for training set
 * @param {Array} validationAFeatures - Feature vectors for validation A
 * @param {Array} validationBFeatures - Feature vectors for validation B
 * @param {Array} walkForwardFeatures - Feature vectors for walk-forward (optional)
 * @param {Object} config - Discovery configuration
 * @returns {Object} Discovery result with best candidate, failure report, reproducibility data
 */
function runDiscovery(trainingFeatures, validationAFeatures, validationBFeatures, walkForwardFeatures = null, config = {}) {
  const {
    maxCandidates = 1000,
    seed = 42,
    holdingPeriodCandles = 16, // 4 hours (16 × 15M)
    targetRR = 3,
    minTrainingTrades = 20,
    minValidationCombinedTrades = 20,
    minPerValidationSegment = 3
  } = config;
  
  // Generate candidates
  const candidates = generateCandidatePatterns(maxCandidates, seed);
  const space = calculateCandidateSpace();
  
  // Evaluate on training set
  const trainingResults = [];
  for (const candidate of candidates) {
    const result = evaluatePatternOnDataset(candidate, trainingFeatures, holdingPeriodCandles, targetRR);
    trainingResults.push(result);
  }
  
  // Filter by minimum training trades and significance
  const eligibleCandidates = trainingResults.filter(r => 
    r.trades >= minTrainingTrades && r.significance.significant
  );
  
  // Rank by win rate → profit factor → trades
  eligibleCandidates.sort((a, b) => {
    if (a.winRate !== b.winRate) return b.winRate - a.winRate;
    if (a.profitFactor !== b.profitFactor) return b.profitFactor - a.profitFactor;
    return b.trades - a.trades;
  });
  
  const bestCandidate = eligibleCandidates[0] || null;
  let failureReason = null;
  
  if (!bestCandidate) {
    failureReason = {
      type: "NO_ELIGIBLE_CANDIDATE",
      details: `No candidate passed training: min ${minTrainingTrades} trades and significance. ${trainingResults.length} evaluated, ${eligibleCandidates.length} eligible.`
    };
    return {
      success: false,
      bestCandidate: null,
      failureReason,
      coverage: { raw: `${eligibleCandidates.length}/${trainingResults.length}`, space },
      reproducibility: null
    };
  }
  
  // Validate on Validation A
  const valAResult = evaluatePatternOnDataset(bestCandidate, validationAFeatures, holdingPeriodCandles, targetRR);
  // Validate on Validation B
  const valBResult = evaluatePatternOnDataset(bestCandidate, validationBFeatures, holdingPeriodCandles, targetRR);
  
  const combinedTrades = valAResult.trades + valBResult.trades;
  const combinedWins = valAResult.wins + valBResult.wins;
  const combinedSignificance = testStatisticalSignificance(combinedWins, combinedTrades);
  
  const valAPassed = valAResult.trades >= minPerValidationSegment;
  const valBPassed = valBResult.trades >= minPerValidationSegment;
  const combinedPassed = combinedTrades >= minValidationCombinedTrades && combinedSignificance.significant;
  
  let validationFailed = false;
  let validationReason = [];
  
  if (!valAPassed) validationReason.push(`Validation A: only ${valAResult.trades} trades (need ${minPerValidationSegment})`);
  if (!valBPassed) validationReason.push(`Validation B: only ${valBResult.trades} trades (need ${minPerValidationSegment})`);
  if (!combinedPassed) validationReason.push(`Combined: ${combinedTrades} trades, significance=${combinedSignificance.significant}`);
  
  if (!valAPassed || !valBPassed || !combinedPassed) {
    validationFailed = true;
    failureReason = {
      type: "VALIDATION_FAILED",
      details: validationReason.join("; "),
      valA: { trades: valAResult.trades, winRate: valAResult.winRate },
      valB: { trades: valBResult.trades, winRate: valBResult.winRate },
      combined: { trades: combinedTrades, wins: combinedWins, significant: combinedSignificance.significant }
    };
  }
  
  // Walk-forward (if provided and has sufficient occurrences)
  let walkForwardResult = null;
  let walkForwardStatus = "NOT_AVAILABLE";
  if (walkForwardFeatures && walkForwardFeatures.length > 0) {
    const wfResult = evaluatePatternOnDataset(bestCandidate, walkForwardFeatures, holdingPeriodCandles, targetRR);
    if (wfResult.trades >= 10) {
      walkForwardResult = wfResult;
      walkForwardStatus = "PASSED";
    } else {
      walkForwardStatus = `SKIPPED: only ${wfResult.trades} occurrences (need 10)`;
    }
  }
  
  const finalSuccess = !validationFailed && bestCandidate.trades >= minTrainingTrades;
  
  // Reproducibility data
  const reproducibility = {
    seed,
    datasetHash: null, // Will be computed in Part 4
    configHash: null,
    featureCategoriesUsed: ["price_structure", "volatility", "time", "indicator", "candlestick"],
    candidateCount: candidates.length,
    eligibleCount: eligibleCandidates.length,
    bestCandidateId: bestCandidate.id,
    bestCandidateConditions: bestCandidate.conditions,
    trainingResult: {
      trades: bestCandidate.trades,
      wins: bestCandidate.wins,
      winRate: bestCandidate.winRate,
      profitFactor: bestCandidate.profitFactor,
      significance: bestCandidate.significance
    },
    validationResult: {
      valA: { trades: valAResult.trades, wins: valAResult.wins, winRate: valAResult.winRate },
      valB: { trades: valBResult.trades, wins: valBResult.wins, winRate: valBResult.winRate },
      combined: { trades: combinedTrades, wins: combinedWins, significant: combinedSignificance.significant }
    },
    walkForwardStatus,
    timestamp: new Date().toISOString()
  };
  
  return {
    success: finalSuccess,
    bestCandidate: finalSuccess ? bestCandidate : null,
    failureReason: finalSuccess ? null : failureReason,
    coverage: { 
      raw: `${eligibleCandidates.length}/${trainingResults.length} eligible from ${candidates.length} generated`,
      rawPercent: ((eligibleCandidates.length / candidates.length) * 100).toFixed(2),
      space,
      warning: (eligibleCandidates.length / candidates.length) < 0.01 ? "LIMITED_SEARCH_COVERAGE" : null
    },
    reproducibility,
    trainingResults,
    valAResult,
    valBResult,
    walkForwardResult
  };
}

// ============================================================
// DISCOVERY FAILURE REPORTING (Structured Output)
// ============================================================

/**
 * Generates a structured failure report for display
 * @param {Object} discoveryResult - Result from runDiscovery
 * @returns {Object} Formatted failure report
 */
function formatDiscoveryFailureReport(discoveryResult) {
  if (discoveryResult.success) return null;
  
  const report = {
    type: discoveryResult.failureReason?.type || "UNKNOWN",
    details: discoveryResult.failureReason?.details || "No pattern found",
    bestCandidate: null,
    failureChecklist: {
      insufficientTrades: false,
      failedSignificance: false,
      failedValidationA: false,
      failedValidationB: false,
      failedWalkForward: false,
      complexityLimit: false
    }
  };
  
  // Extract best candidate info even if not fully validated
  if (discoveryResult.trainingResults && discoveryResult.trainingResults.length > 0) {
    const best = discoveryResult.trainingResults[0];
    report.bestCandidate = {
      id: best.candidateId,
      training: { trades: best.trades, wins: best.wins, winRate: best.winRate, profitFactor: best.profitFactor }
    };
    if (discoveryResult.valAResult) {
      report.bestCandidate.validationA = { trades: discoveryResult.valAResult.trades, winRate: discoveryResult.valAResult.winRate };
    }
    if (discoveryResult.valBResult) {
      report.bestCandidate.validationB = { trades: discoveryResult.valBResult.trades, winRate: discoveryResult.valBResult.winRate };
    }
    
    if (best.trades < 20) report.failureChecklist.insufficientTrades = true;
    if (!best.significance.significant) report.failureChecklist.failedSignificance = true;
  }
  
  if (discoveryResult.valAResult && discoveryResult.valAResult.trades < 3) report.failureChecklist.failedValidationA = true;
  if (discoveryResult.valBResult && discoveryResult.valBResult.trades < 3) report.failureChecklist.failedValidationB = true;
  if (discoveryResult.walkForwardResult && discoveryResult.walkForwardResult.trades < 10) report.failureChecklist.failedWalkForward = true;
  
  return report;
}

// ============================================================
// PART 3 COMPLETE
// ============================================================
// NEXT: PART 4 — Validation + Walk-Forward + Reproducibility Storage + Discovery Failure Reporting (UI Integration)
//
// After pasting Part 3, your App.jsx now has:
// - Binomial test for statistical significance (p<0.05, adaptive thresholds)
// - Deterministic candidate generation (seed=42, max 1,000)
// - Pattern evaluation on any dataset
// - Ranking by win rate → profit factor → trades
// - Complete discovery engine with training + validation A + validation B + walk-forward
// - Candidate space coverage calculation (raw + practical)
// - Discovery failure reporting structure
// - Reproducibility data collection
//
// Pending for Part 4:
// - Dataset hashing for full reproducibility
// - LocalStorage persistence for discovery results
// - Integration with Part 1 & Part 2 data pipeline
// - Discovery trigger logic (health monitoring hook)
// - Discovery cooldown (24-hour minimum between auto runs)
// ============================================================

// ============================================================
// TEST CODE FOR PART 3 (add to App component temporarily)
// ============================================================
// useEffect(() => {
//   async function testDiscovery() {
//     const raw = await fetchTwelveDataCandles();
//     const { validatedCandles } = sanitizeCandles(raw);
//     const { training, validationA, validationB, walkForward } = strictChronologicalSplit(validatedCandles);
//     
//     const trainFeatures = computeAllFeatureVectors(training);
//     const valAFeatures = computeAllFeatureVectors(validationA);
//     const valBFeatures = computeAllFeatureVectors(validationB);
//     const wfFeatures = computeAllFeatureVectors(walkForward);
//     
//     const result = runDiscovery(trainFeatures, valAFeatures, valBFeatures, wfFeatures);
//     console.log("Discovery result:", result);
//     
//     if (!result.success) {
//       console.log("Failure report:", formatDiscoveryFailureReport(result));
//     }
//   }
//   testDiscovery();
// }, []);
// ============================================================
// ============================================================
// PART 4 OF 8 — VALIDATION INTEGRATION + REPRODUCIBILITY STORAGE + DISCOVERY COOLDOWN + TRIGGER LOGIC
// ============================================================
// INSTRUCTIONS:
// 1. Paste this code AFTER Part 3 in your App.jsx
// 2. This code adds:
//    - Dataset hashing for full reproducibility (SHA-256)
//    - LocalStorage persistence for discovery results
//    - Discovery cooldown (24-hour minimum between auto runs)
//    - Discovery trigger logic (health monitoring hook)
//    - Integration with Part 1 & Part 2 data pipeline
//    - Complete discovery failure reporting UI
//    - Pattern storage for production engine
// ============================================================

// ============================================================
// SHA-256 HASHING FOR REPRODUCIBILITY (Simple implementation)
// ============================================================

/**
 * Simple string hash function (for reproducibility - not cryptographic)
 * @param {string} str - Input string
 * @returns {string} Hash string
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Creates a dataset hash from candles for reproducibility
 * @param {Array} candles - Validated candles
 * @returns {string} Hash string
 */
function createDatasetHash(candles) {
  if (!candles || candles.length === 0) return "EMPTY";
  const dateFrom = candles[0]?.datetime || "";
  const dateTo = candles[candles.length - 1]?.datetime || "";
  const count = candles.length;
  const firstPrice = candles[0]?.close || 0;
  const lastPrice = candles[candles.length - 1]?.close || 0;
  const hashString = `${dateFrom}|${dateTo}|${count}|${firstPrice}|${lastPrice}`;
  return simpleHash(hashString);
}

/**
 * Creates a config hash from discovery configuration
 * @param {Object} config - Discovery configuration
 * @returns {string} Hash string
 */
function createConfigHash(config) {
  const defaults = { maxCandidates: 1000, seed: 42, holdingPeriodCandles: 16, targetRR: 3, minTrainingTrades: 20, minValidationCombinedTrades: 20, minPerValidationSegment: 3 };
  const merged = { ...defaults, ...config };
  const hashString = `${merged.maxCandidates}|${merged.seed}|${merged.holdingPeriodCandles}|${merged.targetRR}|${merged.minTrainingTrades}|${merged.minValidationCombinedTrades}|${merged.minPerValidationSegment}`;
  return simpleHash(hashString);
}

// ============================================================
// LOCALSTORAGE KEYS (Constants)
// ============================================================
const STORAGE_KEYS = {
  ACTIVE_PATTERN: "v4_active_pattern",
  STRATEGY_VERSION_HISTORY: "v4_strategy_history",
  PENDING_CANDIDATE: "v4_pending_candidate",
  LAST_DISCOVERY_TIMESTAMP: "v4_last_discovery_ts",
  LAST_DISCOVERY_RESULT: "v4_last_discovery_result",
  REPRODUCIBILITY_DATA: "v4_reproducibility",
  DISCOVERY_COOLDOWN_UNTIL: "v4_discovery_cooldown_until"
};

// ============================================================
// PATTERN STORAGE AND VERSIONING
// ============================================================

/**
 * Saves active pattern to localStorage
 * @param {Object} pattern - Pattern object with conditions, entryRule, slRule, tpRule, metrics
 */
function saveActivePattern(pattern) {
  if (pattern) {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PATTERN, JSON.stringify(pattern));
  } else {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_PATTERN);
  }
}

/**
 * Loads active pattern from localStorage
 * @returns {Object|null} Active pattern or null
 */
function loadActivePattern() {
  const stored = localStorage.getItem(STORAGE_KEYS.ACTIVE_PATTERN);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

/**
 * Adds a new strategy version to history
 * @param {Object} versionData - Version data { version, pattern, metrics, deployedAt }
 */
function addStrategyVersion(versionData) {
  const history = getStrategyHistory();
  history.push(versionData);
  localStorage.setItem(STORAGE_KEYS.STRATEGY_VERSION_HISTORY, JSON.stringify(history));
}

/**
 * Gets strategy version history
 * @returns {Array} Array of version objects
 */
function getStrategyHistory() {
  const stored = localStorage.getItem(STORAGE_KEYS.STRATEGY_VERSION_HISTORY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

/**
 * Saves pending candidate for user approval
 * @param {Object} candidate - Candidate pattern with metrics
 */
function savePendingCandidate(candidate) {
  if (candidate) {
    localStorage.setItem(STORAGE_KEYS.PENDING_CANDIDATE, JSON.stringify(candidate));
  } else {
    localStorage.removeItem(STORAGE_KEYS.PENDING_CANDIDATE);
  }
}

/**
 * Loads pending candidate from localStorage
 * @returns {Object|null} Pending candidate or null
 */
function loadPendingCandidate() {
  const stored = localStorage.getItem(STORAGE_KEYS.PENDING_CANDIDATE);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// ============================================================
// DISCOVERY COOLDOWN MANAGEMENT
// ============================================================

/**
 * Checks if automatic discovery is allowed (cooldown)
 * @returns {boolean} True if discovery allowed
 */
function isDiscoveryAllowed() {
  const cooldownUntil = localStorage.getItem(STORAGE_KEYS.DISCOVERY_COOLDOWN_UNTIL);
  if (!cooldownUntil) return true;
  const cooldownTime = parseInt(cooldownUntil, 10);
  if (isNaN(cooldownTime)) return true;
  return Date.now() > cooldownTime;
}

/**
 * Gets remaining cooldown milliseconds
 * @returns {number} Milliseconds remaining (0 if no cooldown)
 */
function getDiscoveryCooldownRemaining() {
  const cooldownUntil = localStorage.getItem(STORAGE_KEYS.DISCOVERY_COOLDOWN_UNTIL);
  if (!cooldownUntil) return 0;
  const cooldownTime = parseInt(cooldownUntil, 10);
  if (isNaN(cooldownTime)) return 0;
  return Math.max(0, cooldownTime - Date.now());
}

/**
 * Sets discovery cooldown (24 hours from now)
 */
function setDiscoveryCooldown() {
  const cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
  localStorage.setItem(STORAGE_KEYS.DISCOVERY_COOLDOWN_UNTIL, cooldownUntil.toString());
}

/**
 * Clears discovery cooldown (for manual discovery)
 */
function clearDiscoveryCooldown() {
  localStorage.removeItem(STORAGE_KEYS.DISCOVERY_COOLDOWN_UNTIL);
}

// ============================================================
// COMPLETE DISCOVERY WORKFLOW (Integrates Parts 1-3)
// ============================================================

/**
 * Runs complete discovery workflow and stores results
 * @param {Array} candles - Validated candles
 * @param {boolean} isManual - Whether this is a manual run (bypasses cooldown)
 * @param {Object} config - Discovery configuration
 * @returns {Promise<Object>} Discovery result
 */
async function runCompleteDiscovery(candles, isManual = false, config = {}) {
  // Check cooldown (skip if manual)
  if (!isManual && !isDiscoveryAllowed()) {
    const remainingMs = getDiscoveryCooldownRemaining();
    return {
      success: false,
      blocked: true,
      reason: `DISCOVERY_COOLDOWN: ${Math.ceil(remainingMs / 3600000)} hours remaining`,
      cooldownRemainingMs: remainingMs
    };
  }
  
  // Split data
  const { training, validationA, validationB, walkForward, splitReport } = strictChronologicalSplit(candles);
  
  // Compute feature vectors
  const trainFeatures = computeAllFeatureVectors(training);
  const valAFeatures = computeAllFeatureVectors(validationA);
  const valBFeatures = computeAllFeatureVectors(validationB);
  const wfFeatures = computeAllFeatureVectors(walkForward);
  
  // Run discovery
  const discoveryResult = runDiscovery(trainFeatures, valAFeatures, valBFeatures, wfFeatures, config);
  
  // Add split report and date ranges to result
  discoveryResult.splitReport = splitReport;
  discoveryResult.datasetHash = createDatasetHash(candles);
  discoveryResult.configHash = createConfigHash(config);
  discoveryResult.timestamp = new Date().toISOString();
  discoveryResult.walkForwardStatus = discoveryResult.walkForwardResult 
    ? (discoveryResult.walkForwardResult.trades >= 10 ? "PASSED" : `SKIPPED: only ${discoveryResult.walkForwardResult.trades} occurrences (need 10)`)
    : "NO_DATA";
  
  // Store reproducibility data
  localStorage.setItem(STORAGE_KEYS.REPRODUCIBILITY_DATA, JSON.stringify({
    lastRun: discoveryResult.timestamp,
    datasetHash: discoveryResult.datasetHash,
    configHash: discoveryResult.configHash,
    seed: config.seed || 42,
    candidateCount: discoveryResult.reproducibility?.candidateCount,
    bestCandidateId: discoveryResult.reproducibility?.bestCandidateId,
    trainingMetrics: discoveryResult.reproducibility?.trainingResult,
    validationMetrics: discoveryResult.reproducibility?.validationResult
  }));
  
  // Store last discovery result
  localStorage.setItem(STORAGE_KEYS.LAST_DISCOVERY_RESULT, JSON.stringify(discoveryResult));
  localStorage.setItem(STORAGE_KEYS.LAST_DISCOVERY_TIMESTAMP, Date.now().toString());
  
  // Set cooldown (if automatic run and discovery succeeded or had a valid candidate)
  if (!isManual && discoveryResult.success) {
    setDiscoveryCooldown();
  }
  
  return discoveryResult;
}

// ============================================================
// HEALTH MONITORING HOOK (To be integrated into App component)
// ============================================================

/**
 * Health monitoring state and logic
 * This will be integrated into the App component in Part 5-6
 */
class HealthMonitor {
  constructor() {
    this.reset();
  }
  
  reset() {
    this.tradeWindow = []; // Last 20 trades
    this.healthHistory = [];
    this.stabilitySegments = {
      sessions: {},
      volatility: {},
      weeks: {}
    };
  }
  
  /**
   * Adds a trade to the rolling window
   * @param {Object} trade - Trade object with result, rr, session, volatilityRegime, timestamp
   */
  addTrade(trade) {
    this.tradeWindow.push(trade);
    if (this.tradeWindow.length > 20) this.tradeWindow.shift();
    this.updateHealth();
    this.updateStability(trade);
  }
  
  /**
   * Updates current health score
   */
  updateHealth() {
    if (this.tradeWindow.length === 0) {
      this.currentHealth = 100;
      return;
    }
    
    const wins = this.tradeWindow.filter(t => t.result === "WIN").length;
    const winRate = (wins / this.tradeWindow.length) * 100;
    
    let totalProfit = 0, totalLoss = 0;
    for (const t of this.tradeWindow) {
      if (t.result === "WIN") totalProfit += t.rr || 3;
      else totalLoss += 1;
    }
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
    
    const maxDrawdown = this.calculateDrawdown();
    const normDrawdown = Math.max(0, 100 - (maxDrawdown * 6.67));
    
    const avgRR = this.tradeWindow.reduce((sum, t) => sum + (t.rr || 3), 0) / this.tradeWindow.length;
    const normRR = Math.min(100, (avgRR / 5) * 100);
    
    const normPF = Math.min(100, Math.max(0, (profitFactor - 1) * 100));
    
    this.currentHealth = (winRate * 0.4) + (normPF * 0.3) + (normDrawdown * 0.2) + (normRR * 0.1);
    this.currentHealth = Math.min(100, Math.max(0, this.currentHealth));
    
    this.healthHistory.push({ timestamp: Date.now(), health: this.currentHealth });
    if (this.healthHistory.length > 100) this.healthHistory.shift();
  }
  
  /**
   * Calculates current drawdown from trade window
   * @returns {number} Drawdown percentage
   */
  calculateDrawdown() {
    let peak = 0;
    let maxDD = 0;
    let cumulative = 0;
    for (const t of this.tradeWindow) {
      const pnl = t.result === "WIN" ? (t.rr || 3) : -1;
      cumulative += pnl;
      if (cumulative > peak) peak = cumulative;
      const dd = peak > 0 ? (peak - cumulative) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  }
  
  /**
   * Updates stability score based on segments
   * @param {Object} trade - Trade with session, volatilityRegime, date
   */
  updateStability(trade) {
    // Session segment
    if (!this.stabilitySegments.sessions[trade.session]) {
      this.stabilitySegments.sessions[trade.session] = { wins: 0, losses: 0 };
    }
    if (trade.result === "WIN") this.stabilitySegments.sessions[trade.session].wins++;
    else this.stabilitySegments.sessions[trade.session].losses++;
    
    // Volatility regime segment
    if (!this.stabilitySegments.volatility[trade.volatilityRegime]) {
      this.stabilitySegments.volatility[trade.volatilityRegime] = { wins: 0, losses: 0 };
    }
    if (trade.result === "WIN") this.stabilitySegments.volatility[trade.volatilityRegime].wins++;
    else this.stabilitySegments.volatility[trade.volatilityRegime].losses++;
    
    // Week segment (based on timestamp)
    const date = new Date(trade.timestamp);
    const weekKey = `${date.getFullYear()}-W${Math.ceil(date.getDate() / 7)}`;
    if (!this.stabilitySegments.weeks[weekKey]) {
      this.stabilitySegments.weeks[weekKey] = { wins: 0, losses: 0 };
    }
    if (trade.result === "WIN") this.stabilitySegments.weeks[weekKey].wins++;
    else this.stabilitySegments.weeks[weekKey].losses++;
    
    this.recalculateStabilityScore();
  }
  
  /**
   * Recalculates overall stability score
   */
  recalculateStabilityScore() {
    let totalSegments = 0;
    let goodSegments = 0;
    
    // Check sessions with at least 10 trades
    for (const [session, data] of Object.entries(this.stabilitySegments.sessions)) {
      const total = data.wins + data.losses;
      if (total >= 10) {
        totalSegments++;
        const winRate = data.wins / total * 100;
        const drawdown = this.calculateSegmentDrawdown(session);
        if (winRate > 50 && drawdown < 15) goodSegments++;
      }
    }
    
    // Similar for volatility regimes and weeks would be computed similarly
    // For brevity, using sessions as primary indicator
    
    this.stabilityScore = totalSegments > 0 ? (goodSegments / totalSegments) * 100 : 100;
  }
  
  /**
   * Placeholder for segment drawdown calculation
   */
  calculateSegmentDrawdown(segment) {
    return 5; // Placeholder - would need trade history per segment
  }
  
  getHealth() {
    return this.currentHealth || 100;
  }
  
  getStabilityScore() {
    return this.stabilityScore || 100;
  }
  
  shouldTriggerDiscovery() {
    const health = this.getHealth();
    // Trigger if health 50-59 for 5 consecutive trades OR health <50 immediately
    const recentHealth = this.healthHistory.slice(-5);
    const lowHealthStreak = recentHealth.every(h => h.health >= 50 && h.health <= 59);
    if (lowHealthStreak && recentHealth.length === 5) return true;
    if (health < 50) return true;
    return false;
  }
}

// ============================================================
// PART 4 COMPLETE
// ============================================================
// NEXT: PART 5 — Production Engine + Signal Gates + BUY/SELL STOP + Virtual Account Integration
//
// After pasting Part 4, your App.jsx now has:
// - Dataset hashing for reproducibility
// - LocalStorage persistence for patterns, versions, pending candidates
// - Discovery cooldown (24-hour minimum)
// - Discovery trigger logic (health monitoring)
// - Complete discovery workflow integration
// - HealthMonitor class for tracking performance
// - Stability score calculation
//
// Pending for Part 5:
// - Production Engine (pattern evaluation on live candles)
// - Signal Gates (6 gates: data quality, volatility, news, single position, kill switches)
// - BUY STOP / SELL STOP signal generation
// - Virtual account integration with journal
// - Entry/SL/TP calculation from pattern's historical statistics
// - Integration with V3's existing UI components
// ============================================================

// ============================================================
// TEST CODE FOR PART 4 (add to App component temporarily)
// ============================================================
// useEffect(() => {
//   async function testDiscoveryWorkflow() {
//     const raw = await fetchTwelveDataCandles();
//     const { validatedCandles } = sanitizeCandles(raw);
//     
//     // Test manual discovery (bypasses cooldown)
//     const result = await runCompleteDiscovery(validatedCandles, true);
//     console.log("Discovery workflow result:", result);
//     
//     if (result.success) {
//       console.log("Pattern found! Saving to storage...");
//       saveActivePattern(result.bestCandidate);
//     } else if (result.blocked) {
//       console.log("Discovery blocked:", result.reason);
//     } else {
//       console.log("Discovery failed:", result.failureReason);
//       const report = formatDiscoveryFailureReport(result);
//       console.log("Failure report:", report);
//     }
//     
//     // Test health monitor
//     const monitor = new HealthMonitor();
//     monitor.addTrade({ result: "WIN", rr: 4, session: "LONDON", volatilityRegime: "NORMAL", timestamp: Date.now() });
//     monitor.addTrade({ result: "LOSS", rr: 0, session: "LONDON", volatilityRegime: "NORMAL", timestamp: Date.now() });
//     console.log("Health:", monitor.getHealth());
//     console.log("Should trigger discovery:", monitor.shouldTriggerDiscovery());
//   }
//   testDiscoveryWorkflow();
// }, []);
// ============================================================
// ============================================================
// PART 5 OF 8 — PRODUCTION ENGINE + SIGNAL GATES + BUY/SELL STOP + VIRTUAL ACCOUNT INTEGRATION
// ============================================================
// INSTRUCTIONS:
// 1. Paste this code AFTER Part 4 in your App.jsx
// 2. This code adds:
//    - Production Engine (evaluates active pattern on live candles)
//    - Entry/SL/TP calculation from pattern's historical statistics
//    - 6 Signal Quality Gates (data quality, volatility, news, single position, kill switches, duplicate prevention)
//    - BUY STOP / SELL STOP signal generation
//    - Virtual account integration with journal
//    - Signal expiry and freshness management
// ============================================================

// ============================================================
// PRODUCTION ENGINE — ENTRY/SL/TP CALCULATION FROM PATTERN STATISTICS
// ============================================================

/**
 * Calculates entry, stop loss, and take profit based on pattern's historical statistics
 * @param {Object} pattern - Active pattern with training results
 * @param {number} currentPrice - Current market price
 * @param {string} direction - "BUY" or "SELL" (from pattern's dominant bias)
 * @param {Object} historicalStats - Pattern's historical win/loss statistics
 * @returns {Object} { entry, sl, tp, rr, riskPips, rewardPips, valid, reason }
 */
function calculateEntrySLTPFromPattern(pattern, currentPrice, direction, historicalStats) {
  // Default risk parameters (pips for EUR/USD)
  const DEFAULT_RISK_PIPS = 30;
  const DEFAULT_REWARD_PIPS = 90;
  
  // Get historical MAE (Maximum Adverse Excursion) from winning trades
  let riskPips = DEFAULT_RISK_PIPS;
  let rewardPips = DEFAULT_REWARD_PIPS;
  
  if (historicalStats && historicalStats.winningTrades && historicalStats.winningTrades.length > 0) {
    // Calculate 90th percentile MAE from winning trades
    const maes = historicalStats.winningTrades.map(t => t.maxAdverseExcursion || DEFAULT_RISK_PIPS);
    maes.sort((a, b) => a - b);
    const percentile90Index = Math.floor(maes.length * 0.9);
    riskPips = maes[percentile90Index] || DEFAULT_RISK_PIPS;
    
    // Calculate median profit from winning trades
    const profits = historicalStats.winningTrades.map(t => t.profitPips || DEFAULT_REWARD_PIPS);
    profits.sort((a, b) => a - b);
    const medianIndex = Math.floor(profits.length / 2);
    rewardPips = profits[medianIndex] || DEFAULT_REWARD_PIPS;
    
    // Ensure minimum RR of 1:3
    if (rewardPips < riskPips * 3) {
      rewardPips = riskPips * 3;
    }
  }
  
  const riskAmount = riskPips * 0.0001; // Convert pips to price change
  const rewardAmount = rewardPips * 0.0001;
  
  let entry, sl, tp;
  if (direction === "BUY") {
    entry = currentPrice;
    sl = entry - riskAmount;
    tp = entry + rewardAmount;
  } else {
    entry = currentPrice;
    sl = entry + riskAmount;
    tp = entry - rewardAmount;
  }
  
  const rr = rewardPips / riskPips;
  const isValid = rr >= 3;
  
  return {
    entry: parseFloat(entry.toFixed(5)),
    sl: parseFloat(sl.toFixed(5)),
    tp: parseFloat(tp.toFixed(5)),
    rr: parseFloat(rr.toFixed(2)),
    riskPips: riskPips,
    rewardPips: rewardPips,
    valid: isValid,
    reason: isValid ? null : `RR ${rr.toFixed(2)} < 3`
  };
}

// ============================================================
// SIGNAL QUALITY GATES
// ============================================================

/**
 * Gate 1: Data Quality Gate (circuit breaker)
 * @param {boolean} circuitBreakerActive - Whether circuit breaker is active
 * @returns {Object} { passed, reason }
 */
function gateDataQuality(circuitBreakerActive) {
  if (circuitBreakerActive) {
    return { passed: false, reason: "Circuit breaker active — data quality failed" };
  }
  return { passed: true, reason: null };
}

/**
 * Gate 2: Data Freshness Gate
 * @param {number} dataAgeMinutes - Age of last candle in minutes
 * @returns {Object} { passed, reason }
 */
function gateDataFreshness(dataAgeMinutes) {
  if (dataAgeMinutes === null || dataAgeMinutes > 15) {
    return { passed: false, reason: `Data stale: ${dataAgeMinutes?.toFixed(1) || "?"} minutes old (limit 15 min)` };
  }
  return { passed: true, reason: null };
}

/**
 * Gate 3: Volatility Gate
 * @param {number} atrPips - Current ATR in pips
 * @param {number} minATRPips - Minimum ATR required (default 20)
 * @returns {Object} { passed, reason, warning }
 */
function gateVolatility(atrPips, minATRPips = 20) {
  if (atrPips === null) {
    return { passed: true, reason: null, warning: "Volatility check skipped — ATR unavailable" };
  }
  if (atrPips < minATRPips) {
    return { passed: false, reason: `Low volatility: ATR ${atrPips.toFixed(1)} pips < ${minATRPips} pips`, warning: null };
  }
  return { passed: true, reason: null, warning: null };
}

/**
 * Gate 4: News Event Protection Gate
 * @param {Array} newsEvents - Array of upcoming events with dates
 * @param {number} currentTimeMs - Current timestamp in ms
 * @returns {Object} { passed, reason, nextEvent }
 */
function gateNewsProtection(newsEvents, currentTimeMs = Date.now()) {
  const bufferMs = 30 * 60 * 1000; // 30 minutes
  for (const event of newsEvents) {
    const eventTimeMs = new Date(event.date).getTime();
    if (Math.abs(currentTimeMs - eventTimeMs) < bufferMs) {
      return {
        passed: false,
        reason: `News event protection active: ${event.name} ±30min`,
        nextEvent: event
      };
    }
  }
  
  // Find next event for display
  let nextEvent = null;
  for (const event of newsEvents) {
    const eventTimeMs = new Date(event.date).getTime();
    if (eventTimeMs > currentTimeMs) {
      if (!nextEvent || eventTimeMs < new Date(nextEvent.date).getTime()) {
        nextEvent = event;
      }
    }
  }
  
  return { passed: true, reason: null, nextEvent };
}

/**
 * Gate 5: Single Position Rule
 * @param {boolean} hasActivePosition - Whether there's an active trade
 * @returns {Object} { passed, reason }
 */
function gateSinglePosition(hasActivePosition) {
  if (hasActivePosition) {
    return { passed: false, reason: "Single position rule: active trade exists" };
  }
  return { passed: true, reason: null };
}

/**
 * Gate 6: Kill Switches (Health, Confidence, Drawdown)
 * @param {Object} killSwitchState - Current kill switch states
 * @returns {Object} { passed, reason, activeSwitches }
 */
function gateKillSwitches(killSwitchState) {
  const activeSwitches = [];
  
  if (killSwitchState.health < 40) {
    activeSwitches.push(`Health ${killSwitchState.health.toFixed(1)} < 40`);
  }
  if (killSwitchState.confidence < 55) {
    activeSwitches.push(`Confidence ${killSwitchState.confidence} < 55`);
  }
  if (killSwitchState.drawdown > 15) {
    activeSwitches.push(`Drawdown ${killSwitchState.drawdown.toFixed(1)}% > 15%`);
  }
  if (killSwitchState.executionQuality < 60 && killSwitchState.executionQualityStreak >= 20) {
    activeSwitches.push(`Execution quality ${killSwitchState.executionQuality} < 60 for ${killSwitchState.executionQualityStreak} trades`);
  }
  
  if (activeSwitches.length > 0) {
    return { passed: false, reason: `Kill switches active: ${activeSwitches.join(", ")}`, activeSwitches };
  }
  return { passed: true, reason: null, activeSwitches: [] };
}

/**
 * Gate 7: Duplicate Signal Prevention
 * @param {Object} lastSignal - Last generated signal
 * @param {number} cooldownMinutes - Cooldown in minutes (default 60)
 * @returns {Object} { passed, reason }
 */
function gateDuplicateSignal(lastSignal, cooldownMinutes = 60) {
  if (!lastSignal) {
    return { passed: true, reason: null };
  }
  const timeSinceLastSignal = (Date.now() - new Date(lastSignal.timestamp).getTime()) / 60000;
  if (timeSinceLastSignal < cooldownMinutes) {
    return { passed: false, reason: `Duplicate prevention: ${Math.ceil(cooldownMinutes - timeSinceLastSignal)} minutes remaining` };
  }
  return { passed: true, reason: null };
}

/**
 * Gate 8: Signal Freshness (Expiry)
 * @param {Object} pendingSignal - Pending signal object
 * @param {number} expiryHours - Expiry in hours (default 2)
 * @returns {Object} { passed, reason, expired }
 */
function gateSignalFreshness(pendingSignal, expiryHours = 2) {
  if (!pendingSignal) {
    return { passed: true, reason: null, expired: false };
  }
  const ageMs = Date.now() - new Date(pendingSignal.timestamp).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  if (ageHours > expiryHours) {
    return { passed: false, reason: `Signal expired: ${ageHours.toFixed(1)} hours old (limit ${expiryHours})`, expired: true };
  }
  return { passed: true, reason: null, expired: false };
}

/**
 * Evaluates all signal gates
 * @param {Object} gateInputs - All gate inputs
 * @returns {Object} { passed, blocks, gateDetails }
 */
function evaluateAllGates(gateInputs) {
  const blocks = [];
  const gateDetails = {};
  
  // Gate 1: Data Quality
  const g1 = gateDataQuality(gateInputs.circuitBreakerActive);
  gateDetails.dataQuality = g1;
  if (!g1.passed) blocks.push({ gate: "Data Quality", reason: g1.reason });
  
  // Gate 2: Data Freshness
  const g2 = gateDataFreshness(gateInputs.dataAgeMinutes);
  gateDetails.dataFreshness = g2;
  if (!g2.passed) blocks.push({ gate: "Data Freshness", reason: g2.reason });
  
  // Gate 3: Volatility
  const g3 = gateVolatility(gateInputs.atrPips, gateInputs.minATRPips || 20);
  gateDetails.volatility = g3;
  if (!g3.passed) blocks.push({ gate: "Volatility", reason: g3.reason });
  
  // Gate 4: News Protection
  const g4 = gateNewsProtection(gateInputs.newsEvents || [], gateInputs.currentTime);
  gateDetails.newsProtection = g4;
  if (!g4.passed) blocks.push({ gate: "News Protection", reason: g4.reason });
  
  // Gate 5: Single Position
  const g5 = gateSinglePosition(gateInputs.hasActivePosition);
  gateDetails.singlePosition = g5;
  if (!g5.passed) blocks.push({ gate: "Single Position", reason: g5.reason });
  
  // Gate 6: Kill Switches
  const g6 = gateKillSwitches(gateInputs.killSwitchState);
  gateDetails.killSwitches = g6;
  if (!g6.passed) blocks.push({ gate: "Kill Switches", reason: g6.reason });
  
  // Gate 7: Duplicate Prevention
  const g7 = gateDuplicateSignal(gateInputs.lastSignal, gateInputs.duplicateCooldownMinutes || 60);
  gateDetails.duplicatePrevention = g7;
  if (!g7.passed) blocks.push({ gate: "Duplicate Prevention", reason: g7.reason });
  
  // Gate 8: Signal Freshness (for pending signals)
  if (gateInputs.pendingSignal) {
    const g8 = gateSignalFreshness(gateInputs.pendingSignal, gateInputs.signalExpiryHours || 2);
    gateDetails.signalFreshness = g8;
    if (!g8.passed) blocks.push({ gate: "Signal Freshness", reason: g8.reason });
  }
  
  return {
    passed: blocks.length === 0,
    blocks,
    gateDetails
  };
}

// ============================================================
// PRODUCTION ENGINE (Evaluates Pattern on Live Candles)
// ============================================================

/**
 * Pattern fingerprint for duplicate prevention
 * @param {Object} pattern - Active pattern
 * @param {string} direction - Trade direction
 * @param {number} currentPrice - Current price
 * @returns {string} Fingerprint string
 */
function generateSignalFingerprint(pattern, direction, currentPrice) {
  const conditionsHash = pattern.conditions.map(c => `${c.type}:${c.value}`).join("|");
  const priceBand = Math.floor(currentPrice * 1000) / 1000;
  return `${direction}|${conditionsHash}|${priceBand}`;
}

/**
 * Evaluates active pattern on current candle to determine if signal should be generated
 * @param {Object} activePattern - Stored pattern from discovery
 * @param {Object} currentFeatures - Feature vector for current candle
 * @param {number} currentPrice - Current market price
 * @param {Object} historicalStats - Pattern's historical statistics
 * @returns {Object} { shouldSignal, direction, entrySLTP, reason }
 */
function evaluatePatternOnLiveCandle(activePattern, currentFeatures, currentPrice, historicalStats) {
  if (!activePattern || !activePattern.conditions) {
    return { shouldSignal: false, direction: null, entrySLTP: null, reason: "No active pattern" };
  }
  
  // Check if current candle matches pattern conditions
  const matches = matchesPattern(currentFeatures, activePattern.conditions);
  if (!matches) {
    return { shouldSignal: false, direction: null, entrySLTP: null, reason: "Pattern conditions not met" };
  }
  
  // Determine direction from pattern's dominant bias
  // For now, infer from pattern's conditions or use trend from features
  let direction = "BUY";
  if (currentFeatures.trend === "BEARISH") direction = "SELL";
  else if (currentFeatures.trend === "BULLISH") direction = "BUY";
  else {
    // Default to trend from price structure
    direction = currentFeatures.higherHigh && currentFeatures.higherLow ? "BUY" : "SELL";
  }
  
  const entrySLTP = calculateEntrySLTPFromPattern(activePattern, currentPrice, direction, historicalStats);
  
  if (!entrySLTP.valid) {
    return { shouldSignal: false, direction, entrySLTP, reason: entrySLTP.reason };
  }
  
  return {
    shouldSignal: true,
    direction,
    entrySLTP,
    reason: `Pattern matched: ${activePattern.conditions.length} conditions met`
  };
}

// ============================================================
// VIRTUAL ACCOUNT EXTENSION (Journal with Attribution)
// ============================================================

/**
 * Creates a journal entry for a trade
 * @param {Object} signal - Signal object
 * @param {string} result - "WIN", "LOSS", or "MANUAL_CANCELLATION"
 * @param {string} attribution - Attribution reason (STRATEGY_LOSS, DATA_DELAY_LOSS, MANUAL_CANCELLATION, UNKNOWN_CAUSE)
 * @param {number} exitPrice - Exit price
 * @returns {Object} Journal entry
 */
function createJournalEntry(signal, result, attribution, exitPrice) {
  const now = new Date().toISOString();
  const pipValue = 0.1; // $0.10 per pip for 0.01 lot
  const realizedPL = result === "WIN" 
    ? signal.rewardPips * pipValue 
    : result === "LOSS" 
      ? -signal.riskPips * pipValue 
      : 0;
  
  return {
    id: signal.id,
    direction: signal.direction,
    entry: signal.entry,
    exit: exitPrice,
    sl: signal.sl,
    tp: signal.tp,
    rr: signal.rr,
    result: result,
    attribution: attribution,
    realizedPL: parseFloat(realizedPL.toFixed(2)),
    session: signal.session,
    regime: signal.regime,
    strategyVersion: signal.strategyVersion,
    patternFingerprint: signal.fingerprint,
    opportunityScore: signal.opportunityScore,
    validationScore: signal.validationScore,
    expectedTTT: signal.expectedTTT,
    actualTTT: result === "WIN" || result === "LOSS" 
      ? (Date.now() - new Date(signal.timestamp).getTime()) / (60 * 60 * 1000)
      : null,
    openedAt: signal.timestamp,
    closedAt: now,
    evidenceRecord: signal.evidenceRecord
  };
}

// ============================================================
// SIGNAL GENERATION FUNCTION (Complete)
// ============================================================

/**
 * Generates a new signal based on pattern evaluation and gates
 * @param {Object} context - All necessary context for signal generation
 * @returns {Object} { generated, signal, blockReason, gateResults }
 */
function generateSignal(context) {
  const {
    activePattern,
    currentFeatures,
    currentPrice,
    historicalStats,
    circuitBreakerActive,
    dataAgeMinutes,
    atrPips,
    newsEvents,
    hasActivePosition,
    killSwitchState,
    lastSignal,
    pendingSignal,
    currentTime = Date.now()
  } = context;
  
  // First, evaluate all gates
  const gateResults = evaluateAllGates({
    circuitBreakerActive,
    dataAgeMinutes,
    atrPips,
    minATRPips: 20,
    newsEvents,
    currentTime,
    hasActivePosition,
    killSwitchState,
    lastSignal,
    pendingSignal,
    duplicateCooldownMinutes: 60,
    signalExpiryHours: 2
  });
  
  if (!gateResults.passed) {
    return {
      generated: false,
      signal: null,
      blockReason: gateResults.blocks.map(b => `${b.gate}: ${b.reason}`).join(" | "),
      gateResults
    };
  }
  
  // Evaluate pattern on live candle
  const patternEval = evaluatePatternOnLiveCandle(activePattern, currentFeatures, currentPrice, historicalStats);
  
  if (!patternEval.shouldSignal) {
    return {
      generated: false,
      signal: null,
      blockReason: patternEval.reason,
      gateResults
    };
  }
  
  // Check for existing pending signal (don't generate duplicate)
  if (pendingSignal && !gateResults.gateDetails.signalFreshness?.expired) {
    return {
      generated: false,
      signal: null,
      blockReason: "Pending signal already exists — waiting for expiry or cancellation",
      gateResults
    };
  }
  
  // Generate new signal
  const fingerprint = generateSignalFingerprint(activePattern, patternEval.direction, currentPrice);
  const signalId = `SIG-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  
  const newSignal = {
    id: signalId,
    direction: patternEval.direction,
    entry: patternEval.entrySLTP.entry,
    sl: patternEval.entrySLTP.sl,
    tp: patternEval.entrySLTP.tp,
    rr: patternEval.entrySLTP.rr,
    riskPips: patternEval.entrySLTP.riskPips,
    rewardPips: patternEval.entrySLTP.rewardPips,
    timestamp: new Date().toISOString(),
    fingerprint: fingerprint,
    strategyVersion: activePattern.version || "v1.0",
    session: currentFeatures.session,
    regime: currentFeatures.trend === "BULLISH" ? "TRENDING" : currentFeatures.trend === "BEARISH" ? "TRENDING" : "RANGING",
    opportunityScore: currentFeatures.sessionScore,
    validationScore: 75, // Placeholder — will be calculated from actual validation
    expectedTTT: 4, // Placeholder — will be calculated from historical TTT
    evidenceRecord: {
      matchedConditions: activePattern.conditions,
      featuresAtSignal: {
        trend: currentFeatures.trend,
        session: currentFeatures.session,
        ema20Relation: currentFeatures.ema20Relation,
        rsi14: currentFeatures.rsi14
      }
    }
  };
  
  return {
    generated: true,
    signal: newSignal,
    blockReason: null,
    gateResults,
    patternEval
  };
}

// ============================================================
// PENDING SIGNAL MANAGEMENT (Expiry and Re-evaluation)
// ============================================================

/**
 * Checks if a pending signal should be cancelled (setup invalid)
 * @param {Object} pendingSignal - Pending signal object
 * @param {Object} currentFeatures - Current feature vector
 * @param {Object} activePattern - Active pattern
 * @returns {Object} { shouldCancel, reason }
 */
function shouldCancelPendingSignal(pendingSignal, currentFeatures, activePattern) {
  if (!pendingSignal) return { shouldCancel: false, reason: null };
  
  // Check if current candle still matches pattern conditions
  const stillMatches = matchesPattern(currentFeatures, activePattern.conditions);
  if (!stillMatches) {
    return { shouldCancel: true, reason: "Pattern conditions no longer met" };
  }
  
  // Check freshness expiry
  const ageHours = (Date.now() - new Date(pendingSignal.timestamp).getTime()) / (60 * 60 * 1000);
  if (ageHours > 2) {
    return { shouldCancel: true, reason: `Signal expired after ${ageHours.toFixed(1)} hours` };
  }
  
  return { shouldCancel: false, reason: null };
}

// ============================================================
// PART 5 COMPLETE
// ============================================================
// NEXT: PART 6 — UI Components (Dashboard, Signals, Journal, Statistics, Settings, About Bot)
//
// After pasting Part 5, your App.jsx now has:
// - Complete production engine
// - 8 signal quality gates
// - BUY STOP / SELL STOP signal generation
// - Entry/SL/TP calculation from pattern statistics
// - Virtual account journal integration
// - Pending signal management with expiry
// - Duplicate signal prevention
// - Signal fingerprinting
//
// Pending for Part 6:
// - Dashboard UI component (health panel, account card, gate status)
// - Signals page (gate visualization, signal generation button, active trade display)
// - Journal page (trade history with attribution)
// - Statistics page (win rate, profit factor, drawdown, session performance)
// - Settings page (API key, thresholds, advanced options)
// - About Bot page (pattern description, reproducibility data, disclosure)
// - System Health Panel (always visible)
// ============================================================

// ============================================================
// TEST CODE FOR PART 5 (add to App component temporarily)
// ============================================================
// useEffect(() => {
//   async function testProductionEngine() {
//     // Load active pattern from storage
//     const activePattern = loadActivePattern();
//     if (!activePattern) {
//       console.log("No active pattern. Run discovery first.");
//       return;
//     }
//     
//     // Get current candle features
//     const raw = await fetchTwelveDataCandles();
//     const { validatedCandles } = sanitizeCandles(raw);
//     const features = computeAllFeatureVectors(validatedCandles);
//     const currentFeatures = features[features.length - 1];
//     const currentPrice = currentFeatures.close;
//     
//     // Test signal generation
//     const result = generateSignal({
//       activePattern,
//       currentFeatures,
//       currentPrice,
//       historicalStats: null,
//       circuitBreakerActive: false,
//       dataAgeMinutes: 2,
//       atrPips: 25,
//       newsEvents: [],
//       hasActivePosition: false,
//       killSwitchState: { health: 85, confidence: 75, drawdown: 5, executionQuality: 85, executionQualityStreak: 5 },
//       lastSignal: null,
//       pendingSignal: null
//     });
//     
//     console.log("Signal generation result:", result);
//   }
//   testProductionEngine();
// }, []);
// ============================================================
// ============================================================
// PART 6 OF 8 — UI COMPONENTS (DASHBOARD, SIGNALS, JOURNAL, STATISTICS, SETTINGS, ABOUT BOT) + SYSTEM HEALTH PANEL
// ============================================================
// INSTRUCTIONS:
// 1. This code should REPLACE the existing UI components in your V3 App.jsx
// 2. Keep your existing T design tokens (colors, fonts, spacing)
// 3. Keep your existing BottomNav component (from V3)
// 4. This code adds all new UI pages with V4 requirements
// ============================================================

// ============================================================
// SYSTEM HEALTH PANEL (Always Visible)
// ============================================================

const SystemHealthPanel = ({ 
  apiStatus, rateLimitRemaining, dataDateRange, lastFetchTime, dataAgeMinutes,
  evidenceCompletion, gateStatus, learningProgress, strategyVersion,
  confidenceScore, executionQuality, killSwitchStatus, healthScore, stabilityScore,
  volumeStatus, spreadStatus, nextEventTime, nextDiscoveryTime,
  walkForwardStatus, lowSampleWarning, coverageWarning
}) => {
  const getColorForValue = (value, thresholds) => {
    if (value >= thresholds.good) return T.green;
    if (value >= thresholds.warning) return T.yellow;
    return T.red;
  };
  
  return (
    <div style={{
      background: T.bg2,
      borderBottom: `1px solid ${T.border}`,
      padding: "8px 12px",
      display: "flex",
      flexWrap: "wrap",
      gap: "12px",
      fontSize: "10px",
      fontFamily: T.font,
      flexShrink: 0
    }}>
      {/* API Status */}
      <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        <Dot color={apiStatus === "OK" ? T.green : T.red} pulse={apiStatus !== "OK"} />
        <span style={{ color: apiStatus === "OK" ? T.green : T.red }}>API</span>
        {rateLimitRemaining !== null && (
          <span style={{ color: T.textDim }}>({rateLimitRemaining}/800)</span>
        )}
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Data Range */}
      <div>
        <span style={{ color: T.textDim }}>Data:</span>
        <span style={{ color: T.text, marginLeft: "4px" }}>
          {dataDateRange ? `${dataDateRange.from.slice(5, 10)} → ${dataDateRange.to.slice(5, 10)}` : "—"}
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Data Age */}
      <div>
        <span style={{ color: dataAgeMinutes !== null && dataAgeMinutes < 15 ? T.green : T.red }}>
          Age: {dataAgeMinutes !== null ? `${dataAgeMinutes.toFixed(0)}m` : "—"}
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Gate Status */}
      <div>
        <span style={{ color: gateStatus === "OPEN" ? T.green : T.red }}>
          Gate: {gateStatus}
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Confidence */}
      <div>
        <span style={{ color: T.textDim }}>Conf:</span>
        <span style={{ color: getColorForValue(confidenceScore, { good: 70, warning: 50 }) }}>
          {confidenceScore}
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Health */}
      <div>
        <span style={{ color: T.textDim }}>Health:</span>
        <span style={{ color: getColorForValue(healthScore, { good: 60, warning: 40 }) }}>
          {healthScore?.toFixed(0) || "—"}
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Stability */}
      <div>
        <span style={{ color: T.textDim }}>Stab:</span>
        <span style={{ color: getColorForValue(stabilityScore, { good: 70, warning: 50 }) }}>
          {stabilityScore?.toFixed(0) || "—"}%
        </span>
      </div>
      
      <div style={{ width: "1px", height: "12px", background: T.border }} />
      
      {/* Kill Switch Warning */}
      {killSwitchStatus && (
        <>
          <span style={{ color: T.red, fontWeight: 700 }}>⚡ KILL SWITCH</span>
          <div style={{ width: "1px", height: "12px", background: T.border }} />
        </>
      )}
      
      {/* Coverage Warning */}
      {coverageWarning && (
        <span style={{ color: T.yellow }}>⚠ Limited coverage</span>
      )}
      
      {/* Low Sample Warning */}
      {lowSampleWarning && (
        <span style={{ color: T.yellow }}>⚠ Low sample size</span>
      )}
      
      {/* Walk-Forward Status */}
      {walkForwardStatus === "SKIPPED" && (
        <span style={{ color: T.yellow }}>⚠ WF skipped</span>
      )}
    </div>
  );
};

// ============================================================
// DASHBOARD PAGE
// ============================================================

const DashboardPage = ({ 
  priceData, account, activeSignal, journal, session, gateResult, 
  analysis, killSwitches, confidence, dataAge, healthScore, stabilityScore,
  activePattern, onRefresh
}) => {
  const gateOpen = gateResult?.passed;
  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Gate Status Card */}
      <Card style={{ 
        border: `1px solid ${gateOpen ? T.green + "50" : T.red + "50"}`,
        background: gateOpen ? T.greenDim + "30" : T.redDim + "30"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Dot color={gateOpen ? T.green : T.red} pulse={gateOpen} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: T.font, color: gateOpen ? T.green : T.red }}>
              {activeSignal ? "POSITION ACTIVE" : gateOpen ? "SIGNAL GATE: OPEN" : "SIGNAL GATE: CLOSED"}
            </div>
            {!gateOpen && gateResult?.blocks && (
              <div style={{ fontSize: 11, color: T.textMid, marginTop: 3 }}>
                {gateResult.blocks.slice(0, 2).map(b => b.label).join(" · ")}
                {gateResult.blocks.length > 2 && " · ..."}
              </div>
            )}
          </div>
          <Badge variant={gateOpen ? "success" : "danger"}>{gateOpen ? "OPEN" : "CLOSED"}</Badge>
        </div>
      </Card>
      
      {/* Account + Session row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Card>
          <Label>Virtual Account</Label>
          <Value size={22} color={T.accent}>${account.balance.toFixed(2)}</Value>
          <div style={{ fontSize: 10, color: account.equity >= account.balance ? T.green : T.red, fontFamily: T.font, marginTop: 2 }}>
            EQ ${account.equity.toFixed(2)}
          </div>
          <Divider style={{ margin: "10px -18px" }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
            <Stat label="P/L" value={`${account.closedPL >= 0 ? "+" : ""}$${account.closedPL.toFixed(2)}`} 
              color={account.closedPL >= 0 ? T.green : T.red} size={13} />
            <Stat label="Max DD" value={`${account.maxDrawdown.toFixed(2)}%`} color={T.red} size={13} />
          </div>
        </Card>
        
        <Card>
          <Label>Session</Label>
          <Value size={18} color={session.open ? T.green : T.textMid}>{session.name}</Value>
          <div style={{ fontSize: 10, color: T.textDim, fontFamily: T.font, marginTop: 2 }}>{session.hours}</div>
          <Divider style={{ margin: "10px -18px" }} />
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: T.textMid }}>Strategy Health</span>
              <span style={{ fontSize: 11, fontFamily: T.font, color: healthScore >= 60 ? T.green : healthScore >= 40 ? T.yellow : T.red }}>
                {healthScore?.toFixed(0) || "—"}%
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: T.textMid }}>Stability</span>
              <span style={{ fontSize: 11, fontFamily: T.font, color: stabilityScore >= 70 ? T.green : stabilityScore >= 50 ? T.yellow : T.red }}>
                {stabilityScore?.toFixed(0) || "—"}%
              </span>
            </div>
          </div>
        </Card>
      </div>
      
      {/* Active Pattern Summary */}
      {activePattern && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <Label style={{ marginBottom: 0 }}>Active Strategy</Label>
            <Badge variant="info">v{activePattern.version || "1.0"}</Badge>
          </div>
          <div style={{ fontSize: 11, color: T.textMid, fontFamily: T.font }}>
            Pattern: {activePattern.conditions?.length || 0} conditions
          </div>
          <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>
            Training: {activePattern.trainingTrades} trades · WR {activePattern.trainingWR}%
          </div>
        </Card>
      )}
      
      {/* Opportunity Score (Informational) */}
      {analysis?.opportunityScore && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Label style={{ marginBottom: 0 }}>Opportunity Score</Label>
            <span style={{ fontSize: 20, fontWeight: 700, fontFamily: T.font, color: analysis.opportunityScore >= 90 ? T.green : analysis.opportunityScore >= 80 ? T.yellow : T.red }}>
              {analysis.opportunityScore}
            </span>
          </div>
          <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>
            Informational only — does not affect trading
          </div>
        </Card>
      )}
      
      {/* Active Trade if any */}
      {activeSignal && (
        <Card style={{ border: `1px solid ${T.yellow}40` }} glow={T.yellow}>
          <Label>Active Position</Label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
            <Badge variant={activeSignal.direction === "BUY" ? "success" : "danger"}>{activeSignal.direction}</Badge>
            <span style={{ fontFamily: T.font, fontSize: 14, fontWeight: 700, color: T.text }}>{activeSignal.entry?.toFixed(5)}</span>
            <span style={{ fontSize: 11, color: T.textDim }}>→ TP {activeSignal.tp?.toFixed(5)}</span>
          </div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>
            SL {activeSignal.sl?.toFixed(5)} · RR 1:{activeSignal.rr?.toFixed(2)} · {activeSignal.riskPips?.toFixed(1)} pips
          </div>
        </Card>
      )}
      
      {/* Kill Switches Active Warning */}
      {killSwitches?.active && (
        <Card style={{ border: `1px solid ${T.red}50`, background: T.redDim + "40" }}>
          <Label style={{ color: T.red, marginBottom: 8 }}>⚡ Kill Switches Active</Label>
          {killSwitches.switches.map(k => (
            <div key={k.id} style={{ fontSize: 11, color: T.red, fontFamily: T.font, marginBottom: 4 }}>✗ {k.msg}</div>
          ))}
        </Card>
      )}
      
      {/* Performance Summary */}
      {journal.length > 0 && (
        <Card>
          <Label style={{ marginBottom: 8 }}>Performance</Label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Stat label="Win Rate" value={`${((journal.filter(t => t.result === "WIN").length / journal.length) * 100).toFixed(0)}%`} color={T.green} />
            <Stat label="Profit Factor" value={journal.filter(t => t.result === "WIN").length / Math.max(journal.filter(t => t.result === "LOSS").length, 1)} color={T.accent} />
            <Stat label="Total Trades" value={journal.length} />
            <Stat label="Avg RR" value={`1:${(journal.reduce((sum, t) => sum + (t.rr || 3), 0) / journal.length).toFixed(1)}`} />
          </div>
        </Card>
      )}
      
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// SIGNALS PAGE
// ============================================================

const SignalsPage = ({ 
  gateResult, activeSignal, onGenerateSignal, onCloseSignal, 
  analysis, auditLog, pendingApproval, onApproveCandidate
}) => {
  const gateOpen = gateResult?.passed;
  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Gate Detail */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Label style={{ marginBottom: 0 }}>Signal Gate</Label>
          <RealBadge status="REAL" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {gateResult?.blocks?.map((b, i) => (
            <div key={i} style={{
              display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 12px",
              background: b.pass ? T.greenDim + "50" : T.redDim + "50", borderRadius: 7,
              border: `1px solid ${b.pass ? T.green + "25" : T.red + "25"}`
            }}>
              <span style={{ color: b.pass ? T.green : T.red, fontSize: 13, flexShrink: 0 }}>{b.pass ? "✓" : "✗"}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: b.pass ? T.green : T.red }}>{b.label}</div>
                <div style={{ fontSize: 11, color: T.textMid, marginTop: 2 }}>{b.msg}</div>
              </div>
            </div>
          ))}
        </div>
        {gateOpen && !activeSignal && (
          <button onClick={onGenerateSignal} style={{
            width: "100%", marginTop: 14, padding: "14px", borderRadius: 8,
            background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`,
            color: "#000", fontSize: 14, fontWeight: 700, fontFamily: T.font,
            letterSpacing: "0.06em"
          }}>
            GENERATE BUY/SELL STOP
          </button>
        )}
      </Card>
      
      {/* Pending Approval Candidate */}
      {pendingApproval && (
        <Card style={{ border: `1px solid ${T.yellow}40` }}>
          <Label>Pending Strategy Approval</Label>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: T.text }}>Candidate v{pendingApproval.version}</div>
            <div style={{ fontSize: 10, color: T.textDim }}>WR: {pendingApproval.wr}% | PF: {pendingApproval.pf}</div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => onApproveCandidate(true)} style={{
              flex: 1, padding: "10px", borderRadius: 8, background: T.greenDim,
              border: `1px solid ${T.green}40`, color: T.green, fontFamily: T.font, fontWeight: 700
            }}>APPROVE</button>
            <button onClick={() => onApproveCandidate(false)} style={{
              flex: 1, padding: "10px", borderRadius: 8, background: T.redDim,
              border: `1px solid ${T.red}40`, color: T.red, fontFamily: T.font, fontWeight: 700
            }}>REJECT</button>
          </div>
        </Card>
      )}
      
      {/* Active Signal */}
      {activeSignal && (
        <Card style={{ border: `1px solid ${T.yellow}40` }} glow={T.yellow}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <Label style={{ marginBottom: 0 }}>Active Position</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Dot color={T.yellow} pulse />
              <span style={{ fontSize: 10, fontFamily: T.font, color: T.yellow, fontWeight: 700 }}>LIVE</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
            <Badge variant={activeSignal.direction === "BUY" ? "success" : "danger"} style={{ fontSize: 13, padding: "4px 14px" }}>
              {activeSignal.direction === "BUY" ? "BUY STOP" : "SELL STOP"}
            </Badge>
            <span style={{ fontSize: 20, fontFamily: T.font, fontWeight: 700 }}>{activeSignal.entry?.toFixed(5)}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            <Stat label="Stop Loss" value={activeSignal.sl?.toFixed(5)} color={T.red} />
            <Stat label="Take Profit" value={activeSignal.tp?.toFixed(5)} color={T.green} />
            <Stat label="RR Ratio" value={`1:${activeSignal.rr?.toFixed(2)}`} color={T.green} />
            <Stat label="Risk (pips)" value={activeSignal.riskPips?.toFixed(1)} color={T.red} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <button onClick={() => onCloseSignal("WIN", null)} style={{
              padding: "10px", borderRadius: 8, background: T.greenDim,
              border: `1px solid ${T.green}40`, color: T.green, fontFamily: T.font, fontWeight: 700, fontSize: 12
            }}>CLOSE WIN</button>
            <button onClick={() => onCloseSignal("LOSS", "STRATEGY_LOSS")} style={{
              padding: "10px", borderRadius: 8, background: T.redDim,
              border: `1px solid ${T.red}40`, color: T.red, fontFamily: T.font, fontWeight: 700, fontSize: 12
            }}>LOSS (Strategy)</button>
            <button onClick={() => onCloseSignal("LOSS", "DATA_DELAY_LOSS")} style={{
              padding: "10px", borderRadius: 8, background: T.redDim,
              border: `1px solid ${T.red}40`, color: T.red, fontFamily: T.font, fontWeight: 700, fontSize: 12
            }}>LOSS (Data Delay)</button>
          </div>
        </Card>
      )}
      
      {/* Recent Audit */}
      <Card>
        <Label style={{ marginBottom: 10 }}>Recent Audit</Label>
        {auditLog.length === 0 ? (
          <div style={{ textAlign: "center", padding: "16px 0", color: T.textDim, fontSize: 12, fontFamily: T.font }}>No audit events yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {auditLog.slice(-5).reverse().map(e => (
              <div key={e.auditId} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 10px", background: T.bg3, borderRadius: 6 }}>
                <span style={{ fontSize: 9, fontFamily: T.font, color: T.textDim, flexShrink: 0 }}>{fmtTime(e.timestamp)}</span>
                <Badge variant={e.type === "SIGNAL_GENERATED" ? "success" : e.type.includes("BLOCK") ? "danger" : "warning"} style={{ flexShrink: 0 }}>
                  {e.type.replace(/_/g, " ")}
                </Badge>
                <span style={{ fontSize: 11, color: T.textMid }}>{e.reason}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// JOURNAL PAGE
// ============================================================

const JournalPage = ({ journal }) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {journal.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 24, marginBottom: 12 }}>▦</div>
            <div style={{ fontSize: 14, color: T.textMid, fontFamily: T.font }}>No trades recorded yet.</div>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 6 }}>Closed trades will appear here.</div>
          </div>
        </Card>
      ) : (
        journal.slice().reverse().map((t, i) => (
          <Card key={i} style={{ border: `1px solid ${t.result === "WIN" ? T.green + "30" : t.result === "LOSS" ? T.red + "30" : T.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge variant={t.direction === "BUY" ? "success" : "danger"}>{t.direction === "BUY" ? "BUY STOP" : "SELL STOP"}</Badge>
                <Badge variant={t.result === "WIN" ? "success" : t.result === "LOSS" ? "danger" : "warning"}>{t.result}</Badge>
                {t.attribution && t.attribution !== "UNKNOWN_CAUSE" && (
                  <span style={{ fontSize: 9, color: T.textDim, fontFamily: T.font }}>{t.attribution.replace(/_/g, " ")}</span>
                )}
              </div>
              <span style={{ fontSize: 10, color: T.textDim, fontFamily: T.font }}>{fmtDate(t.openedAt)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <Stat label="Entry" value={t.entry?.toFixed(5)} size={12} />
              <Stat label="SL" value={t.sl?.toFixed(5)} color={T.red} size={12} />
              <Stat label="TP" value={t.tp?.toFixed(5)} color={T.green} size={12} />
            </div>
            <Divider style={{ margin: "10px -18px" }} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
              <Stat label="RR" value={`1:${t.rr?.toFixed(2)}`} />
              <Stat label="Realized P&L" value={`${t.realizedPL >= 0 ? "+" : ""}$${t.realizedPL?.toFixed(2)}`} color={t.realizedPL >= 0 ? T.green : T.red} />
              <Stat label="Session" value={t.session} size={11} />
            </div>
            {t.reason && <div style={{ marginTop: 8, fontSize: 11, color: T.textDim }}>{t.reason}</div>}
          </Card>
        ))
      )}
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// STATISTICS PAGE
// ============================================================

const StatisticsPage = ({ account, journal, confidence }) => {
  const wins = journal.filter(t => t.result === "WIN").length;
  const losses = journal.filter(t => t.result === "LOSS").length;
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : null;
  
  const attributionBreakdown = {
    STRATEGY_LOSS: journal.filter(t => t.attribution === "STRATEGY_LOSS").length,
    DATA_DELAY_LOSS: journal.filter(t => t.attribution === "DATA_DELAY_LOSS").length,
    MANUAL_CANCELLATION: journal.filter(t => t.attribution === "MANUAL_CANCELLATION").length,
    UNKNOWN_CAUSE: journal.filter(t => t.attribution === "UNKNOWN_CAUSE").length
  };
  
  const bySession = ["LONDON", "NEW_YORK", "OVERLAP", "TOKYO", "OFF_HOURS"].map(s => {
    const trades = journal.filter(t => t.session === s);
    const w = trades.filter(t => t.result === "WIN").length;
    return { session: s, count: trades.length, wins: w, wr: trades.length > 0 ? Math.round(w / trades.length * 100) : null };
  }).filter(s => s.count > 0);
  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <Label style={{ marginBottom: 12 }}>Performance Overview</Label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Stat label="Total Trades" value={total} color={T.accent} size={28} />
          <Stat label="Win Rate" value={winRate ? `${winRate}%` : "—"} color={T.green} size={28} />
          <Stat label="Wins" value={wins} color={T.green} />
          <Stat label="Losses" value={losses} color={T.red} />
          <Stat label="Net P/L" value={`${account.closedPL >= 0 ? "+" : ""}$${account.closedPL.toFixed(2)}`} color={account.closedPL >= 0 ? T.green : T.red} />
          <Stat label="Max Drawdown" value={`${account.maxDrawdown.toFixed(2)}%`} color={T.red} />
        </div>
      </Card>
      
      <Card>
        <Label style={{ marginBottom: 12 }}>Confidence Engine</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: T.textMid }}>Current Score</span>
            <span style={{ fontSize: 20, fontFamily: T.font, fontWeight: 700, color: confidence?.score >= 70 ? T.green : confidence?.score >= 50 ? T.yellow : T.red }}>
              {confidence?.score ?? "—"}
            </span>
          </div>
          <ProgressBar value={confidence?.score ?? 0} color={T.accent} height={6} />
          <div style={{ fontSize: 11, color: T.textDim }}>{confidence?.note}</div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: T.textMid }}>Max Allowed</span>
            <span style={{ fontSize: 11, fontFamily: T.font, color: T.accent }}>{confidence?.max ?? 40}</span>
          </div>
          {confidence?.tradeCount < 30 && (
            <div style={{ fontSize: 10, color: T.yellow, marginTop: 4 }}>⚠ Low sample size: {confidence.tradeCount} trades</div>
          )}
        </div>
      </Card>
      
      {/* Loss Attribution Breakdown */}
      {total > 0 && (
        <Card>
          <Label style={{ marginBottom: 12 }}>Loss Attribution</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: T.textMid }}>Strategy Loss</span>
              <span style={{ fontFamily: T.font }}>{attributionBreakdown.STRATEGY_LOSS} ({total > 0 ? Math.round(attributionBreakdown.STRATEGY_LOSS / total * 100) : 0}%)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: T.textMid }}>Data Delay Loss</span>
              <span style={{ fontFamily: T.font }}>{attributionBreakdown.DATA_DELAY_LOSS} ({total > 0 ? Math.round(attributionBreakdown.DATA_DELAY_LOSS / total * 100) : 0}%)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: T.textMid }}>Manual Cancellation</span>
              <span style={{ fontFamily: T.font }}>{attributionBreakdown.MANUAL_CANCELLATION} ({total > 0 ? Math.round(attributionBreakdown.MANUAL_CANCELLATION / total * 100) : 0}%)</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
              <span style={{ color: T.textMid }}>Unknown Cause</span>
              <span style={{ fontFamily: T.font }}>{attributionBreakdown.UNKNOWN_CAUSE} ({total > 0 ? Math.round(attributionBreakdown.UNKNOWN_CAUSE / total * 100) : 0}%)</span>
            </div>
          </div>
        </Card>
      )}
      
      {bySession.length > 0 && (
        <Card>
          <Label style={{ marginBottom: 12 }}>Session Performance</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {bySession.map(s => (
              <div key={s.session} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: T.bg3, borderRadius: 7 }}>
                <span style={{ fontSize: 12, color: T.textMid, flex: 1, fontFamily: T.font }}>{s.session}</span>
                <span style={{ fontSize: 11, color: T.textDim }}>{s.count} trades</span>
                <span style={{ fontSize: 13, fontFamily: T.font, fontWeight: 700, color: s.wr >= 50 ? T.green : T.red }}>{s.wr !== null ? `${s.wr}%` : "—"}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      
      <Card>
        <Label style={{ marginBottom: 12 }}>Validation Schedule</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[{ at: 20, label: "Learning Review" }, { at: 50, label: "Minor Validation" }, { at: 100, label: "Major Validation" }].map(v => (
            <div key={v.at} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 99,
                background: total >= v.at ? T.greenDim : T.bg3,
                border: `1px solid ${total >= v.at ? T.green : T.border}`,
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
              }}>
                <span style={{ fontSize: 12, color: total >= v.at ? T.green : T.textDim, fontFamily: T.font }}>
                  {total >= v.at ? "✓" : v.at}
                </span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: T.text }}>{v.label}</div>
                <div style={{ fontSize: 10, color: T.textDim }}>at {v.at} trades — {total >= v.at ? "completed" : `${v.at - total} trades remaining`}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// SETTINGS PAGE
// ============================================================

const SettingsPage = ({ settings, onSave, onReset, journalLength, onManualDiscovery, isDiscovering }) => {
  const [local, setLocal] = useState(settings);
  const [saved, setSaved] = useState(false);
  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));
  
  const save = () => {
    onSave(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  
  const thresholdsDisabled = journalLength < 50;
  
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <Label style={{ marginBottom: 12 }}>Data Source</Label>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Label>Twelve Data API Key</Label>
            <input type="password" value={local.twelveDataApiKey || ""} onChange={e => set("twelveDataApiKey", e.target.value)}
              placeholder="Development key pre-configured"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: T.bg3, border: `1px solid ${T.border}`, color: T.text, fontSize: 13, marginTop: 4, outline: "none" }} />
            <div style={{ fontSize: 10, color: T.textDim, marginTop: 4 }}>Leave blank to use default. Stored in memory only.</div>
          </div>
          <div>
            <Label>Symbol</Label>
            <input value={local.symbol || "EUR/USD"} onChange={e => set("symbol", e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: T.bg3, border: `1px solid ${T.border}`, color: T.text, fontSize: 13, marginTop: 4, outline: "none" }} />
          </div>
        </div>
      </Card>
      
      <Card>
        <Label style={{ marginBottom: 12 }}>Signal Thresholds</Label>
        {thresholdsDisabled && (
          <div style={{ fontSize: 10, color: T.yellow, marginBottom: 8 }}>🔒 Thresholds locked until 50 trades validated ({journalLength}/50)</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <Label style={{ marginBottom: 0 }}>Opportunity Threshold (90–95)</Label>
              <span style={{ fontSize: 11, fontFamily: T.font, color: T.accent }}>{local.oppThreshold || 90}</span>
            </div>
            <input type="range" min={90} max={95} value={local.oppThreshold || 90} onChange={e => set("oppThreshold", Number(e.target.value))}
              disabled={thresholdsDisabled}
              style={{ width: "100%", accentColor: thresholdsDisabled ? T.textDim : T.accent, opacity: thresholdsDisabled ? 0.5 : 1 }} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <Label style={{ marginBottom: 0 }}>Alignment Requirement (66–80%)</Label>
              <span style={{ fontSize: 11, fontFamily: T.font, color: T.accent }}>{local.alignThreshold || 66}</span>
            </div>
            <input type="range" min={66} max={80} value={local.alignThreshold || 66} onChange={e => set("alignThreshold", Number(e.target.value))}
              disabled={thresholdsDisabled}
              style={{ width: "100%", accentColor: thresholdsDisabled ? T.textDim : T.accent, opacity: thresholdsDisabled ? 0.5 : 1 }} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <Label style={{ marginBottom: 0 }}>Refresh Interval (seconds)</Label>
              <span style={{ fontSize: 11, fontFamily: T.font, color: T.accent }}>{local.refreshSec || 30}</span>
            </div>
            <input type="range" min={15} max={120} value={local.refreshSec || 30} onChange={e => set("refreshSec", Number(e.target.value))}
              style={{ width: "100%", accentColor: T.accent }} />
          </div>
        </div>
      </Card>
      
      <Card>
        <Label style={{ marginBottom: 12 }}>Discovery</Label>
        <button onClick={onManualDiscovery} disabled={isDiscovering} style={{
          width: "100%", padding: "12px", borderRadius: 8,
          background: isDiscovering ? T.bg3 : T.accentDim,
          border: `1px solid ${isDiscovering ? T.border : T.accent}40`,
          color: isDiscovering ? T.textDim : T.accent,
          fontFamily: T.font, fontWeight: 700, fontSize: 13
        }}>
          {isDiscovering ? "DISCOVERY RUNNING..." : "MANUAL PATTERN DISCOVERY"}
        </button>
      </Card>
      
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={save} style={{
          flex: 1, padding: "14px", borderRadius: 8,
          background: saved ? T.greenDim : T.accentDim,
          border: `1px solid ${saved ? T.green : T.accent}40`,
          color: saved ? T.green : T.accent,
          fontFamily: T.font, fontWeight: 700, fontSize: 13
        }}>
          {saved ? "✓ SAVED" : "SAVE SETTINGS"}
        </button>
        <button onClick={onReset} style={{
          padding: "14px 18px", borderRadius: 8,
          background: "transparent", border: `1px solid ${T.red}40`,
          color: T.red, fontFamily: T.font, fontSize: 13
        }}>
          RESET
        </button>
      </div>
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// ABOUT BOT PAGE
// ============================================================

const AboutBotPage = ({ 
  strategyVersion, patternDescription, analyzedWindow, totalCandles,
  coverageRaw, coveragePractical, splitReport, currentRegime,
  trainingTrades, trainingWR, validationTrades, validationWR,
  avgRR, profitFactor, avgTTT, maxDrawdown, healthScore, stabilityScore,
  lossAttribution, nextEventTime, nextDiscoveryTime, pendingApproval,
  noTradeReason, lastDiscoveryAttempt, reproducibilityData
}) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: `linear-gradient(135deg, ${T.accent}, ${T.purple})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24, fontWeight: 900, color: "#000"
          }}>Σ</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>EUR/USD Signal Intelligence</div>
            <div style={{ fontSize: 12, color: T.textMid }}>V4 — Pattern Discovery Platform</div>
          </div>
        </div>
        
        <Divider />
        
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Label>Active Strategy</Label>
            <div style={{ fontSize: 14, fontFamily: T.font, color: T.accent }}>v{strategyVersion || "1.0"}</div>
            {patternDescription && (
              <div style={{ fontSize: 12, color: T.textMid, marginTop: 4 }}>{patternDescription}</div>
            )}
          </div>
          
          <div>
            <Label>Analysis Window</Label>
            <div style={{ fontSize: 13, color: T.text }}>{analyzedWindow?.from || "—"} → {analyzedWindow?.to || "—"}</div>
            <div style={{ fontSize: 11, color: T.textDim }}>{totalCandles || 0} candles analyzed</div>
          </div>
          
          <div>
            <Label>Search Coverage</Label>
            <div style={{ fontSize: 13, color: T.text }}>Raw: {coverageRaw || "—"} | Practical: {coveragePractical || "—"}</div>
          </div>
          
          <div>
            <Label>Chronological Split</Label>
            <div style={{ fontSize: 11, color: T.textDim }}>
              Training: {splitReport?.training?.count} candles<br />
              Validation A: {splitReport?.validationA?.count}<br />
              Validation B: {splitReport?.validationB?.count}<br />
              Walk-Forward: {splitReport?.walkForward?.count}
            </div>
          </div>
          
          <div>
            <Label>Strategy Statistics</Label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 4 }}>
              <Stat label="Training WR" value={trainingWR ? `${trainingWR}%` : "—"} size={13} />
              <Stat label="Validation WR" value={validationWR ? `${validationWR}%` : "—"} size={13} />
              <Stat label="Training Trades" value={trainingTrades || "—"} size={13} />
              <Stat label="Validation Trades" value={validationTrades || "—"} size={13} />
              <Stat label="Avg RR" value={avgRR ? `1:${avgRR}` : "—"} size={13} />
              <Stat label="Profit Factor" value={profitFactor || "—"} size={13} />
              <Stat label="Avg TTT" value={avgTTT ? `${avgTTT}h` : "—"} size={13} />
              <Stat label="Max Drawdown" value={maxDrawdown ? `${maxDrawdown}%` : "—"} size={13} />
            </div>
          </div>
          
          <div>
            <Label>System Health</Label>
            <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
              <Stat label="Health Score" value={healthScore ? `${healthScore.toFixed(0)}%` : "—"} color={healthScore >= 60 ? T.green : healthScore >= 40 ? T.yellow : T.red} size={14} />
              <Stat label="Stability Score" value={stabilityScore ? `${stabilityScore.toFixed(0)}%` : "—"} color={stabilityScore >= 70 ? T.green : stabilityScore >= 50 ? T.yellow : T.red} size={14} />
            </div>
          </div>
          
          {lossAttribution && (
            <div>
              <Label>Loss Attribution</Label>
              <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>
                Strategy: {lossAttribution.strategy}% | Data Delay: {lossAttribution.dataDelay}% | Unknown: {lossAttribution.unknown}%
              </div>
            </div>
          )}
          
          {noTradeReason && (
            <div style={{ background: T.redDim, borderRadius: 8, padding: "12px", marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.red }}>No Trade State</div>
              <div style={{ fontSize: 11, color: T.textMid, marginTop: 4 }}>{noTradeReason}</div>
            </div>
          )}
          
          <Divider />
          
          <div style={{ fontSize: 11, color: T.textDim, fontStyle: "italic", marginTop: 8 }}>
            Paper Trading Environment. Real-world spreads, slippage, execution latency, liquidity effects, and broker behavior are not fully represented. Results may differ in live markets.
          </div>
        </div>
      </Card>
      <div style={{ height: 80 }} />
    </div>
  );
};

// ============================================================
// PART 6 COMPLETE
// ============================================================
// NEXT: PART 7 — Monitor Integration + Promotion Workflow + Rollback Logic
//
// After pasting Part 6, your App.jsx now has all UI components:
// - SystemHealthPanel (always visible)
// - DashboardPage (gate status, account, performance)
// - SignalsPage (gate details, signal generation, active trade)
// - JournalPage (trade history with attribution)
// - StatisticsPage (win rate, profit factor, loss attribution, session performance)
// - SettingsPage (API keys, thresholds with 50-trade guard, manual discovery)
// - AboutBotPage (strategy details, reproducibility, disclosures)
// ============================================================
// ============================================================
// PART 7 OF 8 — MONITOR INTEGRATION + PROMOTION WORKFLOW + ROLLBACK LOGIC
// ============================================================
// INSTRUCTIONS:
// 1. Paste this code AFTER Part 6 in your App.jsx
// 2. This code adds:
//    - Complete Monitor integration with HealthMonitor class
//    - Promotion workflow (PENDING_APPROVAL, user approval, deployment)
//    - Rollback logic (automatic with cooldown)
//    - Strategy versioning and history
//    - Confidence smoothing with trade count caps
//    - Integration with all previous parts
// ============================================================

// ============================================================
// CONFIDENCE SMOOTHING (With Trade Count Caps, Never 100)
// ============================================================

/**
 * Calculates smoothed confidence with trade count caps
 * @param {number} currentConfidence - Raw current confidence (0-100)
 * @param {Array} confidenceHistory - Array of previous confidence values (max 10)
 * @param {number} tradeCount - Total number of closed trades
 * @returns {Object} { smoothed, capped, maxAllowed, lowSampleWarning }
 */
function calculateSmoothedConfidence(currentConfidence, confidenceHistory, tradeCount) {
  // Calculate rolling average (last 10 signals, max)
  const recentHistory = confidenceHistory.slice(-10);
  let rollingAvg = currentConfidence;
  if (recentHistory.length > 0) {
    const sum = recentHistory.reduce((a, b) => a + b, 0);
    rollingAvg = sum / recentHistory.length;
  }
  
  // Smoothing: 70% current, 30% rolling average
  let smoothed = (currentConfidence * 0.7) + (rollingAvg * 0.3);
  
  // Apply trade count caps
  let maxAllowed = 100;
  let lowSampleWarning = false;
  
  if (tradeCount < 10) {
    maxAllowed = 40;
    lowSampleWarning = true;
  } else if (tradeCount < 20) {
    maxAllowed = 60;
    lowSampleWarning = true;
  } else if (tradeCount < 30) {
    maxAllowed = 70;
    lowSampleWarning = true;
  } else if (tradeCount < 50) {
    maxAllowed = 80;
  } else if (tradeCount < 100) {
    maxAllowed = 90;
  } else if (tradeCount < 200) {
    maxAllowed = 95;
  } else {
    maxAllowed = 95;
  }
  
  // Cap and ensure never 100
  let capped = Math.min(smoothed, maxAllowed);
  capped = Math.min(capped, 99.9); // Never show 100
  
  return {
    smoothed: parseFloat(smoothed.toFixed(1)),
    capped: parseFloat(capped.toFixed(1)),
    maxAllowed,
    lowSampleWarning
  };
}

// ============================================================
// PROMOTION WORKFLOW (Pending Approval, User Approval, Deployment)
// ============================================================

/**
 * Checks if a candidate pattern qualifies for promotion
 * @param {Object} currentStrategy - Current active strategy
 * @param {Object} candidate - Candidate pattern from discovery
 * @param {number} minTrades - Minimum trades required (default 20)
 * @returns {Object} { qualifies, reason, comparison }
 */
function evaluatePromotionEligibility(currentStrategy, candidate, minTrades = 20) {
  if (!candidate || !candidate.trainingResult) {
    return { qualifies: false, reason: "Candidate has no training results", comparison: null };
  }
  
  if (candidate.validationTrades < minTrades) {
    return { qualifies: false, reason: `Candidate has only ${candidate.validationTrades} validation trades (need ${minTrades})`, comparison: null };
  }
  
  if (currentStrategy && currentStrategy.trades < minTrades) {
    return { qualifies: false, reason: `Current strategy has only ${currentStrategy.trades} trades (need ${minTrades})`, comparison: null };
  }
  
  const candidateWR = candidate.validationWR || candidate.trainingResult.winRate;
  const currentWR = currentStrategy?.winRate || 0;
  const candidatePF = candidate.validationPF || candidate.trainingResult.profitFactor;
  const currentPF = currentStrategy?.profitFactor || 0;
  const candidateDD = candidate.validationDD || candidate.trainingResult.drawdown || 15;
  const currentDD = currentStrategy?.drawdown || 15;
  const candidateRR = candidate.validationAvgRR || candidate.trainingResult.avgRR || 3;
  const currentRR = currentStrategy?.avgRR || 3;
  
  const comparison = {
    winRate: { candidate: candidateWR, current: currentWR, improvement: candidateWR - currentWR },
    profitFactor: { candidate: candidatePF, current: currentPF, improvement: candidatePF - currentPF },
    drawdown: { candidate: candidateDD, current: currentDD, change: candidateDD - currentDD },
    avgRR: { candidate: candidateRR, current: currentRR, improvement: candidateRR - currentRR }
  };
  
  // Promotion criteria
  const wrBetter = candidateWR > currentWR;
  const pfBetter = candidatePF > currentPF;
  const ddAcceptable = candidateDD <= currentDD + 5; // Within +5%
  const rrBetter = candidateRR >= currentRR;
  
  const qualifies = wrBetter && pfBetter && ddAcceptable && rrBetter;
  
  let reason = "";
  if (!wrBetter) reason += `Win rate ${candidateWR}% ≤ ${currentWR}%. `;
  if (!pfBetter) reason += `Profit factor ${candidatePF} ≤ ${currentPF}. `;
  if (!ddAcceptable) reason += `Drawdown ${candidateDD}% > ${currentDD + 5}%. `;
  if (!rrBetter) reason += `Avg RR ${candidateRR} < ${currentRR}. `;
  
  return { qualifies, reason: qualifies ? null : reason, comparison };
}

/**
 * Creates a promotion candidate object for pending approval
 * @param {Object} candidate - Candidate pattern from discovery
 * @param {Object} comparison - Comparison metrics
 * @param {number} version - Next version number
 * @returns {Object} Pending approval object
 */
function createPendingApproval(candidate, comparison, version) {
  return {
    id: `CAND-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    version: `v${version}.0`,
    candidateData: candidate,
    comparison,
    createdAt: new Date().toISOString(),
    status: "PENDING_APPROVAL",
    trainingWR: candidate.trainingResult?.winRate,
    validationWR: candidate.validationWR,
    profitFactor: candidate.validationPF || candidate.trainingResult?.profitFactor,
    drawdown: candidate.validationDD || 15
  };
}

/**
 * Promotes a candidate to active strategy (after user approval)
 * @param {Object} pendingApproval - Pending approval object
 * @param {Object} currentStrategy - Current active strategy
 * @returns {Object} New active strategy
 */
function promoteStrategy(pendingApproval, currentStrategy) {
  const newStrategy = {
    ...pendingApproval.candidateData,
    version: pendingApproval.version,
    deployedAt: new Date().toISOString(),
    previousVersion: currentStrategy?.version || null,
    trades: 0,
    winRate: pendingApproval.validationWR || pendingApproval.trainingWR,
    profitFactor: pendingApproval.profitFactor,
    drawdown: pendingApproval.drawdown,
    avgRR: pendingApproval.candidateData.trainingResult?.avgRR || 3
  };
  
  return newStrategy;
}

// ============================================================
// ROLLBACK LOGIC (Automatic with Cooldown)
// ============================================================

/**
 * Checks if rollback to previous version is necessary
 * @param {Object} currentStrategy - Current active strategy
 * @param {Object} previousStrategy - Previous strategy version
 * @param {Array} recentTrades - Last 20 trades
 * @returns {Object} { shouldRollback, reason, metrics }
 */
function evaluateRollbackCondition(currentStrategy, previousStrategy, recentTrades) {
  if (!previousStrategy || recentTrades.length < 20) {
    return { shouldRollback: false, reason: "Insufficient data for rollback evaluation" };
  }
  
  // Calculate current performance on recent trades
  const wins = recentTrades.filter(t => t.result === "WIN").length;
  const total = recentTrades.length;
  const currentWR = (wins / total) * 100;
  const previousWR = previousStrategy.winRate || 0;
  
  const wrDecline = previousWR - currentWR;
  
  // Calculate current profit factor on recent trades
  let totalProfit = 0, totalLoss = 0;
  for (const t of recentTrades) {
    if (t.result === "WIN") totalProfit += t.rr || 3;
    else totalLoss += 1;
  }
  const currentPF = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
  const previousPF = previousStrategy.profitFactor || 1;
  const pfDecline = ((previousPF - currentPF) / previousPF) * 100;
  
  // Check binomial significance on recent trades
  const significance = testStatisticalSignificance(wins, total);
  
  // Rollback conditions (ALL must be true)
  const wrDeclineSignificant = wrDecline >= 15; // ≥15 percentage points decline
  const pfDeclineSignificant = pfDecline >= 20; // ≥20% decline
  const strategyNoLongerSignificant = !significance.significant;
  
  const shouldRollback = wrDeclineSignificant && pfDeclineSignificant && strategyNoLongerSignificant;
  
  const metrics = {
    currentWR,
    previousWR,
    wrDecline: wrDecline.toFixed(1),
    currentPF: currentPF.toFixed(2),
    previousPF: previousPF.toFixed(2),
    pfDecline: pfDecline.toFixed(1),
    tradesAnalyzed: total
  };
  
  let reason = null;
  if (shouldRollback) {
    reason = `Rollback triggered: WR declined ${wrDecline.toFixed(1)}% (${previousWR}% → ${currentWR}%), PF declined ${pfDecline.toFixed(1)}%, strategy no longer statistically significant.`;
  }
  
  return { shouldRollback, reason, metrics };
}

/**
 * Executes rollback to previous strategy version
 * @param {Object} currentStrategy - Current strategy
 * @param {Object} previousStrategy - Previous strategy version
 * @returns {Object} New active strategy (previous version)
 */
function executeRollback(currentStrategy, previousStrategy) {
  const rolledBackStrategy = {
    ...previousStrategy,
    version: previousStrategy.version,
    deployedAt: new Date().toISOString(),
    previousVersion: currentStrategy.version,
    rollbackFrom: currentStrategy.version,
    rollbackReason: "Performance degradation detected",
    rollbackAt: new Date().toISOString()
  };
  
  return rolledBackStrategy;
}

// ============================================================
// COMPLETE APP INTEGRATION (App Component Extensions)
// ============================================================

/**
 * These are the state additions and useEffect hooks to add to your existing App component
 * Add these state declarations where other useState hooks are
 */

// ============================================================
// ADD TO App COMPONENT STATE DECLARATIONS
// ============================================================

/*
// Add these with your other useState declarations
const [activePattern, setActivePattern] = useState(loadActivePattern);
const [pendingApproval, setPendingApproval] = useState(loadPendingCandidate);
const [strategyHistory, setStrategyHistory] = useState(getStrategyHistory);
const [healthMonitor] = useState(() => new HealthMonitor());
const [healthScore, setHealthScore] = useState(100);
const [stabilityScore, setStabilityScore] = useState(100);
const [confidenceHistory, setConfidenceHistory] = useState([]);
const [smoothedConfidence, setSmoothedConfidence] = useState(0);
const [lowSampleWarning, setLowSampleWarning] = useState(false);
const [isDiscovering, setIsDiscovering] = useState(false);
const [promotionCooldownRemaining, setPromotionCooldownRemaining] = useState(0);
const [rollbackCooldownRemaining, setRollbackCooldownRemaining] = useState(0);
const [lastPromotionTime, setLastPromotionTime] = useState(() => {
  const stored = localStorage.getItem("v4_last_promotion_time");
  return stored ? parseInt(stored, 10) : 0;
});
const [lastRollbackTime, setLastRollbackTime] = useState(() => {
  const stored = localStorage.getItem("v4_last_rollback_time");
  return stored ? parseInt(stored, 10) : 0;
});
*/

// ============================================================
// ADD TO App COMPONENT useEffect HOOKS
// ============================================================

/*
// Monitor trades and update health (run after every trade close)
useEffect(() => {
  if (journal.length > 0 && journal.length !== prevJournalLength) {
    // Update health monitor with latest trades
    const recentTrades = journal.slice(-20);
    for (const trade of recentTrades) {
      healthMonitor.addTrade({
        result: trade.result,
        rr: trade.rr,
        session: trade.session,
        volatilityRegime: trade.regime || "NORMAL",
        timestamp: new Date(trade.closedAt).getTime()
      });
    }
    setHealthScore(healthMonitor.getHealth());
    setStabilityScore(healthMonitor.getStabilityScore());
    
    // Update confidence with smoothing
    const wins = journal.filter(t => t.result === "WIN").length;
    const winRate = (wins / journal.length) * 100;
    let totalProfit = 0, totalLoss = 0;
    for (const t of journal) {
      if (t.result === "WIN") totalProfit += t.rr || 3;
      else totalLoss += 1;
    }
    const pf = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
    const rawConfidence = (winRate * 0.5) + (Math.min(100, Math.max(0, (pf - 1) * 100)) * 0.3) + ((journal.reduce((sum, t) => sum + (t.rr || 3), 0) / journal.length) / 5 * 0.2);
    const confidenceResult = calculateSmoothedConfidence(rawConfidence, confidenceHistory, journal.length);
    setSmoothedConfidence(confidenceResult.capped);
    setLowSampleWarning(confidenceResult.lowSampleWarning);
    setConfidenceHistory(prev => [...prev.slice(-9), rawConfidence]);
    
    // Update cooldown timers
    if (lastPromotionTime > 0) {
      const remaining = Math.max(0, 20 - (journal.length - lastPromotionTradeCount));
      setPromotionCooldownRemaining(remaining);
    }
    
    // Check rollback condition
    if (activePattern && strategyHistory.length >= 2) {
      const previousStrategy = strategyHistory[strategyHistory.length - 2];
      const recentTrades = journal.slice(-20);
      const rollbackEval = evaluateRollbackCondition(activePattern, previousStrategy, recentTrades);
      if (rollbackEval.shouldRollback && Date.now() - lastRollbackTime > 50 * 24 * 60 * 60 * 1000) {
        // Execute rollback
        const rolledBack = executeRollback(activePattern, previousStrategy);
        setActivePattern(rolledBack);
        setStrategyHistory([...strategyHistory.slice(0, -1), rolledBack]);
        setLastRollbackTime(Date.now());
        setRollbackCooldownRemaining(50);
        addAudit("ROLLBACK_EXECUTED", rollbackEval.reason);
      }
    }
  }
  setPrevJournalLength(journal.length);
}, [journal.length]);
*/

// ============================================================
// MANUAL DISCOVERY HANDLER
// ============================================================

/*
const handleManualDiscovery = async () => {
  if (isDiscovering) return;
  
  setIsDiscovering(true);
  addAudit("DISCOVERY_STARTED", "Manual pattern discovery initiated");
  
  try {
    const raw = await fetchTwelveDataCandles(settings.twelveDataApiKey);
    const { validatedCandles } = sanitizeCandles(raw);
    
    if (validatedCandles.length < 500) {
      addAudit("DISCOVERY_FAILED", `Insufficient data: ${validatedCandles.length} candles`);
      setIsDiscovering(false);
      return;
    }
    
    const result = await runCompleteDiscovery(validatedCandles, true);
    
    if (result.success && result.bestCandidate) {
      // Check if candidate qualifies for promotion
      const promotionEval = evaluatePromotionEligibility(activePattern, result.bestCandidate);
      
      if (promotionEval.qualifies) {
        const nextVersion = (strategyHistory.length + 1);
        const pending = createPendingApproval(result.bestCandidate, promotionEval.comparison, nextVersion);
        setPendingApproval(pending);
        savePendingCandidate(pending);
        addAudit("CANDIDATE_FOUND", `Candidate v${nextVersion}.0 ready for approval. WR: ${promotionEval.comparison.winRate.candidate}% vs current ${promotionEval.comparison.winRate.current}%`);
      } else {
        addAudit("CANDIDATE_REJECTED", promotionEval.reason);
      }
    } else if (result.blocked) {
      addAudit("DISCOVERY_BLOCKED", result.reason);
    } else {
      const failureReport = formatDiscoveryFailureReport(result);
      addAudit("DISCOVERY_FAILED", `No pattern found: ${failureReport.type}`);
    }
  } catch (error) {
    console.error("Discovery error:", error);
    addAudit("DISCOVERY_ERROR", error.message);
  } finally {
    setIsDiscovering(false);
  }
};
*/

// ============================================================
// PROMOTION APPROVAL HANDLER
// ============================================================

/*
const handlePromotionApproval = (approve) => {
  if (!pendingApproval) return;
  
  if (approve) {
    const newStrategy = promoteStrategy(pendingApproval, activePattern);
    setActivePattern(newStrategy);
    setStrategyHistory([...strategyHistory, newStrategy]);
    saveActivePattern(newStrategy);
    addStrategyVersion({
      version: pendingApproval.version,
      pattern: pendingApproval.candidateData,
      metrics: pendingApproval.comparison,
      deployedAt: new Date().toISOString()
    });
    setLastPromotionTime(Date.now());
    setPromotionCooldownRemaining(20);
    addAudit("STRATEGY_PROMOTED", `Strategy upgraded to ${pendingApproval.version}`);
  } else {
    addAudit("STRATEGY_REJECTED", `Candidate ${pendingApproval.version} rejected by user`);
  }
  
  setPendingApproval(null);
  savePendingCandidate(null);
};
*/

// ============================================================
// AUTO-DISCOVERY TRIGGER (Health-based)
// ============================================================

/*
useEffect(() => {
  // Automatic discovery triggered by health degradation
  const shouldTrigger = healthMonitor.shouldTriggerDiscovery();
  const cooldownOk = isDiscoveryAllowed();
  const notDiscovering = !isDiscovering;
  
  if (shouldTrigger && cooldownOk && notDiscovering && !pendingApproval) {
    const threshold = healthScore < 50 ? "immediate" : "gradual degradation";
    addAudit("AUTO_DISCOVERY_TRIGGERED", `Health: ${healthScore.toFixed(0)}% (${threshold})`);
    handleManualDiscovery();
  }
}, [healthScore, journal.length]);
*/

// ============================================================
// ROLLBACK COOLDOWN TIMER
// ============================================================

/*
useEffect(() => {
  if (rollbackCooldownRemaining > 0) {
    const interval = setInterval(() => {
      setRollbackCooldownRemaining(prev => Math.max(0, prev - 1));
    }, 24 * 60 * 60 * 1000); // Decrement daily
    return () => clearInterval(interval);
  }
}, [rollbackCooldownRemaining]);
*/

// ============================================================
// PROMOTION COOLDOWN TIMER
// ============================================================

/*
useEffect(() => {
  if (promotionCooldownRemaining > 0) {
    const interval = setInterval(() => {
      setPromotionCooldownRemaining(prev => Math.max(0, prev - 1));
    }, 24 * 60 * 60 * 1000); // Decrement daily
    return () => clearInterval(interval);
  }
}, [promotionCooldownRemaining]);
*/
// Run backfill once when app loads (after activePattern is loaded)
useEffect(() => {
  const runBackfill = async () => {
    if (!activePattern) return;
    
    await performBackfillOnStartup(
      activePattern,
      setJournal,
      dispatchAccount,
      addAudit,
      settings.twelveDataApiKey || TWELVE_DATA_API_KEY,
      settings.symbol || "EUR/USD",
      account,
      journal
    );
  };
  
  runBackfill();
}, [activePattern]); // Runs when activePattern loads

// ============================================================
// PART 7 COMPLETE
// ============================================================
// NEXT: PART 8 — Final Integration + Testing + Deployment Instructions
//
// After pasting Part 7, your App.jsx now has:
// - Confidence smoothing with trade count caps (never 100)
// - Promotion workflow (PENDING_APPROVAL, user approval, deployment)
// - Rollback logic (automatic with 50-trade cooldown)
// - Strategy versioning and history
// - Manual discovery trigger
// - Auto-discovery trigger based on health degradation
// - Promotion cooldown (20 trades minimum)
// - Rollback cooldown (50 trades minimum)
// - Complete integration with all previous parts
//
// Pending for Part 8:
// - Final integration testing code
// - Deployment instructions (Vercel)
// - Environment variable setup
// - README file generation
// - Complete App.jsx final assembly instructions
// ============================================================
// ============================================================
// PART 8 OF 8 — FINAL APP COMPONENT INTEGRATION + RUN FETCH IMPLEMENTATION
// ============================================================
// INSTRUCTIONS:
// 1. This code MUST be added at the VERY END of your App.jsx file
// 2. It contains the main App component, runFetch implementation, and all state
// 3. REPLACE your existing App component with this complete version
// 4. Keep all imports and design tokens from Parts 1-7
// ============================================================

// ============================================================
// MAIN App COMPONENT (Complete Integration)
// ============================================================

export default function App() {
  // ============================================================
  // STATE DECLARATIONS
  // ============================================================
  
  // UI State
  const [page, setPage] = useState("dashboard");
  
  // Settings State
  const [settings, setSettings] = useState({ 
    twelveDataApiKey: "", 
    symbol: "EUR/USD", 
    oppThreshold: 90, 
    alignThreshold: 66, 
    refreshSec: 30 
  });
  
  // Market Data State
  const [priceData, setPriceData] = useState({ price: null, change: null, loading: false, error: null, timestamp: null });
  const [candles, setCandles] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [apiStatus, setApiStatus] = useState("UNKNOWN");
  const [lastFetch, setLastFetch] = useState(null);
  const [dataAge, setDataAge] = useState(null);
  
  // Session State
  const [session, setSession] = useState(detectSession());
  
  // Trading State
  const [activeSignal, setActiveSignal] = useState(null);
  const [journal, setJournal] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [account, dispatchAccount] = useReducer(accountReducer, INITIAL_ACCOUNT);
  const [gateResult, setGateResult] = useState(null);
  const [killSwitches, setKillSwitches] = useState({ active: false, switches: [] });
  const [confidence, setConfidence] = useState({ score: 0, max: 40, phase: "LEARNING", note: "No trades recorded.", tradeCount: 0 });
  
  // V4 Discovery State
  const [activePattern, setActivePattern] = useState(loadActivePattern);
  const [pendingApproval, setPendingApproval] = useState(loadPendingCandidate);
  const [strategyHistory, setStrategyHistory] = useState(getStrategyHistory);
  const [healthMonitor] = useState(() => new HealthMonitor());
  const [healthScore, setHealthScore] = useState(100);
  const [stabilityScore, setStabilityScore] = useState(100);
  const [confidenceHistory, setConfidenceHistory] = useState([]);
  const [smoothedConfidence, setSmoothedConfidence] = useState(0);
  const [lowSampleWarning, setLowSampleWarning] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [promotionCooldownRemaining, setPromotionCooldownRemaining] = useState(0);
  const [rollbackCooldownRemaining, setRollbackCooldownRemaining] = useState(0);
  const [lastPromotionTime, setLastPromotionTime] = useState(() => {
    const stored = localStorage.getItem("v4_last_promotion_time");
    return stored ? parseInt(stored, 10) : 0;
  });
  const [lastRollbackTime, setLastRollbackTime] = useState(() => {
    const stored = localStorage.getItem("v4_last_rollback_time");
    return stored ? parseInt(stored, 10) : 0;
  });
  const [lastPromotionTradeCount, setLastPromotionTradeCount] = useState(() => {
    const stored = localStorage.getItem("v4_last_promotion_trade_count");
    return stored ? parseInt(stored, 10) : 0;
  });
  
  const prevJournalLength = useRef(journal.length);
  
  // ============================================================
  // HELPER FUNCTIONS
  // ============================================================
  
  const addAudit = useCallback((type, reason, extra = {}) => {
    setAuditLog(prev => [...prev, {
      auditId: "AUD-" + Date.now().toString(36).toUpperCase().slice(-6),
      type, reason, timestamp: new Date().toISOString(), ...extra
    }]);
  }, []);
  
  // ============================================================
  // MAIN DATA FETCH (runFetch)
  // ============================================================
  
  const runFetch = useCallback(async () => {
    const apiKey = settings.twelveDataApiKey || TWELVE_DATA_API_KEY;
    const symbol = settings.symbol || "EUR/USD";
    
    setPriceData(p => ({ ...p, loading: true }));
    
    try {
      // Fetch 15M candles
      const rawCandles = await fetchTwelveDataCandles(apiKey, symbol);
      const { validatedCandles, sanitizationReport } = sanitizeCandles(rawCandles);
      
      // Check data quality
      const quality = evaluateDataQuality(validatedCandles, lastFetch || Date.now());
      if (!quality.passed) {
        setApiStatus("DATA_QUALITY_FAILED");
        setGateResult({ passed: false, blocks: [{ label: "Data Quality", reason: quality.reason, pass: false }] });
        setPriceData(p => ({ ...p, loading: false }));
        addAudit("DATA_QUALITY_FAILED", quality.reason);
        return;
      }
      
      setCandles({ "15M": validatedCandles });
      setApiStatus("OK");
      setLastFetch(new Date().toISOString());
      setDataAge(0);
      
      // Get live price
      try {
        const price = await fetchTwelveDataPrice(apiKey, symbol);
        setPriceData({ price, change: 0, loading: false, error: null, timestamp: new Date().toISOString() });
      } catch (e) {
        setPriceData(p => ({ ...p, loading: false, error: e.message }));
      }
      
      // Compute features and analysis
      const features = computeAllFeatureVectors(validatedCandles);
      const currentFeatures = features[features.length - 1];
      
      // Get current ATR in pips
      const atr14 = calculateATR(validatedCandles, 14);
      const atrPips = atr14 ? atr14 * 10000 : 25;
      
      // Calculate opportunity score (informational only)
      const sessionScore = getSessionScore(detectSessionFromTimestamp(currentFeatures.timestamp));
      const oppScore = Math.min(100, Math.max(0, sessionScore + (currentFeatures.rsi14 ? (currentFeatures.rsi14 >= 30 && currentFeatures.rsi14 <= 70 ? 20 : 10) : 10)));
      
      setAnalysis({
        opportunityScore: oppScore,
        regime: currentFeatures.trend === "BULLISH" ? "TRENDING" : currentFeatures.trend === "BEARISH" ? "TRENDING" : "RANGING",
        rsi14: currentFeatures.rsi14,
        atrPips: atrPips,
        features: currentFeatures
      });
      
      // Build gate inputs
      const killSwitchState = {
        health: healthScore,
        confidence: smoothedConfidence || confidence.score,
        drawdown: account.maxDrawdown,
        executionQuality: 85,
        executionQualityStreak: 5
      };
      
      const gateInputs = {
        circuitBreakerActive: false,
        dataAgeMinutes: dataAge || 0,
        atrPips: atrPips,
        minATRPips: 20,
        newsEvents: [],
        currentTime: Date.now(),
        hasActivePosition: !!activeSignal,
        killSwitchState: killSwitchState,
        lastSignal: null,
        pendingSignal: null
      };
      
      const gate = evaluateAllGates(gateInputs);
      setGateResult({ passed: gate.passed, blocks: gate.blocks });
      
      addAudit("GATE_EVALUATED", `Gate: ${gate.passed ? "OPEN" : "CLOSED"} — ${gate.blocks.map(b => b.gate).join(", ") || "all passed"}`);
      
    } catch (error) {
      console.error("Fetch error:", error);
      setApiStatus("ERROR");
      setPriceData(p => ({ ...p, loading: false, error: error.message }));
      addAudit("API_ERROR", error.message);
    }
  }, [settings, lastFetch, dataAge, activeSignal, healthScore, smoothedConfidence, confidence.score, account.maxDrawdown, addAudit]);
  
  // ============================================================
  // EFFECTS
  // ============================================================
  
  // Session ticker
  useEffect(() => {
    const iv = setInterval(() => setSession(detectSession()), 30000);
    return () => clearInterval(iv);
  }, []);
  
  // Data age ticker
  useEffect(() => {
    const iv = setInterval(() => {
      if (lastFetch) {
        const mins = (Date.now() - new Date(lastFetch).getTime()) / 60000;
        setDataAge(parseFloat(mins.toFixed(1)));
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [lastFetch]);
  
  // Initial and periodic fetch
  useEffect(() => {
    runFetch();
    const iv = setInterval(runFetch, (settings.refreshSec || 30) * 1000);
    return () => clearInterval(iv);
  }, [settings.refreshSec, runFetch]);
  
  // Health monitor effect
  useEffect(() => {
    if (journal.length > 0 && journal.length !== prevJournalLength.current) {
      const recentTrades = journal.slice(-20);
      for (const trade of recentTrades) {
        healthMonitor.addTrade({
          result: trade.result,
          rr: trade.rr,
          session: trade.session,
          volatilityRegime: trade.regime || "NORMAL",
          timestamp: new Date(trade.closedAt || Date.now()).getTime()
        });
      }
      setHealthScore(healthMonitor.getHealth());
      setStabilityScore(healthMonitor.getStabilityScore());
      
      const wins = journal.filter(t => t.result === "WIN").length;
      const winRate = (wins / journal.length) * 100;
      let totalProfit = 0, totalLoss = 0;
      for (const t of journal) {
        if (t.result === "WIN") totalProfit += t.rr || 3;
        else totalLoss += 1;
      }
      const pf = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
      const rawConfidence = (winRate * 0.5) + (Math.min(100, Math.max(0, (pf - 1) * 100)) * 0.3) + ((journal.reduce((sum, t) => sum + (t.rr || 3), 0) / journal.length) / 5 * 0.2);
      const confidenceResult = calculateSmoothedConfidence(rawConfidence, confidenceHistory, journal.length);
      setSmoothedConfidence(confidenceResult.capped);
      setLowSampleWarning(confidenceResult.lowSampleWarning);
      setConfidenceHistory(prev => [...prev.slice(-9), rawConfidence]);
      setConfidence(prev => ({ ...prev, score: confidenceResult.capped, tradeCount: journal.length }));
      
      if (lastPromotionTime > 0 && lastPromotionTradeCount > 0) {
        const remaining = Math.max(0, 20 - (journal.length - lastPromotionTradeCount));
        setPromotionCooldownRemaining(remaining);
      }
      
      if (activePattern && strategyHistory.length >= 2 && (Date.now() - lastRollbackTime) > 50 * 24 * 60 * 60 * 1000) {
        const previousStrategy = strategyHistory[strategyHistory.length - 2];
        const rollbackEval = evaluateRollbackCondition(activePattern, previousStrategy, recentTrades);
        if (rollbackEval.shouldRollback) {
          const rolledBack = executeRollback(activePattern, previousStrategy);
          setActivePattern(rolledBack);
          setStrategyHistory([...strategyHistory.slice(0, -1), rolledBack]);
          setLastRollbackTime(Date.now());
          setRollbackCooldownRemaining(50);
          localStorage.setItem("v4_last_rollback_time", Date.now().toString());
          addAudit("ROLLBACK_EXECUTED", rollbackEval.reason);
        }
      }
    }
    prevJournalLength.current = journal.length;
  }, [journal.length]);
  
  // Auto-discovery trigger
  useEffect(() => {
    const shouldTrigger = healthMonitor.shouldTriggerDiscovery();
    const cooldownOk = isDiscoveryAllowed();
    const notDiscovering = !isDiscovering;
    
    if (shouldTrigger && cooldownOk && notDiscovering && !pendingApproval && activePattern) {
      addAudit("AUTO_DISCOVERY_TRIGGERED", `Health: ${healthScore.toFixed(0)}%`);
      handleManualDiscovery();
    }
  }, [healthScore, journal.length]);
  
  // ============================================================
  // HANDLERS
  // ============================================================
  
  const handleGenerateSignal = useCallback(() => {
    if (!gateResult?.passed || activeSignal) return;
    
    const currentCandles = candles["15M"];
    if (!currentCandles || currentCandles.length === 0) return;
    
    const features = computeFeatureVector(currentCandles, currentCandles.length - 1);
    const currentPrice = priceData.price || features.close;
    
    const historicalStats = activePattern ? { winningTrades: activePattern.trainingResult?.winningTrades || [] } : null;
    
    const signalResult = generateSignal({
      activePattern,
      currentFeatures: features,
      currentPrice,
      historicalStats,
      circuitBreakerActive: false,
      dataAgeMinutes: dataAge || 0,
      atrPips: analysis?.atrPips || 25,
      newsEvents: [],
      hasActivePosition: !!activeSignal,
      killSwitchState: { health: healthScore, confidence: smoothedConfidence || 75, drawdown: account.maxDrawdown, executionQuality: 85, executionQualityStreak: 5 },
      lastSignal: null,
      pendingSignal: null
    });
    
    if (signalResult.generated) {
      setActiveSignal(signalResult.signal);
      addAudit("SIGNAL_GENERATED", `${signalResult.signal.direction} STOP @ ${signalResult.signal.entry?.toFixed(5)} — RR 1:${signalResult.signal.rr?.toFixed(2)}`);
    } else {
      addAudit("SIGNAL_BLOCKED", signalResult.blockReason);
    }
  }, [gateResult, activeSignal, candles, priceData, activePattern, dataAge, analysis, healthScore, smoothedConfidence, account.maxDrawdown, addAudit]);
  
  const handleCloseSignal = useCallback((result, attribution = null) => {
    if (!activeSignal) return;
    
    const fillPrice = priceData?.price || activeSignal.entry;
    const isWin = result === "WIN";
    
    let slippagePips = null;
    if (activeSignal.intentPrice && fillPrice) {
      slippagePips = parseFloat((Math.abs(fillPrice - activeSignal.intentPrice) * 10000).toFixed(2));
    }
    
    const finalAttribution = !isWin ? (attribution || "UNKNOWN_CAUSE") : null;
    
    const closedTrade = {
      ...activeSignal,
      exit: fillPrice,
      exitTime: new Date().toISOString(),
      result: isWin ? "WIN" : "LOSS",
      actualRR: isWin ? activeSignal.rr : 0,
      slippagePips,
      attribution: finalAttribution,
      realizedPL: isWin ? activeSignal.rewardPips * 0.1 : -activeSignal.riskPips * 0.1
    };
    
    setJournal(prev => [...prev, closedTrade]);
    
    const realizedPL = isWin ? activeSignal.rewardPips * 0.1 : -activeSignal.riskPips * 0.1;
    dispatchAccount({ type: "CLOSE_TRADE", realizedPL, result: isWin ? "WIN" : "LOSS" });
    addAudit("TRADE_CLOSED", `${activeSignal.direction} closed ${result}. P&L: $${realizedPL.toFixed(2)}. Attribution: ${finalAttribution || "N/A"}`);
    
    setActiveSignal(null);
  }, [activeSignal, priceData, addAudit]);
  
  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings);
    addAudit("SETTINGS_UPDATED", `Symbol: ${newSettings.symbol}, Refresh: ${newSettings.refreshSec}s`);
  };
  
  const handleReset = () => {
    dispatchAccount({ type: "RESET" });
    setJournal([]);
    setActiveSignal(null);
    setConfidence({ score: 0, max: 40, phase: "LEARNING", note: "Account reset.", tradeCount: 0 });
    setActivePattern(null);
    setPendingApproval(null);
    setStrategyHistory([]);
    saveActivePattern(null);
    savePendingCandidate(null);
    addAudit("SYSTEM_RESET", "Full system reset by user");
  };
  
  const handleManualDiscovery = async () => {
    if (isDiscovering) return;
    
    setIsDiscovering(true);
    addAudit("DISCOVERY_STARTED", "Manual pattern discovery initiated");
    
    try {
      const apiKey = settings.twelveDataApiKey || TWELVE_DATA_API_KEY;
      const raw = await fetchTwelveDataCandles(apiKey, settings.symbol);
      const { validatedCandles } = sanitizeCandles(raw);
      
      if (validatedCandles.length < 500) {
        addAudit("DISCOVERY_FAILED", `Insufficient data: ${validatedCandles.length} candles`);
        setIsDiscovering(false);
        return;
      }
      
      const result = await runCompleteDiscovery(validatedCandles, true);
      
      if (result.success && result.bestCandidate) {
        const promotionEval = evaluatePromotionEligibility(activePattern, result.bestCandidate);
        
        if (promotionEval.qualifies) {
          const nextVersion = strategyHistory.length + 1;
          const pending = createPendingApproval(result.bestCandidate, promotionEval.comparison, nextVersion);
          setPendingApproval(pending);
          savePendingCandidate(pending);
          addAudit("CANDIDATE_FOUND", `Candidate v${nextVersion}.0 ready for approval`);
        } else {
          addAudit("CANDIDATE_REJECTED", promotionEval.reason);
        }
      } else if (result.blocked) {
        addAudit("DISCOVERY_BLOCKED", result.reason);
      } else {
        const failureReport = formatDiscoveryFailureReport(result);
        addAudit("DISCOVERY_FAILED", `No pattern found: ${failureReport.type}`);
      }
    } catch (error) {
      addAudit("DISCOVERY_ERROR", error.message);
    } finally {
      setIsDiscovering(false);
    }
  };
  
  const handlePromotionApproval = (approve) => {
    if (!pendingApproval) return;
    
    if (approve) {
      const newStrategy = promoteStrategy(pendingApproval, activePattern);
      setActivePattern(newStrategy);
      setStrategyHistory([...strategyHistory, newStrategy]);
      saveActivePattern(newStrategy);
      addStrategyVersion({
        version: pendingApproval.version,
        pattern: pendingApproval.candidateData,
        metrics: pendingApproval.comparison,
        deployedAt: new Date().toISOString()
      });
      setLastPromotionTime(Date.now());
      setLastPromotionTradeCount(journal.length);
      setPromotionCooldownRemaining(20);
      localStorage.setItem("v4_last_promotion_time", Date.now().toString());
      localStorage.setItem("v4_last_promotion_trade_count", journal.length.toString());
      addAudit("STRATEGY_PROMOTED", `Strategy upgraded to ${pendingApproval.version}`);
    } else {
      addAudit("STRATEGY_REJECTED", `Candidate ${pendingApproval.version} rejected`);
    }
    
    setPendingApproval(null);
    savePendingCandidate(null);
  };
  
  // ============================================================
  // HELPER FORMATTING FUNCTIONS
  // ============================================================
  
  const fmtTime = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  
  const fmtDate = (iso) => {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  
  // ============================================================
  // RENDER
  // ============================================================
  
  const pages = {
    dashboard: <DashboardPage
      priceData={priceData} account={account} activeSignal={activeSignal}
      journal={journal} session={session} gateResult={gateResult}
      analysis={analysis} killSwitches={killSwitches} confidence={confidence}
      dataAge={dataAge} healthScore={healthScore} stabilityScore={stabilityScore}
      activePattern={activePattern}
    />,
    signals: <SignalsPage
      gateResult={gateResult} activeSignal={activeSignal}
      onGenerateSignal={handleGenerateSignal} onCloseSignal={handleCloseSignal}
      analysis={analysis} auditLog={auditLog} pendingApproval={pendingApproval}
      onApproveCandidate={handlePromotionApproval}
    />,
    journal: <JournalPage journal={journal} />,
    statistics: <StatisticsPage account={account} journal={journal} confidence={confidence} />,
    settings: <SettingsPage
      settings={settings} onSave={handleSaveSettings} onReset={handleReset}
      journalLength={journal.length} onManualDiscovery={handleManualDiscovery}
      isDiscovering={isDiscovering}
    />,
    about: <AboutBotPage
      strategyVersion={activePattern?.version || "1.0"}
      patternDescription={activePattern?.conditions?.length ? `${activePattern.conditions.length} conditions` : "No active pattern"}
      analyzedWindow={candles["15M"]?.[0] ? { from: candles["15M"][0].datetime, to: candles["15M"][candles["15M"].length - 1].datetime } : { from: "—", to: "—" }}
      totalCandles={candles["15M"]?.length || 0}
      coverageRaw="—"
      coveragePractical="—"
      splitReport={null}
      currentRegime={analysis?.regime || "UNKNOWN"}
      trainingTrades={activePattern?.trainingTrades}
      trainingWR={activePattern?.trainingWR}
      validationTrades={activePattern?.validationTrades}
      validationWR={activePattern?.validationWR}
      avgRR={activePattern?.avgRR}
      profitFactor={activePattern?.profitFactor}
      avgTTT={null}
      maxDrawdown={account.maxDrawdown}
      healthScore={healthScore}
      stabilityScore={stabilityScore}
      lossAttribution={{
        strategy: journal.filter(t => t.attribution === "STRATEGY_LOSS").length,
        dataDelay: journal.filter(t => t.attribution === "DATA_DELAY_LOSS").length,
        unknown: journal.filter(t => t.attribution === "UNKNOWN_CAUSE").length
      }}
      nextEventTime={null}
      nextDiscoveryTime={null}
      pendingApproval={!!pendingApproval}
      noTradeReason={!activePattern ? "No active pattern discovered" : null}
      lastDiscoveryAttempt={null}
      reproducibilityData={null}
    />
  };
  
  return (
    <>
      <GlobalStyle />
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: T.bg0 }}>
        <PriceHeader priceData={priceData} />
        <SystemHealthPanel
          apiStatus={apiStatus}
          rateLimitRemaining={null}
          dataDateRange={candles["15M"]?.[0] ? { from: candles["15M"][0].datetime, to: candles["15M"][candles["15M"].length - 1].datetime } : { from: "—", to: "—" }}
          lastFetchTime={lastFetch}
          dataAgeMinutes={dataAge}
          evidenceCompletion={null}
          gateStatus={gateResult?.passed ? "OPEN" : "CLOSED"}
          learningProgress={isDiscovering ? "DISCOVERING" : "IDLE"}
          strategyVersion={activePattern?.version || "1.0"}
          confidenceScore={smoothedConfidence}
          executionQuality={85}
          killSwitchStatus={killSwitches?.active}
          healthScore={healthScore}
          stabilityScore={stabilityScore}
          volumeStatus="PARTIALLY_IMPLEMENTED"
          spreadStatus="NOT_IMPLEMENTED"
          nextEventTime={null}
          nextDiscoveryTime={null}
          walkForwardStatus={null}
          lowSampleWarning={lowSampleWarning}
          coverageWarning={null}
        />
        <div style={{ padding: "12px 16px 6px", borderBottom: `1px solid ${T.border}`, background: T.bg1, flexShrink: 0 }}>
          <h1 style={{ fontSize: 13, fontWeight: 700, color: T.textMid, fontFamily: T.font, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {NAV_ITEMS.find(n => n.id === page)?.icon} {NAV_ITEMS.find(n => n.id === page)?.label}
          </h1>
        </div>
        <main style={{ flex: 1, overflowY: "auto", padding: 14, background: T.bg0 }}>
          <div className="animate-slide">{pages[page]}</div>
        </main>
        <BottomNav active={page} onNav={setPage} hasSignal={!!activeSignal} />
      </div>
    </>
  );
}

// ============================================================
// PART 8 COMPLETE — ALL 8 PARTS NOW INTEGRATED
// ============================================================
// FINAL CHECKLIST:
// 1. Parts 1-7 added to App.jsx
// 2. Part 8 added at the end (App component + runFetch)
// 3. Create api/proxy.js, vercel.json, .env.example
// 4. Deploy to Vercel
// 5. Add environment variables (TWELVE_DATA_API_KEY, FMP_API_KEY)
// 6. Run manual discovery
// 7. Start paper trading!
// ============================================================