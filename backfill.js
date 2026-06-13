// ============================================================
// backfill.js — Historical Backfill & Missed Trade Recovery
// ============================================================
// This module recovers trades that would have triggered while the bot was closed.
// It runs automatically when the app starts and detects time gaps > 1 hour.
// ============================================================

// Storage keys for backfill state
const BACKFILL_STORAGE_KEYS = {
  LAST_OPEN_TIMESTAMP: "v4_last_open_timestamp",
  LAST_BALANCE: "v4_last_known_balance",
  LAST_JOURNAL_COUNT: "v4_last_journal_count"
};

/**
 * Saves current state for future backfill
 * @param {Object} account - Current account state
 * @param {Array} journal - Current journal entries
 */
export function saveBackfillState(account, journal) {
  localStorage.setItem(BACKFILL_STORAGE_KEYS.LAST_OPEN_TIMESTAMP, Date.now().toString());
  localStorage.setItem(BACKFILL_STORAGE_KEYS.LAST_BALANCE, account.balance.toString());
  localStorage.setItem(BACKFILL_STORAGE_KEYS.LAST_JOURNAL_COUNT, journal.length.toString());
}

/**
 * Gets last saved backfill state
 * @returns {Object} { lastOpenTimestamp, lastBalance, lastJournalCount }
 */
function getLastBackfillState() {
  const timestamp = localStorage.getItem(BACKFILL_STORAGE_KEYS.LAST_OPEN_TIMESTAMP);
  const balance = localStorage.getItem(BACKFILL_STORAGE_KEYS.LAST_BALANCE);
  const journalCount = localStorage.getItem(BACKFILL_STORAGE_KEYS.LAST_JOURNAL_COUNT);
  
  return {
    lastOpenTimestamp: timestamp ? parseInt(timestamp, 10) : null,
    lastBalance: balance ? parseFloat(balance) : null,
    lastJournalCount: journalCount ? parseInt(journalCount, 10) : 0
  };
}

/**
 * Simulates a trade from historical candles (for backfill)
 * @param {Object} pattern - Active pattern
 * @param {Object} entryFeatures - Feature vector at entry
 * @param {number} entryIndex - Index of entry candle
 * @param {Array} candles - All candles in the period
 * @param {Object} entrySLTP - Entry, SL, TP values
 * @param {number} holdingPeriodCandles - Max candles to hold (default 16 = 4 hours)
 * @returns {Object} { result, exitPrice, exitIndex, actualRR, profitPips }
 */
function simulateHistoricalTrade(pattern, entryFeatures, entryIndex, candles, entrySLTP, holdingPeriodCandles = 16) {
  const entry = entrySLTP.entry;
  const sl = entrySLTP.sl;
  const tp = entrySLTP.tp;
  const direction = entrySLTP.direction;
  
  let hitTP = false;
  let hitSL = false;
  let exitIndex = entryIndex;
  let maxPrice = entry;
  let minPrice = entry;
  
  const maxIndex = Math.min(entryIndex + holdingPeriodCandles, candles.length - 1);
  
  for (let i = entryIndex; i <= maxIndex; i++) {
    const candle = candles[i];
    maxPrice = Math.max(maxPrice, candle.high);
    minPrice = Math.min(minPrice, candle.low);
    
    if (direction === "BUY") {
      if (maxPrice >= tp) {
        hitTP = true;
        exitIndex = i;
        break;
      }
      if (minPrice <= sl) {
        hitSL = true;
        exitIndex = i;
        break;
      }
    } else {
      if (minPrice <= tp) {
        hitTP = true;
        exitIndex = i;
        break;
      }
      if (maxPrice >= sl) {
        hitSL = true;
        exitIndex = i;
        break;
      }
    }
  }
  
  let result = "INCONCLUSIVE";
  let exitPrice = null;
  let actualRR = 0;
  let profitPips = 0;
  
  if (hitTP && !hitSL) {
    result = "WIN";
    exitPrice = tp;
    const riskPips = Math.abs(entry - sl) * 10000;
    const rewardPips = Math.abs(tp - entry) * 10000;
    actualRR = rewardPips / riskPips;
    profitPips = rewardPips;
  } else if (hitSL && !hitTP) {
    result = "LOSS";
    exitPrice = sl;
    const riskPips = Math.abs(entry - sl) * 10000;
    actualRR = -1;
    profitPips = -riskPips;
  } else {
    result = "OPEN";
    exitPrice = candles[candles.length - 1].close;
    const currentPips = direction === "BUY" 
      ? (exitPrice - entry) * 10000
      : (entry - exitPrice) * 10000;
    profitPips = currentPips;
    actualRR = profitPips / (Math.abs(entry - sl) * 10000);
  }
  
  return {
    result,
    exitPrice,
    exitIndex,
    actualRR,
    profitPips,
    entry,
    sl,
    tp,
    direction
  };
}

