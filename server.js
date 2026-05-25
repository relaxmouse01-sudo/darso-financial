const http = require('http');
const fs = require('fs');
const path = require('path');
const fetch = globalThis.fetch || require('undici').fetch;
const STRATEGIES = require('./strategies.json');

// Portfolio file storage
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
const PORTFOLIO_HISTORY_FILE = path.join(__dirname, 'portfolio-history.json');
const PORTFOLIO_VALUE_HISTORY_FILE = path.join(__dirname, 'portfolio-value-history.json');
const BROKER_CONFIG_FILE = path.join(__dirname, 'broker-config.json');
const BOT_CONFIG_FILE = path.join(__dirname, 'bot-config.json');
var BOT_INTERVAL = null;

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = __dirname;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';

// Portfolio management functions
function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return { cash: 100000, holdings: [] };
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8')); }
  catch { return { cash: 100000, holdings: [] }; }
}

function savePortfolio(portfolio) {
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
}

function loadPortfolioHistory() {
  if (!fs.existsSync(PORTFOLIO_HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function savePortfolioHistory(history) {
  fs.writeFileSync(PORTFOLIO_HISTORY_FILE, JSON.stringify(history, null, 2));
}
function loadPortfolioValueHistory() {
  if (!fs.existsSync(PORTFOLIO_VALUE_HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PORTFOLIO_VALUE_HISTORY_FILE, 'utf8')); }
  catch { return []; }
}
function savePortfolioValueHistory(data) {
  fs.writeFileSync(PORTFOLIO_VALUE_HISTORY_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'Content-Type': 'application/json' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleTts(req, res) {
  if (!ELEVENLABS_API_KEY) {
    sendJson(res, 500, { error: 'ELEVENLABS_API_KEY is not configured' });
    return;
  }
  const payload = await readJson(req);
  const text = String(payload.text || '').slice(0, 900);
  if (!text.trim()) {
    sendJson(res, 400, { error: 'text is required' });
    return;
  }

  const voiceId = payload.voiceId || ELEVENLABS_VOICE_ID;
  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: payload.model_id || 'eleven_turbo_v2_5',
      voice_settings: payload.voice_settings || {
        stability: 0.35,
        similarity_boost: 0.85,
        style: 0.45,
        use_speaker_boost: true
      }
    })
  });

  if (!upstream.ok) {
    const err = await upstream.text().catch(() => '');
    sendJson(res, upstream.status, { error: err || 'ElevenLabs request failed' });
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  send(res, 200, audio, { 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg' });
}

function getStockFallback(symbol) {
  const baseValues = {
    'AAPL': { name:'Apple Inc.', price:174.82, currency:'USD', high:189.95, low:168.32 },
    'TSLA': { name:'Tesla, Inc.', price:228.12, currency:'USD', high:258.33, low:210.45 },
    'N225': { name:'Nikkei 225', price:38421, currency:'JPY', high:39455, low:37823 },
    '^GSPC': { name:'S&P 500', price:5298, currency:'USD', high:5450, low:5120 },
    'BTC-USD': { name:'Bitcoin', price:67841, currency:'USD', high:72500, low:62100 },
    'ETH-USD': { name:'Ethereum', price:3481, currency:'USD', high:3850, low:3150 },
    'GC=F': { name:'Gold Futures', price:2341, currency:'USD', high:2455, low:2280 },
    'SOL-USD': { name:'Solana', price:178.50, currency:'USD', high:198.25, low:165.10 },
    'INR=X': { name:'USD/INR', price:83.42, currency:'INR', high:84.85, low:82.15 },
    'RELIANCE.NS': { name:'Reliance Industries', price:1235, currency:'INR', high:1375, low:1180 },
    'TCS.NS': { name:'Tata Consultancy Services', price:3890, currency:'INR', high:4250, low:3560 },
    'HDFCBANK.NS': { name:'HDFC Bank', price:1685, currency:'INR', high:1800, low:1500 },
    'ICICIBANK.NS': { name:'ICICI Bank', price:1250, currency:'INR', high:1430, low:1180 },
    'INFY.NS': { name:'Infosys', price:1680, currency:'INR', high:1850, low:1480 },
    'ITC.NS': { name:'ITC', price:485, currency:'INR', high:540, low:390 },
    'SBIN.NS': { name:'State Bank of India', price:830, currency:'INR', high:920, low:700 },
    'BHARTIARTL.NS': { name:'Bharti Airtel', price:1600, currency:'INR', high:1780, low:1380 },
    'WIPRO.NS': { name:'Wipro', price:510, currency:'INR', high:590, low:420 },
    'LT.NS': { name:'Larsen & Toubro', price:3500, currency:'INR', high:3900, low:3100 }
  };
  const base = baseValues[symbol] || { name:symbol, price:100 + Math.random()*90, currency:'USD', high:120, low:80 };
  var change = (Math.random() - 0.48) * base.price * 0.015;
  return {
    symbol: symbol,
    name: base.name,
    price: Number((base.price + change).toFixed(symbol === 'INR=X' ? 2 : 2)),
    change: Number(change.toFixed(2)),
    changePercent: Number((change / base.price * 100).toFixed(2)),
    currency: base.currency,
    fiftyTwoWeekHigh: base.high,
    fiftyTwoWeekLow: base.low,
    marketState: 'CLOSED',
    source: 'simulated'
  };
}

async function handleStockChart(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) { sendJson(res, 400, { error: 'symbol parameter required' }); return; }

  // Try Finnhub first, fallback to Yahoo (handled inside fetchCandles)
  const candles = await fetchCandles(symbol, 90);
  if (candles.length > 0) {
    sendJson(res, 200, { symbol, chartData: candles });
    return;
  }
  sendJson(res, 200, { symbol, chartData: [] });
}

async function handleStock(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const symbolsParam = (url.searchParams.get('symbols') || '').trim();
  const symbols = symbolsParam ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : ['N225','^GSPC','BTC-USD','ETH-USD','GC=F','SOL-USD','INR=X'];
  if (!symbols.length) {
    sendJson(res, 400, { error: 'symbols are required' });
    return;
  }

  const query = encodeURIComponent(symbols.join(','));
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const yahooOpts = { headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' } };
  const yahooHosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  for (const host of yahooHosts) {
    // v7/quote first — has full fundamental data
    try {
      const upstream = await fetch(`https://${host}/v7/finance/quote?symbols=${query}`, yahooOpts);
      if (upstream.ok) {
        const data = await upstream.json().catch(() => ({}));
        const results = (data.quoteResponse && Array.isArray(data.quoteResponse.result) ? data.quoteResponse.result : []).map(q => ({
          symbol: q.symbol, name: q.shortName || q.longName || q.symbol,
          price: q.regularMarketPrice, change: q.regularMarketChange,
          changePercent: q.regularMarketChangePercent, currency: q.currency,
          marketState: q.marketState,
          marketCap: q.marketCap, volume: q.regularMarketVolume,
          avgVolume: q.averageVolume, peRatio: q.trailingPE,
          forwardPE: q.forwardPE, eps: q.earningsPerShare,
          dividendYield: q.dividendYield, dividendRate: q.dividendRate,
          exDividendDate: q.exDividendDate,
          fiftyTwoWeekHigh: q.fiftyTwoWeekHigh, fiftyTwoWeekLow: q.fiftyTwoWeekLow,
          fiftyDayAvg: q.fiftyDayAverage, twoHundredDayAvg: q.twoHundredDayAverage,
          beta: q.beta, priceToBook: q.priceToBook,
          shortRatio: q.shortRatio, source: 'yahoo'
        }));
        if (results.length) { sendJson(res, 200, { quotes: results }); return; }
      }
    } catch (_) {}
    // v8/chart fallback — basic price data only
    try {
      const upstream = await fetch(`https://${host}/v8/finance/chart/${query}?interval=1d`, yahooOpts);
      if (upstream.ok) {
        const data = await upstream.json().catch(() => ({}));
        const result = data.chart && data.chart.result && data.chart.result[0];
        const meta = result && result.meta;
        if (meta && meta.regularMarketPrice != null) {
          const quotes = symbols.map(sym => {
            const m = data.chart.result.find(r => r.meta && r.meta.symbol === sym);
            if (!m || !m.meta) return null;
            const mk = m.meta;
            return {
              symbol: sym,
              name: mk.shortName || mk.symbol,
              price: mk.regularMarketPrice,
              change: mk.previousClose ? mk.regularMarketPrice - mk.previousClose : 0,
              changePercent: mk.previousClose ? ((mk.regularMarketPrice - mk.previousClose) / mk.previousClose * 100) : 0,
              currency: mk.currency || 'USD',
              marketState: mk.currentTradingPeriod ? (mk.currentTradingPeriod.regular ? 'REGULAR' : 'CLOSED') : 'CLOSED',
              source: 'yahoo'
            };
          }).filter(Boolean);
          if (quotes.length) { sendJson(res, 200, { quotes }); return; }
        }
      }
    } catch (_) {}
  }

  const fallback = symbols.map(getStockFallback);
  sendJson(res, 200, { quotes: fallback, fallback: true });
}

// ─── Technical Indicator Helpers ─────────────────────────────────────────

function calcSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function calcEMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { ema = data[0]; result.push(ema); continue; }
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(data, period) {
  const result = [];
  let gains = 0, losses = 0;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push(null); continue; }
    const diff = data[i] - data[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i < period) {
      gains += gain;
      losses += loss;
      result.push(null);
      continue;
    }
    if (i === period) {
      gains /= period;
      losses /= period;
    } else {
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

function calcMACD(data) {
  const ema12 = calcEMA(data, 12);
  const ema26 = calcEMA(data, 26);
  const macdLine = ema12.map((v, i) => v !== null && ema26[i] !== null ? v - ema26[i] : null);
  const signal = calcEMA(macdLine.filter(v => v !== null), 9);
  let sigIdx = 0;
  const fullSignal = macdLine.map(v => v !== null ? signal[sigIdx++] : null);
  const histogram = macdLine.map((v, i) => v !== null && fullSignal[i] !== null ? v - fullSignal[i] : null);
  return { macdLine, signal: fullSignal, histogram };
}

function computeIndicators(candles, quoteData) {
  if (!candles || candles.length < 50) return {};
  const closes = typeof candles[0] === 'number' ? candles : candles.map(c => c.c);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  var lastClose = closes[closes.length - 1];
  var result = {
    sma50: sma50[sma50.length - 1],
    sma200: sma200[sma200.length - 1],
    rsi: rsi[rsi.length - 1],
    macd: macd.macdLine[macd.macdLine.length - 1],
    macdSignal: macd.signal[macd.signal.length - 1],
    macdHistogram: macd.histogram[macd.histogram.length - 1],
    sma50Above200: sma50[sma50.length - 1] !== null && sma200[sma200.length - 1] !== null
      ? sma50[sma50.length - 1] > sma200[sma200.length - 1] : null,
    lastClose: lastClose
  };
  if (quoteData) {
    var volumes = quoteData.volume || [];
    var highs = quoteData.high || [];
    var lows = quoteData.low || [];
    var valid = [];
    for (var i = 0; i < volumes.length; i++) {
      if (volumes[i] != null) valid.push(volumes[i]);
    }
    var avgVol = valid.length ? valid.slice(-20).reduce(function(a,b){return a+b;},0) / Math.min(20, valid.length) : 0;
    result.avgVolume = avgVol;
    result.lastVolume = valid.length ? valid[valid.length - 1] : 0;
    // recent high/low over 20 periods
    var recentHighs = [];
    var recentLows = [];
    for (var i = Math.max(0, closes.length - 20); i < closes.length; i++) {
      if (closes[i] != null) {
        recentHighs.push(highs[i] != null ? highs[i] : closes[i]);
        recentLows.push(lows[i] != null ? lows[i] : closes[i]);
      }
    }
    result.high20 = recentHighs.length ? Math.max.apply(null, recentHighs) : lastClose;
    result.low20 = recentLows.length ? Math.min.apply(null, recentLows) : lastClose;
    result.range20 = result.high20 - result.low20;
    result.range20Pct = lastClose ? (result.range20 / result.high20) * 100 : 0;
    // price vs 20-day range
    result.posInRange = lastClose && result.range20 ? ((lastClose - result.low20) / result.range20) * 100 : 50;
  }
  return result;
}

async function fetchFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) return null;
  // Finnhub free tier doesn't support all exchanges; return null to fall through
  try {
    const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || data.c === undefined || data.c === null || data.c === 0) return null;
    return {
      regularMarketPrice: data.c,
      regularMarketChange: data.d ?? 0,
      regularMarketChangePercent: data.dp ?? 0,
      regularMarketVolume: data.v ?? 0,
      regularMarketDayLow: data.l,
      regularMarketDayHigh: data.h,
      regularMarketOpen: data.o,
      regularMarketPreviousClose: data.pc,
      marketCap: null,
      trailingPE: null,
      dividendYield: null,
      fiftyTwoWeekLow: null,
      fiftyTwoWeekHigh: null
    };
  } catch { return null; }
}

async function fetchFinnhubCandles(symbol, days = 180) {
  if (!FINNHUB_API_KEY) return [];
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  try {
    const resp = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (data.s !== 'ok' || !data.t || !data.c) return [];
    const candles = [];
    for (let i = 0; i < data.t.length; i++) {
      if (data.c[i] === null || data.c[i] === undefined) continue;
      candles.push({
        t: data.t[i] * 1000,
        o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v[i]
      });
    }
    return candles;
  } catch { return []; }
}

// Yahoo Finance fallback for exchanges Finnhub doesn't support (e.g. NSE India)
async function fetchYahooQuote(symbol) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const yahooOpts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
  for (const host of hosts) {
    try {
      const url = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
      const resp = await fetch(url, yahooOpts);
      if (!resp.ok) continue;
      const data = await resp.json();
      const q = data?.quoteResponse?.result?.[0];
      if (q && q.regularMarketPrice) return q;
    } catch {}
  }
  return null;
}

