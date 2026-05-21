const http = require('http');
const fs = require('fs');
const path = require('path');
const fetch = globalThis.fetch || require('undici').fetch;

// Portfolio file storage
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');
const PORTFOLIO_HISTORY_FILE = path.join(__dirname, 'portfolio-history.json');

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
  const range = url.searchParams.get('range') || '3mo';
  if (!symbol) { sendJson(res, 400, { error: 'symbol parameter required' }); return; }
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const yahooOpts = { headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' } };
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const upstream = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`, yahooOpts);
      if (upstream.ok) {
        const data = await upstream.json().catch(() => ({}));
        const result = data.chart && data.chart.result && data.chart.result[0];
        if (result && result.timestamp && result.indicators && result.indicators.quote) {
          const timestamps = result.timestamp;
          const quotes = result.indicators.quote[0];
          const chartData = [];
          for (let i = 0; i < timestamps.length; i++) {
            if (quotes.close && quotes.close[i] != null) {
              chartData.push({ t: timestamps[i] * 1000, o: quotes.open[i], h: quotes.high[i], l: quotes.low[i], c: quotes.close[i], v: quotes.volume[i] });
            }
          }
          if (chartData.length) { sendJson(res, 200, { symbol, chartData }); return; }
        }
      }
    } catch (_) {}
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

function computeIndicators(candles) {
  if (!candles || candles.length < 50) return {};
  const closes = candles.map(c => c.c);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  return {
    sma50: sma50[sma50.length - 1],
    sma200: sma200[sma200.length - 1],
    rsi: rsi[rsi.length - 1],
    macd: macd.macdLine[macd.macdLine.length - 1],
    macdSignal: macd.signal[macd.signal.length - 1],
    macdHistogram: macd.histogram[macd.histogram.length - 1],
    sma50Above200: sma50[sma50.length - 1] !== null && sma200[sma200.length - 1] !== null
      ? sma50[sma50.length - 1] > sma200[sma200.length - 1] : null
  };
}

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
      if (q) return q;
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
        candles.push({
          t: timestamps[i] * 1000,
          o: o[i], h: h[i], l: l[i], c: c[i], v: v[i]
        });
      }
      return candles;
    } catch {}
  }
  return [];
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
  // Use fallback directly for immediate response (Yahoo v7 doesn't work for Indian stocks)
  const results = stocks.map(s => {
    const fb = getStockFallback(s.symbol);
    return {
      symbol: s.symbol,
      name: s.name,
      nse: s.nse,
      price: fb.price,
      change: fb.change,
      changePercent: fb.changePercent,
      volume: fb.volume,
      marketCap: null,
      high: fb.high || null,
      low: fb.low || null,
      peRatio: null,
      dividendYield: null,
      fiftyTwoWeekHigh: null,
      fiftyTwoWeekLow: null
    };
  });
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
    fetchYahooQuote(symbol),
    fetchYahooCandles(symbol)
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
        fetchYahooQuote(sym),
        fetchYahooCandles(sym)
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

async function handleAdminStats(req, res, url) {
  var token = url.searchParams.get('token') || '';
  if (token !== ADMIN_PASSWORD) { sendJson(res, 401, { error: 'Unauthorized' }); return; }
  var t = loadTracking();
  sendJson(res, 200, {
    totalRequests: t.totalRequests,
    uniqueVisitors: t.uniqueIps.length,
    endpoints: t.endpointCounts,
    hourly: t.hourlyCounts,
    pageViews: t.pageViews,
    recentRequests: (t.requestLog || []).slice(-50).reverse()
  });
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

  var prompt = 'You are a specialist analyst focused exclusively on ' + companyName + '. You have deep knowledge of this company\'s business model, financials, management, competitive position, risks, and growth prospects. Answer the following question thoroughly and concisely:\n\nQuestion: ' + question + '\n\nProvide specific data points, dates, and facts where possible. If you don\'t know something, say so openly. Focus on what matters most for an investor.';

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
  if (req.method === 'GET' && req.url === '/api/portfolio') {
    const portfolio = loadPortfolio();
    sendJson(res, 200, portfolio);
    return;
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
  if (req.method === 'POST' && req.url === '/api/stock/analyze') {
    handleStockAnalysis(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/portfolio/history') {
    const history = loadPortfolioHistory();
    sendJson(res, 200, { history });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/admin/stats')) {
    const url = new URL(req.url, 'http://localhost');
    handleAdminStats(req, res, url).catch(err => sendJson(res, 500, { error: err.message }));
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
  if (req.method === 'POST' && req.url === '/api/predict/chart') {
    handleChartPredict(req, res).catch(err => sendJson(res, 500, { error: err.message }));
    return;
  }
  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin.html')) {
    const adminPath = path.join(__dirname, 'admin.html');
    fs.readFile(adminPath, (err, data) => {
      if (err) { send(res, 404, 'Admin page not found'); return; }
      send(res, 200, data, { 'Content-Type': 'text/html; charset=utf-8' });
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