/**
 * Main backfill function — call this when app starts
 * @param {Object} activePattern - Current active strategy
 * @param {Function} setJournal - State setter for journal
 * @param {Function} dispatchAccount - Reducer dispatcher for account
 * @param {Function} addAudit - Audit logger
 * @param {string} apiKey - Twelve Data API key
 * @param {string} symbol - Trading symbol
 * @param {Object} currentAccount - Current account state
 * @param {Array} currentJournal - Current journal entries
 * @returns {Promise<boolean>} Whether backfill was performed
 */
export async function performBackfillOnStartup(
  activePattern, 
  setJournal, 
  dispatchAccount, 
  addAudit, 
  apiKey, 
  symbol,
  currentAccount,
  currentJournal
) {
  const { lastOpenTimestamp, lastBalance, lastJournalCount } = getLastBackfillState();
  
  // No previous state — first run
  if (!lastOpenTimestamp) {
    saveBackfillState(currentAccount, currentJournal);
    return false;
  }
  
  const now = Date.now();
  const timeDiffMs = now - lastOpenTimestamp;
  const hoursMissed = timeDiffMs / (60 * 60 * 1000);
  
  // Only backfill if more than 1 hour has passed
  if (timeDiffMs < 60 * 60 * 1000) {
    saveBackfillState(currentAccount, currentJournal);
    return false;
  }
  
  // No active pattern — nothing to backfill
  if (!activePattern || !activePattern.conditions) {
    saveBackfillState(currentAccount, currentJournal);
    return false;
  }
  
  addAudit("BACKFILL_STARTED", `Bot was closed for ${hoursMissed.toFixed(1)} hours. Checking for missed trades...`);
  
  try {
    // Fetch latest candles
    const fetchUrl = `/api/td/time_series?symbol=${symbol || "EUR/USD"}&interval=15min&outputsize=5000&format=JSON&order=ASC&apikey=${apiKey}`;
    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === "error") throw new Error(data.message);
    if (!data.values || !Array.isArray(data.values)) throw new Error("Invalid response");
    
    // Parse and sanitize candles
    const candles = [];
    for (const c of data.values) {
      const open = parseFloat(c.open);
      const high = parseFloat(c.high);
      const low = parseFloat(c.low);
      const close = parseFloat(c.close);
      if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
      if (high < low) continue;
      candles.push({
        datetime: c.datetime,
        timestamp: new Date(c.datetime).getTime(),
        open, high, low, close
      });
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);
    
    if (candles.length === 0) {
      addAudit("BACKFILL_FAILED", "No candle data available");
      saveBackfillState(currentAccount, currentJournal);
      return false;
    }
    
    // Compute features
    const features = [];
    for (let i = 0; i < candles.length; i++) {
      features.push(computeFeatureVector(candles, i));
    }
    
    let newTrades = [];
    let balanceAdjustment = 0;
    let existingSignalIds = new Set(currentJournal.map(t => t.id));
    
    // Scan for missed signals
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      const matches = matchesPattern(feature, activePattern.conditions);
      if (!matches) continue;
      
      // Determine direction
      let direction = "BUY";
      if (feature.trend === "BEARISH") direction = "SELL";
      else if (feature.trend === "BULLISH") direction = "BUY";
      else direction = feature.higherHigh && feature.higherLow ? "BUY" : "SELL";
      
      const entryPrice = feature.close;
      const riskPips = 30;
      const rewardPips = riskPips * 3;
      const riskAmount = riskPips * 0.0001;
      const rewardAmount = rewardPips * 0.0001;
      
      let sl, tp;
      if (direction === "BUY") {
        sl = entryPrice - riskAmount;
        tp = entryPrice + rewardAmount;
      } else {
        sl = entryPrice + riskAmount;
        tp = entryPrice - rewardAmount;
      }
      
      const tradeResult = simulateHistoricalTrade(activePattern, feature, i, candles, {
        entry: entryPrice, sl, tp, direction, rr: 3, riskPips, rewardPips, valid: true
      }, 16);
      
      const signalId = `BACKFILL-${feature.timestamp}-${i}`;
      if (existingSignalIds.has(signalId)) continue;
      
      const pipValue = 0.1;
      const realizedPL = tradeResult.profitPips * pipValue;
      
      newTrades.push({
        id: signalId,
        direction: direction,
        entry: entryPrice,
        exit: tradeResult.exitPrice,
        sl: sl,
        tp: tp,
        rr: 3,
        actualRR: tradeResult.actualRR,
        result: tradeResult.result,
        attribution: tradeResult.result === "WIN" ? null : "MISSED_TRADE_RECOVERY",
        realizedPL: realizedPL,
        session: feature.session,
        regime: feature.trend === "BULLISH" ? "TRENDING" : "RANGING",
        strategyVersion: activePattern.version || "1.0",
        patternFingerprint: activePattern.conditions.map(c => `${c.type}:${c.value}`).join("|"),
        openedAt: new Date(candles[i].datetime).toISOString(),
        closedAt: tradeResult.result !== "OPEN" ? new Date(candles[tradeResult.exitIndex].datetime).toISOString() : null,
        isBackfill: true,
        backfillNote: `Missed trade recovered. Would have triggered at ${new Date(candles[i].datetime).toLocaleString()}`
      });
      
      balanceAdjustment += realizedPL;
    }
    
    if (newTrades.length > 0) {
      // Update state
      setJournal([...newTrades, ...currentJournal]);
      dispatchAccount({ type: "UPDATE_BALANCE", balance: currentAccount.balance + balanceAdjustment });
      addAudit("BACKFILL_COMPLETE", `Recovered ${newTrades.length} missed trades. Total profit: $${balanceAdjustment.toFixed(2)}. New balance: $${(currentAccount.balance + balanceAdjustment).toFixed(2)}`);
    } else {
      addAudit("BACKFILL_COMPLETE", "No missed trades found during closed period.");
    }
    
    saveBackfillState(
      { ...currentAccount, balance: currentAccount.balance + balanceAdjustment }, 
      [...newTrades, ...currentJournal]
    );
    
    return newTrades.length > 0;
    
  } catch (error) {
    console.error("Backfill error:", error);
    addAudit("BACKFILL_ERROR", error.message);
    saveBackfillState(currentAccount, currentJournal);
    return false;
  }
}