async function fetchYahooCandles(symbol, range = '6mo') {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const yahooOpts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
      const resp = await fetch(url, yahooOpts);
      if (!resp.ok) continue;
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const o = quote.open || [];
      const h = quote.high || [];
      const l = quote.low || [];
      const c = quote.close || [];
      const v = quote.volume || [];
      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (c[i] === null || c[i] === undefined) continue;
        candles.push({ t: timestamps[i] * 1000, o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] });
      }
      return candles;
    } catch {}
  }
  return [];
}

// Fetch quote with Finnhub first, fallback to Yahoo
async function fetchQuote(symbol) {
  const finn = await fetchFinnhubQuote(symbol);
  if (finn) return finn;
  return fetchYahooQuote(symbol);
}

// Fetch candles with Finnhub first, fallback to Yahoo
async function fetchCandles(symbol, days = 180) {
  const finn = await fetchFinnhubCandles(symbol, days);
  if (finn.length > 0) return finn;
  return fetchYahooCandles(symbol);
}

// ─── Watchlist Handlers ─────────────────────────────────────────────────

const WATCHLIST_FILE = path.join(__dirname, 'watchlist.json');

function loadWatchlist() {
  if (!fs.existsSync(WATCHLIST_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); }
  catch { return []; }
}

async function handleWatchlist(req, res) {
  const stocks = loadWatchlist();
  if (!stocks.length) {
    sendJson(res, 200, { stocks: [] });
    return;
  }
  const results = await Promise.all(stocks.map(async (s) => {
    const q = await fetchQuote(s.symbol);
    if (q) {
      return {
        symbol: s.symbol, name: s.name, nse: s.nse,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        volume: q.regularMarketVolume,
        high: q.regularMarketDayHigh,
        low: q.regularMarketDayLow
      };
    }
    const fb = getStockFallback(s.symbol);
    return {
      symbol: s.symbol, name: s.name, nse: s.nse,
      price: fb.price, change: fb.change,
      changePercent: fb.changePercent,
      volume: fb.volume, high: fb.high, low: fb.low
    };
  }));
  sendJson(res, 200, { stocks: results });
}

async function handleWatchlistAdd(req, res) {
  const payload = await readJson(req);
  let symbol = (payload.symbol || '').trim().toUpperCase();
  let name = (payload.name || '').trim();
  if (!symbol) { sendJson(res, 400, { error: 'symbol is required' }); return; }
  if (!symbol.includes('.')) symbol += '.NS';
  if (!name) name = symbol;
  const stocks = loadWatchlist();
  if (stocks.some(s => s.symbol === symbol)) {
    sendJson(res, 200, { stocks, message: 'Already in watchlist' });
    return;
  }
  stocks.push({ symbol, name, nse: symbol.replace('.NS','') });
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(stocks, null, 2));
  sendJson(res, 200, { stocks, message: `${name} added to watchlist` });
}

async function handleStockInfo(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const symbol = url.searchParams.get('symbol');
  if (!symbol) {
    sendJson(res, 400, { error: 'symbol is required' });
    return;
  }
  let [quote, candles] = await Promise.all([
    fetchQuote(symbol),
    fetchCandles(symbol)
  ]);
  const indicators = computeIndicators(candles);
  const latestCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null;
  const fallbackPrice = latestCandle ? latestCandle.c : null;
  if (!quote && fallbackPrice) {
    quote = {
      regularMarketPrice: fallbackPrice,
      regularMarketChange: prevCandle ? fallbackPrice - prevCandle.c : 0,
      regularMarketChangePercent: prevCandle ? ((fallbackPrice - prevCandle.c) / prevCandle.c) * 100 : 0,
      regularMarketVolume: latestCandle.v,
      regularMarketDayLow: latestCandle.l,
      regularMarketDayHigh: latestCandle.h,
      fiftyTwoWeekLow: null,
      fiftyTwoWeekHigh: null,
      trailingPE: null,
      marketCap: null
    };
  }
  sendJson(res, 200, {
    symbol,
    quote,
    candles: candles.slice(-30),
    indicators,
    latestCandle,
    prevCandle,
    candleCount: candles.length
  });
}

async function handleWatchlistScan(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: 'OPENROUTER_API_KEY not configured' });
    return;
  }
  const stocks = loadWatchlist();
  const symbols = stocks.map(s => s.symbol);
  const batchSize = 5;
  const allData = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (sym) => {
      const [quoteData, candles] = await Promise.all([
        fetchQuote(sym),
        fetchCandles(sym)
      ]);
      const ind = computeIndicators(candles);
      const stock = stocks.find(s => s.symbol === sym);
      const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
      const price = quoteData?.regularMarketPrice || (lastCandle ? lastCandle.c : null);
      const changePct = quoteData?.regularMarketChangePercent !== undefined ? quoteData.regularMarketChangePercent
        : (candles.length > 1 && lastCandle ? ((lastCandle.c - candles[candles.length - 2].c) / candles[candles.length - 2].c) * 100 : null);
      return {
        symbol: sym,
        name: stock ? stock.name : sym,
        price,
        changePercent: changePct,
        rsi: ind.rsi,
        macd: ind.macd,
        macdSignal: ind.macdSignal,
        sma50: ind.sma50,
        sma200: ind.sma200,
        sma50Above200: ind.sma50Above200
      };
    });
    const results = await Promise.all(promises);
    allData.push(...results);
  }

  const marketSummary = allData.map(s =>
    `${s.name} (${s.symbol}): ₹${s.price?.toFixed(2) || 'N/A'}, ` +
    `Change: ${s.changePercent?.toFixed(2) || 'N/A'}%, ` +
    `RSI(14): ${s.rsi?.toFixed(1) || 'N/A'}, ` +
    `MACD: ${s.macd?.toFixed(2) || 'N/A'}, ` +
    `SMA50: ${s.sma50?.toFixed(2) || 'N/A'}, SMA200: ${s.sma200?.toFixed(2) || 'N/A'}, ` +
    `SMA50>200: ${s.sma50Above200 === null ? 'N/A' : s.sma50Above200 ? 'Yes' : 'No'}`
  ).join('\n');

  const prompt = `You are a market analyst. Analyze these Indian stocks and tell me:
1. Which ones look BULLISH (based on RSI, MACD, SMA crossover, price momentum)
2. Which ones look BEARISH
3. Suggest 3-5 new stocks worth watching (with NSE symbols) that are NOT in the current list
4. A short summary of the overall market sentiment
5. End with a line: "SUGGESTED:" followed by comma-separated NSE symbols you recommend adding

Current market data:
${marketSummary}

Format your response with clear sections and emoji markers.`;

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'DARSO Market Scan'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.3
      })
    });
    const data = await upstream.json().catch(() => ({}));
    const analysis = data?.choices?.[0]?.message?.content || 'Analysis failed.';
    sendJson(res, 200, { stocks: allData, analysis });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// ─── Stock-aware Chat ────────────────────────────────────────────────────

async function handleChat(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: 'OPENROUTER_API_KEY is not configured' });
    return;
  }
  const payload = await readJson(req);
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  if (!messages.length) {
    sendJson(res, 400, { error: 'messages are required' });
    return;
  }

  let stockContext = payload.stockContext || null;
  if (stockContext) {
    const q = stockContext.quote;
    const ind = stockContext.indicators || {};
    const candle = stockContext.latestCandle;
    const contextMsg = {
      role: 'system',
      content:
        `Current market data for ${stockContext.symbol}:\n` +
        `Price: ₹${q?.regularMarketPrice || 'N/A'}\n` +
        `Change: ${q?.regularMarketChangePercent?.toFixed(2) || 'N/A'}%\n` +
        `Volume: ${q?.regularMarketVolume?.toLocaleString() || 'N/A'}\n` +
        `Day Range: ${q?.regularMarketDayLow || 'N/A'} - ${q?.regularMarketDayHigh || 'N/A'}\n` +
        `52W Range: ${q?.fiftyTwoWeekLow || 'N/A'} - ${q?.fiftyTwoWeekHigh || 'N/A'}\n` +
        `PE Ratio: ${q?.trailingPE || 'N/A'}\n` +
        `RSI(14): ${ind.rsi?.toFixed(1) || 'N/A'}\n` +
        `MACD: ${ind.macd?.toFixed(2) || 'N/A'} | Signal: ${ind.macdSignal?.toFixed(2) || 'N/A'}\n` +
        `SMA50: ${ind.sma50?.toFixed(2) || 'N/A'} | SMA200: ${ind.sma200?.toFixed(2) || 'N/A'}\n` +
        `SMA50 above SMA200: ${ind.sma50Above200 === null ? 'N/A' : ind.sma50Above200 ? 'Yes (Bullish)' : 'No (Bearish)'}\n` +
        `${candle ? `Latest candle: O=${candle.o} H=${candle.h} L=${candle.l} C=${candle.c} V=${candle.v}` : ''}\n` +
        `Use this data to answer the user's question about ${stockContext.name || stockContext.symbol}.`
    };
    messages.unshift(contextMsg);
  }

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Financial Intelligence'
    },
    body: JSON.stringify({
      model: payload.model || OPENROUTER_MODEL,
      messages,
      max_tokens: 420,
      temperature: 0.42
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: data.error?.message || 'OpenRouter request failed' });
    return;
  }

  sendJson(res, 200, { reply: data.choices?.[0]?.message?.content || '' });
}

async function handlePortfolio(req, res) {
  var portfolio = loadPortfolio();
  var holdings = portfolio.holdings || [];
  var enriched = await Promise.all(holdings.map(async function(h){
    try {
      var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(h.symbol) + '?interval=1m&range=2d');
      var d = await r.json();
      var ch = d.chart && d.chart.result && d.chart.result[0];
      if (!ch) return { symbol: h.symbol, quantity: h.quantity, avgCost: h.avgCost, currentPrice: null, pnl: 0, pnlPercent: 0, value: 0 };
      var closes = ch.indicators && ch.indicators.quote && ch.indicators.quote[0] ? (ch.indicators.quote[0].close || []) : [];
      var validCloses = closes.filter(function(v){return v!=null;});
      var meta = ch.meta || {};
      var currentPrice = validCloses.length ? validCloses[validCloses.length-1] : (meta.regularMarketPrice || h.avgCost);
      var value = currentPrice * h.quantity;
      var cost = h.avgCost * h.quantity;
      return {
        symbol: h.symbol,
        quantity: h.quantity,
        avgCost: h.avgCost,
        currentPrice: currentPrice,
        value: value,
        cost: cost,
        pnl: value - cost,
        pnlPercent: cost > 0 ? ((value - cost) / cost * 100) : 0,
        purchaseDate: h.purchaseDate || null
      };
    } catch(e) {
      return { symbol: h.symbol, quantity: h.quantity, avgCost: h.avgCost, currentPrice: null, pnl: 0, pnlPercent: 0, value: 0 };
    }
  }));
  var totalValue = portfolio.cash + enriched.reduce(function(s, h){ return s + (h.value || 0); }, 0);
  var totalCost = enriched.reduce(function(s, h){ return s + (h.cost || 0); }, 0);
  var totalPnl = enriched.reduce(function(s, h){ return s + (h.pnl || 0); }, 0);
  sendJson(res, 200, {
    cash: portfolio.cash,
    holdings: enriched,
    totalValue: totalValue,
    totalCost: totalCost,
    totalPnl: totalPnl,
    totalPnlPercent: totalCost > 0 ? (totalPnl / totalCost * 100) : 0
  });
}

async function handleTrade(req, res) {
  const payload = await readJson(req);
  const { symbol, quantity, price, type } = payload; // type: 'buy' or 'sell'
  
  if (!symbol || !quantity || !price || !type) {
    sendJson(res, 400, { error: 'symbol, quantity, price, and type are required' });
    return;
  }

  const portfolio = loadPortfolio();
  const cost = quantity * price;
  
  if (type === 'buy') {
    if (portfolio.cash < cost) {
      sendJson(res, 400, { error: 'Insufficient cash' });
      return;
    }
    portfolio.cash -= cost;
    const existing = portfolio.holdings.find(h => h.symbol === symbol);
    if (existing) {
      existing.quantity += quantity;
      existing.avgCost = (existing.quantity * existing.avgCost + cost) / (existing.quantity + quantity);
      existing.quantity += quantity;
    } else {
      portfolio.holdings.push({ symbol, quantity, avgCost: price, purchaseDate: new Date().toISOString() });
    }
  } else if (type === 'sell') {
    const holding = portfolio.holdings.find(h => h.symbol === symbol);
    if (!holding || holding.quantity < quantity) {
      sendJson(res, 400, { error: 'Insufficient shares' });
      return;
    }
    portfolio.cash += cost;
    holding.quantity -= quantity;
    if (holding.quantity === 0) {
      portfolio.holdings = portfolio.holdings.filter(h => h.symbol !== symbol);
    }
  }

  savePortfolio(portfolio);
  sendJson(res, 200, { success: true, portfolio });
}

async function handlePortfolioAnalysis(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: 'AI not configured' });
    return;
  }

  const portfolio = loadPortfolio();
  const payload = await readJson(req);
  const { quotes } = payload;

  let totalValue = portfolio.cash;
  let holdingsText = 'Holdings: ';
  for (const holding of portfolio.holdings) {
    const quote = quotes?.find(q => q.symbol === holding.symbol);
    const value = holding.quantity * (quote?.price || 0);
    totalValue += value;
    const gain = value - (holding.quantity * holding.avgCost);
    holdingsText += `${holding.symbol}: ${holding.quantity}x @ $${holding.avgCost.toFixed(2)} (current: $${quote?.price || 'N/A'}), `;
  }

  const messages = [{
    role: 'user',
    content: `Analyze my stock portfolio. Cash: $${portfolio.cash.toFixed(2)}. Total value: $${totalValue.toFixed(2)}. ${holdingsText} Provide concise investment insights and recommendations.`
  }];

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Financial Intelligence'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 350,
      temperature: 0.5
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(res, 500, { error: data.error?.message || 'Analysis failed' });
    return;
  }

  sendJson(res, 200, { 
    analysis: data.choices?.[0]?.message?.content || '',
    portfolio: { totalValue, cash: portfolio.cash, holdingsCount: portfolio.holdings.length }
  });
}

async function handleAIAutoInvest(req, res) {
  // AI-powered: picks 3-5 stocks, executes buy trades automatically
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: 'AI not configured — add OPENROUTER_API_KEY to .env' });
    return;
  }

  const payload = await readJson(req);
  const { amount, riskTolerance, numStocks } = payload;
  const count = Math.max(3, Math.min(5, parseInt(numStocks) || 3));
  const risk = ['conservative','moderate','aggressive','speculative'].includes(riskTolerance) ? riskTolerance : 'moderate';

  if (!amount || amount < 100) {
    sendJson(res, 400, { error: 'amount must be at least $100' });
    return;
  }

  // 1. Fetch some real market quotes for context
  const topSymbols = 'AAPL,MSFT,GOOGL,AMZN,NVDA,TSLA,META,BRK.B,JPM,V,PG,JNJ,XOM,UNH,HD,COST,DIS,MA,NFLX,ADBE,CRM,INTC,AMD,PYPL,SNAP,UBER,ABNB,PLTR,SOFI,HOOD';
  let marketContext = '';
  const uaAI = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const yho = { headers: { 'User-Agent': uaAI, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' } };
  const yh = ['query1.finance.yahoo.com','query2.finance.yahoo.com'];
  for (const h of yh) {
    try {
      const up = await fetch(`https://${h}/v7/finance/quote?symbols=${encodeURIComponent(topSymbols)}`, yho);
      if (up.ok) {
        const d = await up.json();
        const results = ((d.quoteResponse && d.quoteResponse.result) || []).filter(q => q.regularMarketPrice);
        if (results.length) {
          marketContext = 'Current market context (real quotes):\n' + results.slice(0, 30).map(q =>
            `- ${q.symbol} (${q.shortName || q.longName || q.symbol}): $${q.regularMarketPrice}, ${q.regularMarketChangePercent > 0 ? '+' : ''}${(q.regularMarketChangePercent || 0).toFixed(2)}% today`
          ).join('\n');
          break;
        }
      }
    } catch (_) {}
  }

  const prompt = `You are an expert portfolio manager. A user wants to invest $${amount} in the stock market.

Parameters:
- Risk tolerance: ${risk}
- Number of stocks to pick: ${count}
${marketContext ? '\n' + marketContext : ''}

Your job: Pick exactly ${count} stocks for this investor. Consider valuation, momentum, sector diversification, risk-adjusted returns, and macro conditions.

Respond ONLY with a valid JSON object (no markdown, no backticks, no extra text):
{
  "strategyName": "catchy name for this portfolio",
  "marketOutlook": "2-3 sentences on current market conditions",
  "expectedAnnualReturn": "e.g. '12-18%'",
  "estimatedRiskLevel": "e.g. 'Moderate' or 'Aggressive'",
  "overallRationale": "3-4 sentences explaining strategy",
  "stocks": [
    {
      "ticker": "AAPL",
      "name": "Apple Inc.",
      "sector": "Technology",
      "allocationPct": 25.0,
      "rationale": "2-3 sentences on why this stock fits the portfolio",
      "signals": ["Bullish: strong cash flows", "Bullish: buybacks", "Risk: valuation"],
      "signalTypes": ["bull", "bull", "bear"],
      "estimatedReturn": "+15-22% in 12mo",
      "confidence": "High"
    }
  ]
}

Rules:
- allocationPct must sum to exactly 100
- Include 2-4 signals per stock
- signalTypes must be "bull", "bear", or "neutral"
- Pick diversified sectors — don't put everything in one sector`;

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Financial Intelligence'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.35
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(res, 500, { error: data.error?.message || 'AI analysis failed' });
    return;
  }

  let raw = data.choices?.[0]?.message?.content || '';
  raw = raw.replace(/```json|```/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    sendJson(res, 500, { error: 'AI response was not valid JSON' });
    return;
  }

  let recommendation;
  try { recommendation = JSON.parse(raw.slice(start, end + 1)); }
  catch (e) {
    sendJson(res, 500, { error: 'Failed to parse AI recommendation' });
    return;
  }

  if (!recommendation.stocks || !recommendation.stocks.length) {
    sendJson(res, 500, { error: 'AI returned no stock picks' });
    return;
  }

  // 2. Fetch real prices for selected tickers and execute trades
  const tickers = recommendation.stocks.map(s => s.ticker).join(',');
  let priceMap = {};
  const yhpOpts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' } };
  const yhHosts = ['query1.finance.yahoo.com','query2.finance.yahoo.com'];
  for (const h of yhHosts) {
    try {
      const priceRes = await fetch(`https://${h}/v7/finance/quote?symbols=${encodeURIComponent(tickers)}`, yhpOpts);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        (priceData.quoteResponse?.result || []).forEach(q => {
          if (q.regularMarketPrice) priceMap[q.symbol] = q.regularMarketPrice;
        });
        if (Object.keys(priceMap).length) break;
      }
    } catch (_) {}
  }

  const portfolio = loadPortfolio();
  const trades = [];
  let totalInvested = 0;

  for (const stock of recommendation.stocks) {
    const alloc = stock.allocationPct / 100;
    const investAmount = Math.round(amount * alloc * 100) / 100;
    const price = priceMap[stock.ticker] || (stock.estimatedPrice || amount * alloc / 10);
    const quantity = Math.max(1, Math.floor(investAmount / price));
    const actualCost = quantity * price;
    totalInvested += actualCost;

    if (quantity > 0) {
      // Execute buy
      if (portfolio.cash >= actualCost) {
        portfolio.cash -= actualCost;
        const existing = portfolio.holdings.find(h => h.symbol === stock.ticker);
        if (existing) {
          existing.quantity += quantity;
          existing.avgCost = price;
        } else {
          portfolio.holdings.push({ symbol: stock.ticker, quantity, avgCost: price, purchaseDate: new Date().toISOString() });
        }
        trades.push({
          ticker: stock.ticker,
          name: stock.name,
          quantity,
          price: Math.round(price * 100) / 100,
          invested: Math.round(actualCost * 100) / 100,
          allocationPct: stock.allocationPct,
          status: 'executed'
        });
      } else {
        trades.push({
          ticker: stock.ticker,
          name: stock.name,
          allocationPct: stock.allocationPct,
          status: 'skipped',
          reason: 'Insufficient cash'
        });
      }
    }
  }

  savePortfolio(portfolio);

  sendJson(res, 200, {
    success: true,
    strategyName: recommendation.strategyName || 'AI Portfolio',
    marketOutlook: recommendation.marketOutlook || '',
    expectedAnnualReturn: recommendation.expectedAnnualReturn || '',
    estimatedRiskLevel: recommendation.estimatedRiskLevel || '',
    overallRationale: recommendation.overallRationale || '',
    stocks: recommendation.stocks.map(s => {
      const trade = trades.find(t => t.ticker === s.ticker);
      return {
        ...s,
        executed: trade?.status === 'executed',
        quantity: trade?.quantity || 0,
        price: trade?.price || 0,
        invested: trade?.invested || 0,
        status: trade?.status || 'pending'
      };
    }),
    trades,
    totalInvested: Math.round(totalInvested * 100) / 100,
    remainingCash: Math.round(portfolio.cash * 100) / 100
  });
}

async function handleStockAnalysis(req, res) {
  if (!OPENROUTER_API_KEY) {
    sendJson(res, 500, { error: 'AI not configured' });
    return;
  }

  const payload = await readJson(req);
  const { symbol, quote } = payload;

  if (!symbol || !quote) {
    sendJson(res, 400, { error: 'symbol and quote are required' });
    return;
  }

  const messages = [{
    role: 'user',
    content: `Analyze the stock ${symbol} (${quote.name}). Current price: $${quote.price} (${quote.changePercent > 0 ? '+' : ''}${quote.changePercent}% today). 52-week high: $${quote.fiftyTwoWeekHigh || 'N/A'}. 52-week low: $${quote.fiftyTwoWeekLow || 'N/A'}. Provide a brief technical analysis and price target for the next 3 months. Keep it concise.`
  }];

  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Financial Intelligence'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: 320,
      temperature: 0.5
    })
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    sendJson(res, 500, { error: data.error?.message || 'Analysis failed' });
    return;
  }

  sendJson(res, 200, { 
    symbol,
    analysis: data.choices?.[0]?.message?.content || '',
    recommendation: quote.changePercent > 2 ? 'Strong Buy' : quote.changePercent > 0 ? 'Buy' : quote.changePercent < -2 ? 'Sell' : 'Hold'
  });
}