// ============================================================
// HELPER FUNCTIONS (copied from App.jsx for independence)
// ============================================================

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
        break;
    }
  }
  return true;
}

function computeFeatureVector(candles, index) {
  const currentCandle = candles[index];
  const lookbackCandles = candles.slice(Math.max(0, index - 20), index + 1);
  
  // Simplified feature extraction for backfill
  const highs = lookbackCandles.map(c => c.high);
  const lows = lookbackCandles.map(c => c.low);
  const currentHigh = currentCandle.high;
  const currentLow = currentCandle.low;
  
  const higherHigh = currentHigh > Math.max(...highs.slice(0, -1));
  const higherLow = currentLow > Math.max(...lows.slice(0, -1));
  const lowerHigh = currentHigh < Math.min(...highs.slice(0, -1));
  const lowerLow = currentLow < Math.min(...lows.slice(0, -1));
  
  let trend = "NEUTRAL";
  if (higherHigh && higherLow) trend = "BULLISH";
  if (lowerHigh && lowerLow) trend = "BEARISH";
  
  const date = new Date(currentCandle.timestamp);
  const hourUTC = date.getUTCHours();
  const minuteUTC = date.getUTCMinutes();
  const dec = hourUTC + minuteUTC / 60;
  
  let session = "OFF_HOURS";
  if (dec >= 7 && dec < 16) session = "LONDON";
  if (dec >= 12 && dec < 21) session = "NEW_YORK";
  if (dec >= 22 || dec < 8) session = "TOKYO";
  if ((dec >= 7 && dec < 16) && (dec >= 12 && dec < 21)) session = "OVERLAP";
  
  return {
    trend, session,
    higherHigh, higherLow, lowerHigh, lowerLow,
    breakoutUp: false, breakoutDown: false, pullback: false, compression: false, expansion: false,
    upperWickRatio: 0, lowerWickRatio: 0, bodyRatio: 0, atrPercentile: null,
    sessionScore: session === "OVERLAP" ? 100 : (session === "LONDON" || session === "NEW_YORK") ? 75 : session === "TOKYO" ? 50 : 25,
    ema20Relation: "UNKNOWN", rsi14: null, atr14: null,
    engulfing: null, patterns: [],
    close: currentCandle.close, high: currentCandle.high, low: currentCandle.low, open: currentCandle.open,
    timestamp: currentCandle.timestamp
  };
}