// ── TRACKING ──────────────────────────────────────────────────────
var TRACKING_FILE = path.join(__dirname, 'tracking.json');
function loadTracking() {
  if (!fs.existsSync(TRACKING_FILE)) return { totalRequests: 0, uniqueIps: [], endpointCounts: {}, hourlyCounts: {}, pageViews: {}, requestLog: [] };
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch { return { totalRequests: 0, uniqueIps: [], endpointCounts: {}, hourlyCounts: {}, pageViews: {}, requestLog: [] }; }
}
function saveTracking(t) {
  try { fs.writeFileSync(TRACKING_FILE, JSON.stringify(t, null, 2)); } catch(_) {}
}
function trackRequest(req) {
  var t = loadTracking();
  t.totalRequests++;
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  if (!t.uniqueIps.includes(ip)) t.uniqueIps.push(ip);
  var ep = req.url.split('?')[0];
  t.endpointCounts[ep] = (t.endpointCounts[ep] || 0) + 1;
  var hour = new Date().toISOString().slice(0, 13);
  t.hourlyCounts[hour] = (t.hourlyCounts[hour] || 0) + 1;
  if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/admin') {
    t.pageViews[req.url] = (t.pageViews[req.url] || 0) + 1;
  }
  t.requestLog = (t.requestLog || []).slice(-99);
  t.requestLog.push({ time: Date.now(), ip: ip, url: req.url, method: req.method });
  saveTracking(t);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ── WALLET & BROKER ─────────────────────────────────────────
function loadBrokerConfig() {
  if (!fs.existsSync(BROKER_CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BROKER_CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveBrokerConfig(config) {
  fs.writeFileSync(BROKER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function handleWalletDeposit(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var amount = parseFloat(payload.amount);
  if (!amount || amount <= 0) { sendJson(res, 400, { error: 'Invalid amount' }); return; }
  var portfolio = loadPortfolio();
  portfolio.cash = (portfolio.cash || 0) + amount;
  savePortfolio(portfolio);
  var history = loadPortfolioHistory();
  history.push({ type: 'deposit', amount: amount, balance: portfolio.cash, time: Date.now() });
  savePortfolioHistory(history);
  sendJson(res, 200, { cash: portfolio.cash, message: '₹' + amount.toLocaleString() + ' deposited successfully' });
}
async function handleWalletWithdraw(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var amount = parseFloat(payload.amount);
  if (!amount || amount <= 0) { sendJson(res, 400, { error: 'Invalid amount' }); return; }
  var portfolio = loadPortfolio();
  var cash = portfolio.cash || 0;
  if (amount > cash) { sendJson(res, 400, { error: 'Insufficient balance. Available: ₹' + cash.toLocaleString() }); return; }
  portfolio.cash = cash - amount;
  savePortfolio(portfolio);
  var history = loadPortfolioHistory();
  history.push({ type: 'withdraw', amount: amount, balance: portfolio.cash, time: Date.now() });
  savePortfolioHistory(history);
  sendJson(res, 200, { cash: portfolio.cash, message: '₹' + amount.toLocaleString() + ' withdrawn successfully' });
}

async function handleBrokerConnect(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var broker = payload.broker || 'zerodha';
  var apiKey = (payload.apiKey || '').trim();
  var clientId = (payload.clientId || '').trim();
  var password = (payload.password || '').trim();
  var totp = (payload.totp || '').trim();
  if (!apiKey) { sendJson(res, 400, { error: 'API Key required' }); return; }
  var config = {
    broker: broker,
    apiKey: apiKey,
    apiSecret: clientId ? '***' : '',
    clientId: clientId,
    password: password ? '***' : '',
    totp: totp ? '***' : '',
    connected: true,
    connectedAt: Date.now()
  };
  saveBrokerConfig(config);
  sendJson(res, 200, { status: 'connected', broker: { broker: config.broker, apiKey: config.apiKey, clientId: config.clientId } });
}

async function handleBrokerDisconnect(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  saveBrokerConfig({});
  sendJson(res, 200, { status: 'disconnected' });
}

// ── ANGEL ONE API ──────────────────────────────────────────────
var ANGEL_TOKEN = null;
var ANGEL_TOKEN_EXPIRY = 0;

async function angelLogin(brokerConfig) {
  if (!brokerConfig || !brokerConfig.apiKey || !brokerConfig.clientId || !brokerConfig.password) return null;
  try {
    var res = await fetch('https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'Accept': 'application/json',
        'X-PrivateKey': brokerConfig.apiKey
      },
      body: JSON.stringify({ clientcode: brokerConfig.clientId, password: brokerConfig.password, totp: brokerConfig.totp || '' })
    });
    var data = await res.json();
    if (data.status === true && data.data && data.data.jwtToken) {
      ANGEL_TOKEN = data.data.jwtToken;
      ANGEL_TOKEN_EXPIRY = Date.now() + 3600000;
      return ANGEL_TOKEN;
    }
    return null;
  } catch(e) { return null; }
}

async function angelPlaceOrder(brokerConfig, symbol, type, quantity, price) {
  if (!ANGEL_TOKEN || Date.now() > ANGEL_TOKEN_EXPIRY) {
    var tok = await angelLogin(brokerConfig);
    if (!tok) return { error: 'Login failed' };
  }
  try {
    var tradingsymbol = symbol.endsWith('.NS') ? symbol.replace('.NS', '') : symbol;
    var exchange = symbol.endsWith('.NS') ? 'NSE' : (symbol.endsWith('.BO') ? 'BSE' : 'NSE');
    var transactionType = type === 'BUY' ? 'BUY' : 'SELL';
    var orderRes = await fetch('https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/placeOrder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ANGEL_TOKEN,
        'X-PrivateKey': brokerConfig.apiKey,
        'X-UserType': 'USER',
        'X-SourceID': 'WEB'
      },
      body: JSON.stringify({
        variety: 'NORMAL',
        tradingsymbol: tradingsymbol,
        symboltoken: '',
        exchange: exchange,
        transactiontype: transactionType,
        ordertype: 'MARKET',
        producttype: 'DELIVERY',
        duration: 'DAY',
        price: '0',
        squareoff: '0',
        stoploss: '0',
        quantity: String(quantity)
      })
    });
    var data = await orderRes.json();
    return data;
  } catch(e) { return { error: e.message }; }
}

function loadBotConfig() {
  if (!fs.existsSync(BOT_CONFIG_FILE)) return { stocks: [], running: false, training: true, cycles: [], performance: { total:0, wins:0, losses:0, winRate:0, pnl:0 } };
  try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')); }
  catch { return { stocks: [], running: false, training: true, cycles: [], performance: { total:0, wins:0, losses:0, winRate:0, pnl:0 } }; }
}
function saveBotConfig(config) {
  fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(config, null, 2));
}
function evaluatePastDecisions(config) {
  var perf = config.performance || { total:0, wins:0, losses:0, winRate:0, pnl:0 };
  var pending = config.pendingDecisions || [];
  if (!pending.length) { config.performance = perf; return config; }
  var consecLosses = config.consecutiveLosses || {};
  var stratPerf = config.strategyPerformance || {};
  var newPending = [];
  for (var p of pending) {
    p.age = (p.age || 0) + 1;
    if (p.age >= 2) {
      var priceChangePct = p.priceChange || 0;
      // If price hasn't changed (same trading day), keep pending up to 5 cycles then force-score as neutral
      if (priceChangePct === 0 && !p._force && p.age < 2) { newPending.push(p); continue; }
      perf.total++;
      var rupeePnl = priceChangePct / 100 * (p.price || 0) * (p.quantity || 0);
      var isWin = (p.action === 'BUY' && priceChangePct > 0) || (p.action === 'SELL' && priceChangePct < 0);
      if (priceChangePct === 0) {
        // Neutral — count as trade but no win/loss or P&L impact
      } else if (isWin) {
        perf.wins++; perf.pnl = (perf.pnl || 0) + Math.abs(rupeePnl);
        if (p.reason) { var m = p.reason.match(/#(\d+)/); if (m) { consecLosses[m[1]] = 0; if (stratPerf[m[1]]) { stratPerf[m[1]].wins = (stratPerf[m[1]].wins||0) + 1; } } }
      } else {
        perf.losses++; perf.pnl = (perf.pnl || 0) - Math.abs(rupeePnl);
        if (p.reason) { var m = p.reason.match(/#(\d+)/); if (m) { consecLosses[m[1]] = (consecLosses[m[1]] || 0) + 1; if (stratPerf[m[1]]) { stratPerf[m[1]].losses = (stratPerf[m[1]].losses||0) + 1; } } }
      }
    } else {
      newPending.push(p);
    }
  }
  perf.winRate = perf.total > 0 ? (perf.wins / perf.total * 100).toFixed(1) : 0;
  for (var sid in stratPerf) {
    var s = stratPerf[sid];
    s.total = (s.wins||0) + (s.losses||0);
    s.winRate = s.total > 0 ? (s.wins / s.total * 100).toFixed(1) : '0.0';
  }
  config.performance = perf;
  config.strategyPerformance = stratPerf;
  config.consecutiveLosses = consecLosses;
  config.pendingDecisions = newPending;
  saveBotConfig(config);
  return config;
}

async function runBacktest(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var stocks = payload.stocks || [];
  if (!stocks.length) { sendJson(res, 400, { error: 'No stocks' }); return; }
  var results = [];
  for (var s of stocks) {
    try {
      var cRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1d&range=1y');
      var cData = await cRes.json();
      var ch = cData.chart && cData.chart.result && cData.chart.result[0];
      if (!ch || !ch.timestamp || !ch.indicators || !ch.indicators.quote) continue;
      var closes = ch.indicators.quote[0].close || [];
      var valid = closes.filter(function(v){return v!=null;});
      var ind = computeIndicators(valid);
      var half = Math.floor(valid.length / 2);
      var pastCloses = valid.slice(0, half);
      var futureCloses = valid.slice(half);
      var pastInd = computeIndicators(pastCloses);
      var prompt = 'Backtest: ' + s + ' last close=' + pastCloses[pastCloses.length-1] + ' RSI=' + (pastInd.rsi||0).toFixed(1) + ' MACD=' + (pastInd.macd||0).toFixed(2) + ' SMA50=' + (pastInd.sma50||0).toFixed(1) + ' SMA200=' + (pastInd.sma200||0).toFixed(1) + '\nBUY or SELL or HOLD? Reply JSON: {"action":"BUY|SELL|HOLD","confidence":"LOW|MED|HIGH"}';
      var up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization:'Bearer '+OPENROUTER_API_KEY, 'Content-Type':'application/json', 'HTTP-Referer':'http://localhost:3000' },
        body: JSON.stringify({ model: OPENROUTER_MODEL, messages:[{role:'user',content:prompt}], temperature:0.3, max_tokens:256 })
      });
      var upData = await up.json();
      var content = (upData.choices && upData.choices[0] && upData.choices[0].message && upData.choices[0].message.content) || '';
      content = content.replace(/```json|```/g,'').trim();
      var decision;
      try { decision = JSON.parse(content); } catch(e) { decision = {action:'HOLD',confidence:'LOW'}; }
      var entryPrice = pastCloses[pastCloses.length-1];
      var exitPrice = futureCloses[futureCloses.length-1] || entryPrice;
      var profit = decision.action === 'BUY' ? ((exitPrice - entryPrice) / entryPrice * 100) : (decision.action === 'SELL' ? ((entryPrice - exitPrice) / entryPrice * 100) : 0);
      results.push({ symbol: s, action: decision.action, confidence: decision.confidence, entryPrice: entryPrice, exitPrice: exitPrice, profitPct: profit.toFixed(2), correct: profit > 0 });
    } catch(e) {}
  }
  var wins = results.filter(function(r){return r.correct;}).length;
  sendJson(res, 200, { results: results, total: results.length, wins: wins, winRate: results.length ? (wins/results.length*100).toFixed(1) : 0 });
}

async function runBotCycle() {
  var config = loadBotConfig();
  if (!config.running || !config.stocks.length) return;
  if (!OPENROUTER_API_KEY) return;
  var quotes = {};
  var indicatorsData = {};
  // Fetch quotes + indicators for each stock
  for (var s of config.stocks) {
    try {
      var cRes, cData, ch;
      // Try intraday 1m first, fall back to 5m, then daily
      try { cRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1m&range=2d'); if (cRes.ok) { cData = await cRes.json(); ch = cData.chart && cData.chart.result && cData.chart.result[0]; } } catch(e){}
      if (!ch) { try { cRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=5m&range=5d'); if (cRes.ok) { cData = await cRes.json(); ch = cData.chart && cData.chart.result && cData.chart.result[0]; } } catch(e){} }
      if (!ch) { try { cRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?interval=1d&range=6mo'); if (cRes.ok) { cData = await cRes.json(); ch = cData.chart && cData.chart.result && cData.chart.result[0]; } } catch(e){} }
      if (ch) {
        var meta = ch.meta || {};
        var closes = ch.indicators && ch.indicators.quote && ch.indicators.quote[0] ? (ch.indicators.quote[0].close || []) : [];
        var validCloses = closes.filter(function(v){return v!=null;});
        // Use the last close from the data as current price (more recent than meta)
        var currentPrice = validCloses.length ? validCloses[validCloses.length-1] : meta.regularMarketPrice;
        quotes[s] = { symbol: meta.symbol || s, regularMarketPrice: currentPrice, metaPrice: meta.regularMarketPrice };
        if (validCloses.length) {
          indicatorsData[s] = computeIndicators(validCloses, ch.indicators.quote[0]);
        }
      }
    } catch(e) {}
  }
  // Update price change for pending decisions
  var pending = config.pendingDecisions || [];
  for (var p of pending) {
    var q = quotes[p.symbol] || {};
    var currentPrice = q.regularMarketPrice || 0;
    if (currentPrice && p.price) {
      p.priceChange = ((currentPrice - p.price) / p.price) * 100;
    }
  }
  config.pendingDecisions = pending;
  config = evaluatePastDecisions(config);
  BOT_STATUS = 'Calling AI for trading decisions...';
  var context = 'Market data (stocks with valid data only):\n\n';
  config.stocks.forEach(function(s){
    var q = quotes[s] || {};
    var ind = indicatorsData[s] || {};
    var price = q.regularMarketPrice;
    if (!price) return; // skip stocks with no price data
    var chg = q.regularMarketChangePercent || 0;
    context += s + ': Price=$' + price + ' Chg=' + (typeof chg==='number'?chg.toFixed(1)+'%':'N/A') +
      ' RSI=' + (ind.rsi || 'N/A') + ' MACD=' + (ind.macd || 'N/A') + ' MACD_Signal=' + (ind.macdSignal || 'N/A') + ' MACD_Hist=' + (ind.macdHistogram || 'N/A') +
      ' SMA50=' + (ind.sma50 || 'N/A') + ' SMA200=' + (ind.sma200 || 'N/A') +
      ' SMA50Above200=' + (ind.sma50Above200 ? 'Yes' : 'No') +
      ' Vol20dAvg=' + (ind.avgVolume ? Math.round(ind.avgVolume).toLocaleString() : 'N/A') +
      ' Range20d=' + (ind.range20 ? '$' + ind.range20.toFixed(2) + ' (' + ind.range20Pct.toFixed(1) + '%)' : 'N/A') +
      ' PricePosIn20dRange=' + (ind.posInRange != null ? ind.posInRange.toFixed(0) + '%' : 'N/A') + '\n';
  });
  if (context === 'Market data (stocks with valid data only):\n\n') {
    context += '(No real-time data available. Use technical judgment based on last known prices.)\n';
  }
  // === Market Regime Detector ===
  var uptrendCount = 0, totalWithData = 0, avgRsi = 0, rsiCount = 0;
  config.stocks.forEach(function(s){
    var ind = indicatorsData[s] || {};
    if (ind.sma50Above200 !== null) { uptrendCount += ind.sma50Above200 ? 1 : 0; totalWithData++; }
    if (ind.rsi != null) { avgRsi += ind.rsi; rsiCount++; }
  });
  var regime = 'Mixed';
  var uptrendPct = totalWithData > 0 ? (uptrendCount / totalWithData * 100) : 50;
  avgRsi = rsiCount > 0 ? (avgRsi / rsiCount) : 50;
  if (uptrendPct > 65 && avgRsi > 50) regime = 'Bullish 📈';
  else if (uptrendPct < 35 && avgRsi < 50) regime = 'Bearish 📉';
  else if (avgRsi > 30 && avgRsi < 70 && uptrendPct > 35 && uptrendPct < 65) regime = 'Range-bound ↔️';
  else if (avgRsi > 70) regime = 'Overbought ⚠️';
  else if (avgRsi < 30) regime = 'Oversold 💥';
  config.lastRegime = regime;
  // === Strategy Auto-Switch: ban strategies with 3+ consecutive losses ===
  var bannedStrats = [];
  var stratPerf = config.strategyPerformance || {};
  var consecLosses = config.consecutiveLosses || {};
  for (var sid in stratPerf) {
    if (consecLosses[sid] >= 3) bannedStrats.push(parseInt(sid));
  }
  var perf = config.performance || {};
  var recentDecisions = (config.pendingDecisions || []).filter(function(p){return p.age>0;}).slice(-5);
  var recentStr = recentDecisions.length ? recentDecisions.map(function(p){return p.symbol+' '+p.action+' age='+p.age+' priceChange='+(p.priceChange||0).toFixed(1)+'%';}).join('\n') : 'No recent decisions tracked yet.';
  var isLosing = (perf.winRate||0) < 50;
  var urgency = isLosing ? 'CRITICAL: Current strategy is losing money. You MUST change approach immediately.' : 'Keep maintaining profitable strategy.';
  var allStrategies = STRATEGIES.map(function(st){
    var note = '';
    if (bannedStrats.indexOf(st.id) >= 0) note = ' 🚫 BANNED (3+ consecutive losses)';
    else if ([1,2,3,5,21,24,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,81,82,83,84,85].indexOf(st.id) >= 0) note = ' ⚠️ Needs additional data';
    else if ([4,22,23,29,69].indexOf(st.id) >= 0) note = ' ⚠️ Needs perpetual/futures data';
    else if ([16,17,18,19,26,27,28,30,86,87,88,89,90].indexOf(st.id) >= 0) note = ' 📊 Position-sizing / grid';
    else if ([6,7,8,9,10,11,12,13,14,15,20,25,31,32,33,34,35,51,52,53,54,55,56,57,58,59,60,76,77,78,79,80,91,92,93,94,95,96,97,98,99,100].indexOf(st.id) >= 0) note = ' ✅ Available';
    return '#' + st.id + ' **' + st.name + '** | ' + st.risk + ' risk' + note;
  }).join('\n  ');
    // Add pending decisions to AI context so it knows what's active
    var currentPending = config.pendingDecisions || [];
    var pendingSummary = currentPending.length ? currentPending.map(function(p){return p.symbol+' '+p.action+' entry=₹'+p.price.toFixed(2)+' age='+p.age;}).join(', ') : 'No active pending decisions';
    var strategyGuidance = isLosing ?
    'STRATEGY SWITCH REQUIRED — current approach failing. Market regime: ' + regime + '. Banned strategies (3+ losses): ' + (bannedStrats.length ? '#' + bannedStrats.join(', #') : 'none') + '.\n\nAvailable strategies:\n  ' + allStrategies + '\n\nSelect ONE strategy per stock. Write strategy number + name in reason.' :
    'Continue current approach. Market regime: ' + regime + '.\n\nAvailable strategies:\n  ' + allStrategies;
  var prompt = 'You are an expert algorithmic trader. Performance: ' + (perf.total||0) + ' trades, ' + (perf.winRate||0) + '% win rate, P&L ₹' + (perf.pnl||0).toFixed(0) + '. ' + urgency + '\n\n' +
    strategyGuidance + '\n\n' +
    'Market data:\n\n' + context +
    '\nReturn JSON array of trades. At least 1 BUY or SELL per cycle. HOLD only if absolutely nothing is tradeable.\n' +
    '[{"symbol":"...","action":"BUY|SELL|HOLD","reason":"# strategy + indicators","quantity":N}] BUY qty 5-30, SELL qty=0 for all. Max 3 BUYs.';

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000' },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 2048 }),
  });
  var body = await upstream.json();
  var content = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
  content = content.replace(/```json|```/g, '').trim();
  var decisions;
  try { decisions = JSON.parse(content); } catch(e) { decisions = []; }
  if (!Array.isArray(decisions)) decisions = [];
  var portfolio = loadPortfolio();
  var history = loadPortfolioHistory();
  var log = config.log || [];
  config.cycleCount = (config.cycleCount || 0) + 1;
  // Force at least 1 BUY if AI returned nothing but HOLD
  var hasAction = decisions.some(function(d){ return d.action === 'BUY' || d.action === 'SELL'; });
  if (!hasAction) {
    var bestStock = null, bestScore = -Infinity;
    var heldSymbols = (portfolio.holdings || []).map(function(h){ return h.symbol; });
    for (var s of config.stocks) {
      var q = quotes[s];
      var ind = indicatorsData[s];
      if (!q || !q.regularMarketPrice || !ind) continue;
      var score = (ind.rsi ? (50 - Math.abs(ind.rsi - 50)) : 0) + (ind.macdHistogram > 0 ? 20 : -10) + (ind.sma50Above200 === true ? 15 : ind.sma50Above200 === false ? -15 : 0);
      // Prefer stocks not already held
      if (heldSymbols.indexOf(s) >= 0) score -= 50;
      if (score > bestScore) { bestScore = score; bestStock = { symbol: s, price: q.regularMarketPrice, ind: ind }; }
    }
    if (bestStock) {
      var qty = Math.max(1, Math.floor(portfolio.cash * 0.15 / bestStock.price));
      if (qty > 0) decisions.push({ symbol: bestStock.symbol, action: 'BUY', quantity: qty, reason: 'Auto-fallback #1 — best momentum score: RSI=' + (bestStock.ind.rsi||'N/A') + ' MACDh=' + (bestStock.ind.macdHistogram||0).toFixed(2) });
    }
  }
  BOT_STATUS = 'Processing ' + decisions.length + ' AI decisions...';
  var brokerConfig = loadBrokerConfig();
  var useReal = !config.training && brokerConfig && brokerConfig.connected && brokerConfig.broker === 'angel' && brokerConfig.apiKey && brokerConfig.clientId && brokerConfig.password;
  for (var d of decisions) {
    var q = quotes[d.symbol] || {};
    var price = q.regularMarketPrice || 0;
    if (!price) continue;
    var snap = d.symbol + ' ₹' + price;
    var ind = indicatorsData[d.symbol] || {};
    if (ind.rsi) snap += ' RSI=' + ind.rsi.toFixed(1);
    if (ind.macd) snap += ' MACD=' + ind.macd.toFixed(2);
    if (ind.sma50) snap += ' SMA50=' + ind.sma50.toFixed(1);
    if (ind.sma200) snap += ' SMA200=' + ind.sma200.toFixed(1);
    if (ind.sma50Above200 !== null) snap += ' Trend=' + (ind.sma50Above200 ? 'UP' : 'DOWN');
    if (ind.avgVolume) snap += ' Vol=' + Math.round(ind.avgVolume / 1000) + 'K';
    if (ind.posInRange != null) snap += ' RangePos=' + ind.posInRange.toFixed(0) + '%';
    d._snap = snap;
    if (d.action === 'BUY' && d.quantity > 0) {
      var cost = d.quantity * price;
      if (useReal) {
        var order = await angelPlaceOrder(brokerConfig, d.symbol, 'BUY', d.quantity, price);
        log.push({ cycle: config.cycleCount, type: 'BUY', symbol: d.symbol, quantity: d.quantity, price: price, reason: d.reason || '', data: d._snap, real: order && !order.error ? 'executed' : ('failed: ' + (order.error || 'unknown')) });
        if (order && order.error) continue;
      }
      if (cost <= portfolio.cash) {
        var existing = portfolio.holdings.find(function(h){return h.symbol===d.symbol;});
        if (existing) { existing.quantity += d.quantity; existing.avgCost = ((existing.avgCost * (existing.quantity - d.quantity)) + cost) / existing.quantity; }
        else { portfolio.holdings.push({ symbol: d.symbol, quantity: d.quantity, avgCost: price }); }
        portfolio.cash -= cost;
        history.push({ type: 'bot_buy', symbol: d.symbol, quantity: d.quantity, price: price, amount: cost, time: Date.now() });
        if (!useReal) log.push({ cycle: config.cycleCount, type: 'BUY', symbol: d.symbol, quantity: d.quantity, price: price, reason: d.reason || '', data: d._snap });
      }
    } else if (d.action === 'SELL') {
      var holding = portfolio.holdings.find(function(h){return h.symbol===d.symbol;});
      if (holding) {
        var sellQty = d.quantity > 0 ? Math.min(d.quantity, holding.quantity) : holding.quantity;
        if (useReal) {
          var order = await angelPlaceOrder(brokerConfig, d.symbol, 'SELL', sellQty, price);
          log.push({ cycle: config.cycleCount, type: 'SELL', symbol: d.symbol, quantity: sellQty, price: price, reason: d.reason || '', data: d._snap, real: order && !order.error ? 'executed' : ('failed: ' + (order.error || 'unknown')) });
          if (order && order.error) continue;
        }
        var proceeds = sellQty * price;
        portfolio.cash += proceeds;
        holding.quantity -= sellQty;
        history.push({ type: 'bot_sell', symbol: d.symbol, quantity: sellQty, price: price, amount: proceeds, time: Date.now() });
        if (!useReal) log.push({ cycle: config.cycleCount, type: 'SELL', symbol: d.symbol, quantity: sellQty, price: price, reason: d.reason || '', data: d._snap });
        if (holding.quantity <= 0) portfolio.holdings = portfolio.holdings.filter(function(h){return h.symbol!==d.symbol;});
      }
    }
  }
  // Always log a cycle summary entry so user sees bot is alive
  var tradeActions = decisions.filter(function(d){return d.action==='BUY'||d.action==='SELL';});
  var holdingsValue = 0;
  portfolio.holdings.forEach(function(h){
    var q = quotes[h.symbol] || {};
    holdingsValue += (q.regularMarketPrice || h.avgCost) * h.quantity;
  });
  var totalValue = portfolio.cash + holdingsValue;
  if (!tradeActions.length) {
    log.push({ cycle: config.cycleCount, type: 'CYCLE', symbol: '—', quantity: 0, price: 0, reason: 'No trade signals (HOLD all) · Portfolio: ₹' + totalValue.toFixed(0) });
  } else {
    log.push({ cycle: config.cycleCount, type: 'PORTFOLIO', symbol: '—', quantity: 0, price: 0, reason: 'Portfolio: ₹' + totalValue.toFixed(0) + ' (Cash: ₹' + portfolio.cash.toFixed(0) + ' · Holdings: ₹' + holdingsValue.toFixed(0) + ')' });
  }
  config.log = log.slice(-100);
  config.lastCycle = Date.now();
  config.lastSummary = decisions.map(function(d){return d.symbol+':'+d.action;}).join(', ');
  var pending = config.pendingDecisions || [];
  for (var d of decisions) {
    if (d.action !== 'HOLD' && d.quantity > 0) {
      var q = quotes[d.symbol] || {};
      var currentPrice = q.regularMarketPrice || 0;
      var existingPending = pending.find(function(p){ return p.symbol === d.symbol && p.action === d.action; });
      if (!existingPending) {
        pending.push({ symbol: d.symbol, action: d.action, quantity: d.quantity, price: currentPrice, priceChange: 0, age: 0 });
      }
    }
  }
  config.pendingDecisions = pending;
  BOT_LAST_RUN = Date.now();
  BOT_STATUS = 'Idle — next cycle in ~3 min';
  savePortfolio(portfolio);
  savePortfolioHistory(history);
  // Record portfolio value snapshot
  var valueSnapshots = loadPortfolioValueHistory();
  valueSnapshots.push({ time: Date.now(), value: totalValue });
  if (valueSnapshots.length > 2000) valueSnapshots = valueSnapshots.slice(-2000);
  savePortfolioValueHistory(valueSnapshots);
  // Track strategy performance per strategy #
  var stratPerf = config.strategyPerformance || {};
  for (var d of decisions) {
    if (d.action !== 'HOLD' && d.reason) {
      var match = d.reason.match(/#(\d+)/);
      if (match) {
        var sid = match[1];
        if (!stratPerf[sid]) stratPerf[sid] = { name: d.reason.split('|')[0].trim(), wins: 0, losses: 0, total: 0 };
        stratPerf[sid].total++;
      }
    }
  }
  config.strategyPerformance = stratPerf;
  // Circuit breaker
  if (config.maxDrawdown) {
    var initialCapital = config.initialCapital || (portfolio.cash + totalValue);
    if (!config.initialCapital) config.initialCapital = initialCapital;
    var drawdown = initialCapital > 0 ? ((initialCapital - totalValue) / initialCapital) * 100 : 0;
    if (drawdown > config.maxDrawdown) {
      config.running = false;
      if (BOT_INTERVAL) { clearInterval(BOT_INTERVAL); BOT_INTERVAL = null; }
      BOT_STATUS = 'STOPPED by circuit breaker — drawdown ' + drawdown.toFixed(1) + '% exceeded limit of ' + config.maxDrawdown + '%';
      // Liquidate all positions
      for (var h of portfolio.holdings || []) {
        portfolio.cash = (portfolio.cash || 0) + (h.currentPrice || h.avgCost) * h.quantity;
        history.push({ type: 'circuit_breaker_sell', symbol: h.symbol, quantity: h.quantity, price: h.currentPrice || h.avgCost, time: Date.now() });
      }
      portfolio.holdings = [];
      savePortfolio(portfolio);
      savePortfolioHistory(history);
    }
  }
  saveBotConfig(config);
}

async function handleBotConfigSave(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  config.stocks = Array.isArray(payload.stocks) ? payload.stocks.slice(0, 10) : config.stocks;
  saveBotConfig(config);
  sendJson(res, 200, { stocks: config.stocks.length });
}

async function handleBotStatus(req, res, url) {
  var token = url.searchParams.get('token') || '';
  if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  sendJson(res, 200, {
    running: config.running || false,
    status: BOT_STATUS || 'Idle',
    cycleCount: config.cycleCount || 0,
    lastCycle: config.lastCycle || null,
    lastRun: BOT_LAST_RUN,
    lastSummary: config.lastSummary || null,
    age: BOT_LAST_RUN ? Math.floor((Date.now() - BOT_LAST_RUN) / 1000) : null
  });
}

async function handleBotToggle(req, res, start) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  if (start && !config.stocks.length) { sendJson(res, 400, { error: 'No stocks configured' }); return; }
  if (start && !OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'OpenRouter API key not set — add OPENROUTER_API_KEY to .env' }); return; }
  if (payload.training !== undefined) config.training = payload.training;
  config.running = start;
  if (start) {
    config.startedAt = Date.now();
    // Clear stale pending decisions from previous sessions (no price data)
    if (config.pendingDecisions) {
      var stale = config.pendingDecisions.filter(function(p){ return p.age > 0 && (!p.priceChange || p.priceChange === 0); });
      if (stale.length) {
        config.pendingDecisions = config.pendingDecisions.filter(function(p){ return p.age === 0; });
      }
    }
    saveBotConfig(config);
    if (BOT_INTERVAL) clearInterval(BOT_INTERVAL);
    runBotCycle();
    BOT_INTERVAL = setInterval(runBotCycle, 180000);
  } else {
    config.running = false;
    // Force-evaluate all pending decisions immediately
    config = evaluatePastDecisions(config);
    // Score any remaining pending with forced age
    var pending = config.pendingDecisions || [];
    for (var p of pending) { p.age = 999; p._force = true; }
    config.pendingDecisions = pending;
    config = evaluatePastDecisions(config);
    config.running = false;
    saveBotConfig(config);
    if (BOT_INTERVAL) { clearInterval(BOT_INTERVAL); BOT_INTERVAL = null; }
    BOT_LAST_RUN = Date.now();
    BOT_STATUS = 'Stopped. Final performance: ' + (config.performance ? config.performance.total + ' trades, ' + config.performance.winRate + '% win rate, ₹' + (config.performance.pnl||0).toFixed(0) + ' P&L' : 'no trades');
  }
  sendJson(res, 200, { running: config.running, stocks: config.stocks.length, performance: config.performance, strategyPerformance: config.strategyPerformance });
}
async function handleBotStopSell(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  config.running = false;
  saveBotConfig(config);
  if (BOT_INTERVAL) { clearInterval(BOT_INTERVAL); BOT_INTERVAL = null; }
  BOT_STATUS = 'Stopped — all positions liquidated';
  // Sell all holdings at current market price
  var portfolio = loadPortfolio();
  var holdings = portfolio.holdings || [];
  var totalPnl = 0;
  var history = loadPortfolioHistory();
  for (var h of holdings) {
    try {
      var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(h.symbol) + '?interval=1d&range=5d');
      var d = await r.json();
      var meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      var price = meta ? (meta.regularMarketPrice || h.avgCost) : h.avgCost;
      var proceeds = price * h.quantity;
      var cost = h.avgCost * h.quantity;
      var pnl = proceeds - cost;
      totalPnl += pnl;
      portfolio.cash = (portfolio.cash || 0) + proceeds;
      history.push({ type: 'sell', symbol: h.symbol, quantity: h.quantity, price: price, amount: proceeds, time: Date.now() });
    } catch(e) {}
  }
  portfolio.holdings = [];
  savePortfolio(portfolio);
  savePortfolioHistory(history);
  sendJson(res, 200, { cash: portfolio.cash, pnl: totalPnl });
}
async function handleKill(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var token = url.searchParams.get('token') || '';
  if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  config.running = false;
  saveBotConfig(config);
  if (BOT_INTERVAL) { clearInterval(BOT_INTERVAL); BOT_INTERVAL = null; }
  BOT_STATUS = 'EMERGENCY KILL — all positions liquidated';
  var portfolio = loadPortfolio();
  var holdings = portfolio.holdings || [];
  var history = loadPortfolioHistory();
  for (var h of holdings) {
    try {
      var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(h.symbol) + '?interval=1d&range=5d');
      var d = await r.json();
      var meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      var price = meta ? (meta.regularMarketPrice || h.avgCost) : h.avgCost;
      portfolio.cash = (portfolio.cash || 0) + (price * h.quantity);
      history.push({ type: 'kill_switch', symbol: h.symbol, quantity: h.quantity, price: price, time: Date.now() });
    } catch(e) {}
  }
  portfolio.holdings = [];
  savePortfolio(portfolio);
  savePortfolioHistory(history);
  sendJson(res, 200, { status: 'killed', cash: portfolio.cash });
}

async function handleBotTraining(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  config.training = payload.training !== false;
  config.running = false;
  if (BOT_INTERVAL) { clearInterval(BOT_INTERVAL); BOT_INTERVAL = null; }
  saveBotConfig(config);
  sendJson(res, 200, { training: config.training });
}
async function handleBotCircuitBreaker(req, res) {
  var payload = await readJson(req);
  if (payload.token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var config = loadBotConfig();
  config.maxDrawdown = payload.maxDrawdown || 15;
  config.circuitBreakerTripped = false;
  config.initialCapital = undefined; // reset on reconfig
  saveBotConfig(config);
  sendJson(res, 200, { maxDrawdown: config.maxDrawdown, running: config.running });
}

async function handleAdminStats(req, res, url) {
  var token = url.searchParams.get('token') || '';
  if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var t = loadTracking();
  var recentRequests = (t.requestLog || []).slice(-20).reverse();
  sendJson(res, 200, {
    totalRequests: t.totalRequests || 0,
    uniqueVisitors: (t.uniqueIps || []).length,
    endpoints: t.endpointCounts || {},
    pageViews: t.pageViews || {},
    hourly: t.hourlyCounts || {},
    recentRequests: recentRequests
  });
}

async function handleCryptoPrices(req, res) {
  var symbols = ['BTC-USD','ETH-USD','SOL-USD','XRP-USD','ADA-USD','DOGE-USD','DOT-USD','LINK-USD','AVAX-USD'];
  try {
    var results = await Promise.all(symbols.map(async function(sym){
      try {
        var r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d');
        var d = await r.json();
        var meta = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
        if (!meta) return null;
        var quotes = d.chart.result[0].indicators && d.chart.result[0].indicators.quote && d.chart.result[0].indicators.quote[0];
        var closes = quotes ? quotes.close || [] : [];
        var prevClose = closes[closes.length - 2] || meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
        var change = meta.regularMarketPrice - prevClose;
        var changePercent = prevClose > 0 ? (change / prevClose * 100) : 0;
        return {
          symbol: meta.symbol || sym,
          name: meta.shortName || meta.longName || sym,
          price: meta.regularMarketPrice,
          change: change,
          changePercent: changePercent,
          marketCap: meta.marketCap,
          volume: meta.regularMarketVolume,
          high: meta.regularMarketDayHigh,
          low: meta.regularMarketDayLow
        };
      } catch(e) { return null; }
    }));
    sendJson(res, 200, { prices: results.filter(function(r){return r !== null;}) });
  } catch(e) {
    sendJson(res, 500, { error: 'Failed to fetch crypto prices' });
  }
}

async function handleAdminAdapt(req, res, url) {
  var token = url.searchParams.get('token') || '';
  if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }

  var companyName = (url.searchParams.get('company') || '').trim();

  // If a company is specified, act as a personal AI agent for that company
  if (companyName) {
    // Try to get cached profile
    var key = getCompanyKey(companyName);
    var cached = COMPANY_CACHE[key];
    var profileData = '';
    if (cached) {
      var prof = cached.profile || cached;
      profileData += 'Company: ' + (prof.name || companyName) + '\n';
      if (prof.ticker && prof.ticker !== 'N/A') profileData += 'Ticker: ' + prof.ticker + '\n';
      if (prof.sector) profileData += 'Sector: ' + prof.sector + '\n';
      if (prof.industry) profileData += 'Industry: ' + prof.industry + '\n';
      if (prof.description) profileData += 'Description: ' + prof.description + '\n';
      if (prof.employees) profileData += 'Employees: ' + prof.employees + '\n';
      if (prof.segments && prof.segments.length) {
        profileData += 'Business Segments:\n';
        prof.segments.forEach(function(s){ profileData += '  - ' + s.name + ' (' + (s.revenuePct||0) + '% of revenue): ' + (s.description||'') + '\n'; });
      }
      if (prof.competitors && prof.competitors.length) {
        profileData += 'Competitors: ' + prof.competitors.join(', ') + '\n';
      }
      if (cached.financials || cached.ratios) {
        var fin = cached.financials || {};
        var ratios = cached.ratios || {};
        profileData += '\nFinancial Data:\n';
        if (fin.revenue) profileData += 'Revenue (2020-2024): ' + JSON.stringify(fin.revenue) + '\n';
        if (fin.netIncome) profileData += 'Net Income: ' + JSON.stringify(fin.netIncome) + '\n';
        if (fin.totalDebt) profileData += 'Total Debt: ' + JSON.stringify(fin.totalDebt) + '\n';
        if (fin.freeCashFlow) profileData += 'Free Cash Flow: ' + JSON.stringify(fin.freeCashFlow) + '\n';
        if (ratios.peRatio) profileData += 'P/E: ' + ratios.peRatio + '\n';
        if (ratios.debtToEquity) profileData += 'D/E: ' + ratios.debtToEquity + '\n';
        if (ratios.roe) profileData += 'ROE: ' + ratios.roe + '%\n';
        if (ratios.currentRatio) profileData += 'Current Ratio: ' + ratios.currentRatio + '\n';
      }
    }

    var prompt = 'You are a personal AI business agent for ' + companyName + '. Your job is to monitor, analyze, and advise on this company as if it is your own business.\n\n' +
      (profileData ? 'Here is the data available:\n' + profileData + '\n\n' : 'No detailed profile cached yet. Use your general knowledge.\n\n') +
      'Analyze this company as a personal AI agent. Cover:\n' +
      '1. PRODUCT ANALYSIS — List the company\'s main products/services. Identify any flaws, weaknesses, or risks in their product lineup. Suggest improvements.\n' +
      '2. FINANCIAL HEALTH — Analyze revenue trends, profitability, debt levels, cash flow. Flag any red flags or concerns. Suggest corrections.\n' +
      '3. CORRECTIVE ACTIONS — What specific actions should the company take to fix the issues you identified?\n' +
      '4. MONITORING — What key metrics should be tracked weekly/monthly to stay ahead of problems?\n\n' +
      'Be direct, critical, and actionable. Respond in JSON format only:\n' +
      '{"products":[{"name":"...","flaws":"...","fix":"..."}],"financialHealth":{"status":"healthy|warning|critical","redFlags":["..."],"corrections":["..."]},"correctiveActions":["..."],"monitoring":{"metrics":["..."],"frequency":"..."}}';

    var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
      },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 2048 }),
    });
    var body = await upstream.json();
    var content = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
    try {
      var parsed = JSON.parse(content.replace(/```json|```/g, '').trim());
      sendJson(res, 200, parsed);
    } catch (_) {
      try { var m = content.match(/```json\s*([\s\S]*?)```/); if (m) { sendJson(res, 200, JSON.parse(m[1])); return; } } catch(_2) {}
      sendJson(res, 200, { products: [], financialHealth: { status: 'unknown', redFlags: [], corrections: [] }, correctiveActions: ['AI response could not be parsed'], monitoring: { metrics: [], frequency: 'weekly' } });
    }
    return;
  }

  // Fallback: usage-based suggestions (original behavior)
  var t = loadTracking();
  var topEndpoints = Object.entries(t.endpointCounts || {}).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]});
  var topPages = Object.entries(t.pageViews || {}).sort(function(a,b){return b[1]-a[1]}).slice(0,5).map(function(e){return e[0]});
  var totalReqs = t.totalRequests || 0;
  var uniqueVis = t.uniqueIps.length || 0;

  var prompt = 'You are an AI product strategist. Given this usage data for DARSO (a personal AI agency platform):\n' +
    '- Total requests: ' + totalReqs + '\n' +
    '- Unique visitors: ' + uniqueVis + '\n' +
    '- Top endpoints: ' + JSON.stringify(topEndpoints) + '\n' +
    '- Top pages: ' + JSON.stringify(topPages) + '\n\n' +
    'Suggest 2-3 actionable improvements to increase user engagement or retention. Give a short reasoning for each. ' +
    'Respond in JSON format: {"suggestions":[{"title":"...","reasoning":"..."}]}. No markdown.';

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1024 }),
  });
  var body = await upstream.json();
  var content = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '';
  try {
    var parsed = JSON.parse(content);
    sendJson(res, 200, parsed);
  } catch (_) {
    try { var m = content.match(/```json\s*([\s\S]*?)```/); if (m) { sendJson(res, 200, JSON.parse(m[1])); return; } } catch(_2) {}
    sendJson(res, 200, { suggestions: [{ title:'Review analytics manually', reasoning:'AI could not parse suggestions from usage data' }] });
  }
}

// ── CHART PREDICTION ──────────────────────────────────────────
async function handleChartPredict(req, res) {
  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }
  var payload = await readJson(req);
  var imageBase64 = payload.image || '';
  if (!imageBase64) { sendJson(res, 400, { error: 'Image data required' }); return; }

  var dataUrl = 'data:image/png;base64,' + imageBase64;
  var prompt = 'You are an expert technical analyst. Analyze this stock chart image and provide a concise prediction. Focus on:\n\n1. Chart pattern you observe (e.g., head and shoulders, triangle, flag, wedge, double top/bottom)\n2. Key support and resistance levels\n3. Trend direction (bullish/bearish/sideways)\n4. Volume analysis if visible\n5. Price prediction: is it more likely to go UP or DOWN in the next 1-2 weeks?\n6. Confidence level (Low/Medium/High)\n\nRespond in this exact JSON format (no markdown, no extra text):\n{\n  "pattern": "observed pattern name or \'unclear\'",\n  "trend": "bullish|bearish|sideways",\n  "prediction": "UP or DOWN",\n  "confidence": "Low|Medium|High",\n  "support": "key support level or \'N/A\'",\n  "resistance": "key resistance level or \'N/A\'",\n  "analysis": "2-3 sentence explanation of your reasoning"\n}';

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Chart Predictor'
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]}
      ],
      max_tokens: 800,
      temperature: 0.3
    })
  });

  var data = await upstream.json().catch(function(){ return {}; });
  if (!upstream.ok) {
    sendJson(res, 500, { error: (data.error && data.error.message) || 'AI request failed' });
    return;
  }

  var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  raw = raw.replace(/```json|```/g, '').trim();
  var start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) { sendJson(res, 500, { error: 'AI response was not valid JSON' }); return; }

  try { sendJson(res, 200, JSON.parse(raw.slice(start, end + 1))); }
  catch (e) { sendJson(res, 500, { error: 'Failed to parse prediction' }); }
}

// ── COMPANY DEEP-DIVE ────────────────────────────────────────────
var COMPANY_CACHE = {};
function getCompanyKey(name) { return name.trim().toUpperCase(); }

async function handleCompanyProfile(req, res) {
  var payload = await readJson(req);
  var companyName = (payload.name || payload.symbol || '').trim();
  if (!companyName) { sendJson(res, 400, { error: 'Company name or symbol required' }); return; }

  var key = getCompanyKey(companyName);
  if (COMPANY_CACHE[key]) { sendJson(res, 200, COMPANY_CACHE[key]); return; }

  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }

  var prompt = 'You are a financial data API. Given the company "' + companyName + '", respond ONLY with a valid JSON object (no markdown, no extra text):\n\n{\n  "profile": {\n    "name": "Full company name",\n    "ticker": "stock symbol if known",\n    "sector": "sector",\n    "industry": "industry",\n    "description": "2-3 sentence overview",\n    "website": "website URL",\n    "headquarters": "city, country",\n    "founded": year,\n    "employees": number,\n    "keyPeople": [{"name":"CEO name","title":"CEO"}],\n    "exchanges": ["NSE","BSE"]\n  },\n  "segments": [\n    {"name":"segment name","revenuePct": 45, "description":"what this segment does"}\n  ],\n  "competitors": ["COMP1","COMP2","COMP3"],\n  "peers": ["PEER1","PEER2"]\n}\n\nBe accurate. If you don\'t know the exact ticker use "N/A". If the company doesn\'t exist, respond with {"error": "company not found"}.' + (companyName.toLowerCase().includes('adani') ? '\n\nFor Adani companies: Adani Enterprises (ticker: ADANIENT.NS), Adani Ports (ADANIPORTS.NS), Adani Green (ADANIGREEN.NS), Adani Power (ADANIPOWER.NS), Adani Wilmar (AWL.NS). The group is Indian conglomerate.' : '');

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Company Intelligence'
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.3 })
  });

  var data = await upstream.json().catch(function() { return {}; });
  if (!upstream.ok) { sendJson(res, 500, { error: (data.error && data.error.message) || 'AI request failed' }); return; }

  var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  raw = raw.replace(/```json|```/g, '').trim();
  var start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) { sendJson(res, 500, { error: 'AI response was not valid JSON' }); return; }

  var result;
  try { result = JSON.parse(raw.slice(start, end + 1)); }
  catch (e) { sendJson(res, 500, { error: 'Failed to parse company profile' }); return; }

  if (result.error) { sendJson(res, 404, { error: result.error }); return; }

  COMPANY_CACHE[key] = result;
  // Also cache common alternatives
  if (result.ticker && result.ticker !== 'N/A') COMPANY_CACHE[getCompanyKey(result.ticker)] = result;
  sendJson(res, 200, result);
}

async function handleCompanyFinancials(req, res) {
  var payload = await readJson(req);
  var companyName = (payload.name || payload.symbol || '').trim();
  if (!companyName) { sendJson(res, 400, { error: 'Company name or symbol required' }); return; }

  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }

  var prompt = 'You are a financial data API. Given the company "' + companyName + '", respond ONLY with a valid JSON object (no markdown, no extra text):\n\n{\n  "financials": {\n    "revenue": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "netIncome": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "operatingIncome": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "totalAssets": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "totalDebt": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "freeCashFlow": {"2020": number_billions, "2021": number_billions, "2022": number_billions, "2023": number_billions, "2024": number_billions, "2025": number_billions_or_null},\n    "operatingMargin": {"2020": percent, "2021": percent, "2022": percent, "2023": percent, "2024": percent, "2025": percent_or_null},\n    "netMargin": {"2020": percent, "2021": percent, "2022": percent, "2023": percent, "2024": percent, "2025": percent_or_null},\n    "revenueGrowth": {"2021": percent, "2022": percent, "2023": percent, "2024": percent}\n  },\n  "ratios": {\n    "peRatio": number,\n    "forwardPE": number_or_null,\n    "pbRatio": number,\n    "roe": percent,\n    "roa": percent,\n    "debtToEquity": number,\n    "currentRatio": number,\n    "dividendYield": percent_or_null,\n    "beta": number_or_null\n  },\n  "keyMetrics": {\n    "marketCap": "string like $120B",\n    "avgVolume": number_or_null,\n    "shortPercent": number_or_null\n  },\n  "growth": {\n    "revenueCagr5y": percent,\n    "earningsCagr5y": percent,\n    "nextYearEstimate": percent_or_null\n  }\n}\n\nProvide the most accurate data you can. Use null for unknown values. All monetary values in billions of USD unless the company is primarily in India (use INR crores) and note the currency.';

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO Company Intelligence'
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 2500, temperature: 0.3 })
  });

  var data = await upstream.json().catch(function() { return {}; });
  if (!upstream.ok) { sendJson(res, 500, { error: (data.error && data.error.message) || 'AI request failed' }); return; }

  var raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  raw = raw.replace(/```json|```/g, '').trim();
  var start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) { sendJson(res, 500, { error: 'AI response was not valid JSON' }); return; }

  try { sendJson(res, 200, JSON.parse(raw.slice(start, end + 1))); }
  catch (e) { sendJson(res, 500, { error: 'Failed to parse financial data' }); }
}

async function handleCompanyAsk(req, res) {
  var payload = await readJson(req);
  var companyName = (payload.company || '').trim();
  var question = (payload.question || '').trim();
  if (!companyName || !question) { sendJson(res, 400, { error: 'company and question are required' }); return; }

  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }

  var prompt = 'You are a specialist analyst focused exclusively on ' + companyName + '. You have deep knowledge of this company\'s business model, financials, management, competitive position, risks, and growth prospects.';

  // Include profile context
  var key = getCompanyKey(companyName);
  var cached = COMPANY_CACHE[key];
  if (cached) {
    var prof = cached.profile || cached;
    prompt += '\n\nCompany Background:\n';
    if (prof.name) prompt += 'Name: ' + prof.name + '\n';
    if (prof.ticker && prof.ticker !== 'N/A') prompt += 'Ticker: ' + prof.ticker + '\n';
    if (prof.sector) prompt += 'Sector: ' + prof.sector + '\n';
    if (prof.industry) prompt += 'Industry: ' + prof.industry + '\n';
    if (prof.description) prompt += 'Description: ' + prof.description + '\n';
    if (prof.segments && prof.segments.length) {
      prompt += 'Business Segments:\n';
      prof.segments.forEach(function(s){ prompt += '  - ' + s.name + ' (' + (s.revenuePct||0) + '% of revenue): ' + (s.description||'') + '\n'; });
    }
    if (prof.competitors && prof.competitors.length) {
      prompt += 'Competitors: ' + prof.competitors.join(', ') + '\n';
    }
  }

  // Include user knowledge base
  var knowledge = payload.knowledge;
  if (knowledge && Array.isArray(knowledge) && knowledge.length > 0) {
    prompt += '\nPrivate Company Knowledge (provided by the company itself):\n';
    knowledge.forEach(function(k){
      prompt += '  [' + (k.tag||'general') + '] ' + k.text + '\n';
    });
  }

  prompt += '\nAnswer the following question thoroughly and concisely:\n\nQuestion: ' + question + '\n\nProvide specific data points, dates, and facts where possible. If you don\'t know something, say so openly. Focus on what matters most for an investor or business decision-maker.';

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO ' + companyName + ' Analyst'
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.4 })
  });

  var data = await upstream.json().catch(function() { return {}; });
  if (!upstream.ok) { sendJson(res, 500, { error: (data.error && data.error.message) || 'AI request failed' }); return; }

  sendJson(res, 200, { reply: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' });
}

async function handleCompanyCustom(req, res) {
  if (!OPENROUTER_API_KEY) { sendJson(res, 500, { error: 'AI not configured' }); return; }
  var payload = await readJson(req);
  var companyName = (payload.company || '').trim();
  var type = (payload.type || '').trim();
  if (!companyName || !type) { sendJson(res, 400, { error: 'company and type are required' }); return; }

  var prompts = {
    reputation: 'You are a market research analyst. Analyze the market reputation of ' + companyName + '. Cover:\n1. Brand perception in the market\n2. Customer sentiment (positive/negative/mixed)\n3. Media coverage and public relations\n4. Competitive positioning\n5. Any controversies or reputational risks\n6. Overall reputation score out of 10\n\nBe specific and provide reasoning.',
    products: 'You are a product analyst specializing in ' + companyName + '. Analyze their products/services:\n1. List their main products/services and their market position\n2. Which products are growing vs declining\n3. New product launches or upcoming releases\n4. Product quality and innovation\n5. How products compare to competitors\n6. Recommendations for product strategy',
    trends: 'You are a market trend analyst covering ' + companyName + '. Analyze the key market trends affecting this company:\n1. Industry trends (growth/decline areas)\n2. Technology changes impacting the business\n3. Regulatory changes on the horizon\n4. Consumer behavior shifts\n5. Competitive landscape changes\n6. Opportunities and threats\n7. 12-month outlook',
    dropshipping: 'You are a dropshipping product research expert. For a company like ' + companyName + ', suggest:\n1. Top 5 products they should sell next (with reasons)\n2. Product categories with highest growth potential\n3. Target audience recommendations\n4. Pricing strategy suggestions\n5. Marketing angles for each product\n6. Seasonal trends to capitalize on\n\nFocus on practical, profitable, and trending products.'
  };

  var prompt = prompts[type] || 'Analyze ' + companyName + ' for insights about ' + type + '. Provide detailed analysis with specific recommendations.';

  // Include profile context if cached
  var key = getCompanyKey(companyName);
  var cached = COMPANY_CACHE[key];
  if (cached) {
    var prof = cached.profile || cached;
    prompt += '\n\nCompany Background:\n';
    if (prof.name) prompt += 'Name: ' + prof.name + '\n';
    if (prof.ticker && prof.ticker !== 'N/A') prompt += 'Ticker: ' + prof.ticker + '\n';
    if (prof.sector) prompt += 'Sector: ' + prof.sector + '\n';
    if (prof.industry) prompt += 'Industry: ' + prof.industry + '\n';
    if (prof.description) prompt += 'Description: ' + prof.description + '\n';
    if (prof.segments && prof.segments.length) {
      prompt += 'Business Segments:\n';
      prof.segments.forEach(function(s){ prompt += '  - ' + s.name + ' (' + (s.revenuePct||0) + '%)\n'; });
    }
  }

  var upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'DARSO ' + companyName + ' ' + type
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.4 })
  });

  var data = await upstream.json().catch(function() { return {}; });
  if (!upstream.ok) { sendJson(res, 500, { error: (data.error && data.error.message) || 'AI request failed' }); return; }

  sendJson(res, 200, { reply: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' });
}

function serveStatic(req, res) {
  const rawPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.normalize(path.join(PUBLIC_DIR, rawPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4'
    };
    send(res, 200, data, { 'Content-Type': types[ext] || 'application/octet-stream' });
  });
}

const server = http.createServer((req, res) => {
  trackRequest(req);
  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      chat: Boolean(OPENROUTER_API_KEY),
      tts: Boolean(ELEVENLABS_API_KEY),
      model: OPENROUTER_MODEL
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    handleChat(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/tts') {
    handleTts(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/stock/info')) {
    handleStockInfo(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/stock/chart')) {
    handleStockChart(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/stock')) {
    handleStock(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/watchlist') {
    handleWatchlist(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/watchlist/scan') {
    handleWatchlistScan(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/watchlist/add') {
    handleWatchlistAdd(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/portfolio')) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/api/portfolio') {
      handlePortfolio(req, res).catch(err => sendJson(res, 500, { error: err.message }));
      return;
    }
    if (path === '/api/portfolio/history') {
      const token = url.searchParams.get('token') || '';
      if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
      const history = loadPortfolioHistory();
      sendJson(res, 200, { history });
      return;
    }
    if (path === '/api/portfolio/value-history') {
      const token = url.searchParams.get('token') || '';
      if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
      const points = loadPortfolioValueHistory();
      sendJson(res, 200, { points });
      return;
    }
  }
  if (req.method === 'POST' && req.url === '/api/portfolio/trade') {
    handleTrade(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/portfolio/analyze') {
    handlePortfolioAnalysis(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/portfolio/ai-invest') {
    handleAIAutoInvest(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/wallet/balance')) {
    const portfolio = loadPortfolio();
    sendJson(res, 200, { cash: portfolio.cash || 0 });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/wallet/deposit') {
    handleWalletDeposit(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/wallet/withdraw') {
    handleWalletWithdraw(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/wallet/broker')) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
    const broker = loadBrokerConfig();
    sendJson(res, 200, broker);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/wallet/broker') {
    handleBrokerConnect(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'DELETE' && req.url === '/api/wallet/broker') {
    handleBrokerDisconnect(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/stock/analyze') {
    handleStockAnalysis(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/notify') {
    handleNotify(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/admin/stats')) {
    const url = new URL(req.url, 'http://localhost');
    handleAdminStats(req, res, url).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/bot/config')) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
    const config = loadBotConfig();
    sendJson(res, 200, config);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/config') {
    handleBotConfigSave(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/start') {
    handleBotToggle(req, res, true).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/stop') {
    handleBotToggle(req, res, false).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/kill') {
    handleKill(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/stop-sell') {
    handleBotStopSell(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/backtest') {
    runBacktest(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/training') {
    handleBotTraining(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/bot/circuit-breaker') {
    handleBotCircuitBreaker(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/bot/status')) {
    const url = new URL(req.url, 'http://localhost');
    handleBotStatus(req, res, url).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/admin/adapt')) {
    const url = new URL(req.url, 'http://localhost');
    handleAdminAdapt(req, res, url).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/company/profile') {
    handleCompanyProfile(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/company/financials') {
    handleCompanyFinancials(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/company/ask') {
    handleCompanyAsk(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/company/custom') {
    handleCompanyCustom(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/predict/chart') {
    handleChartPredict(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/crypto/prices') {
    handleCryptoPrices(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin.html')) {
    const adminPath = path.join(__dirname, 'admin.html');
    fs.readFile(adminPath, (err, data) => {
      if (err) { send(res, 404, 'Admin page not found'); return; }
      send(res, 200, data, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    });
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  console.log(`DARSO running at http://localhost:${PORT}`);
});
