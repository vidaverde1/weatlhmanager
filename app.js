// ═══════════════════════════════════════════════════════════════════════════
//  WealthTracker Pro — app.js
// ═══════════════════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────────────────
let assets          = JSON.parse(localStorage.getItem('wm_assets')    || '[]');
let displayCurrency = localStorage.getItem('wm_display_cur')          || 'USD';
let dolarBlue       = 0;
let sortKey         = 'value';
let sortDir         = -1;
let editId          = null;
let chartTipo       = null;
let chartLoc        = null;
let chartHistory    = null;

// ── Live prices state ──────────────────────────────────────────────────────
let priceStatus      = {};
let lastPriceUpdate  = null;
let isFetching       = false;
let autoRefreshTimer = null;
const REFRESH_MS     = 60_000;

// ── Persistence ────────────────────────────────────────────────────────────
const save = () => { localStorage.setItem('wm_assets', JSON.stringify(assets)); schedulePush(); };
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Dolar Blue ─────────────────────────────────────────────────────────────
const BLUE_KEY = 'wm_blue_cache';
const BLUE_TTL = 5 * 60 * 1000;

const fetchDolarBlue = async (force = false) => {
  const cached = JSON.parse(localStorage.getItem(BLUE_KEY) || 'null');
  if (!force && cached && Date.now() - cached.ts < BLUE_TTL) {
    dolarBlue = cached.rate; updateBlueUI(); return;
  }
  const btn = document.getElementById('blue-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const res  = await fetch('https://api.bluelytics.com.ar/v2/latest');
    const data = await res.json();
    dolarBlue  = data.blue.value_sell;
    localStorage.setItem(BLUE_KEY, JSON.stringify({ rate: dolarBlue, ts: Date.now() }));
  } catch { dolarBlue = cached?.rate || 0; }
  if (btn) btn.classList.remove('spinning');
  updateBlueUI();
};
const refreshBlue = () => fetchDolarBlue(true);

const updateBlueUI = () => {
  const el = document.getElementById('blue-rate');
  if (el) el.textContent = dolarBlue
    ? '$ ' + Number(dolarBlue).toLocaleString('es-AR', { maximumFractionDigits: 0 })
    : '—';
  // show "Blue" label on wider screens
  const lbl = document.getElementById('blue-label');
  if (lbl) lbl.style.display = window.innerWidth >= 480 ? 'inline' : 'none';
};

// ── Currency conversion ────────────────────────────────────────────────────
const toDisplay = (amount, fromCur) => {
  if (fromCur === displayCurrency || !dolarBlue) return amount;
  return fromCur === 'ARS' ? amount / dolarBlue : amount * dolarBlue;
};

const setDisplay = cur => {
  displayCurrency = cur;
  localStorage.setItem('wm_display_cur', cur);
  document.getElementById('toggle-usd').classList.toggle('active', cur === 'USD');
  document.getElementById('toggle-ars').classList.toggle('active', cur === 'ARS');
  renderAll();
  if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
};

// ── CoinGecko ID map ───────────────────────────────────────────────────────
const CRYPTO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', USDT:'tether', BNB:'binancecoin',
  SOL:'solana', XRP:'ripple', USDC:'usd-coin', ADA:'cardano',
  AVAX:'avalanche-2', DOGE:'dogecoin', TRX:'tron', DOT:'polkadot',
  LINK:'chainlink', MATIC:'matic-network', POL:'matic-network',
  SHIB:'shiba-inu', DAI:'dai', LTC:'litecoin', UNI:'uniswap',
  ATOM:'cosmos', XLM:'stellar', ETC:'ethereum-classic', NEAR:'near',
  BCH:'bitcoin-cash', APT:'aptos', OP:'optimism', ARB:'arbitrum',
  AAVE:'aave', FTM:'fantom', ALGO:'algorand', VET:'vechain',
  FIL:'filecoin', HBAR:'hedera-hashgraph', SAND:'the-sandbox',
  MANA:'decentraland', CRV:'curve-dao-token', MKR:'maker',
  GRT:'the-graph', SUSHI:'sushi', YFI:'yearn-finance',
  WLD:'worldcoin-wld', PEPE:'pepe', RENDER:'render-token',
  IMX:'immutable-x', INJ:'injective-protocol', SUI:'sui',
  SEI:'sei-network', TAO:'bittensor',
};

// ── Yahoo Finance & CoinGecko fetchers ─────────────────────────────────────
const fetchYahooQuote = async ticker => {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`
  );
  if (!res.ok) throw new Error(`YF ${res.status}`);
  const meta = (await res.json())?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('sin precio');
  return { price: meta.regularMarketPrice, currency: (meta.currency || 'USD').toUpperCase() };
};

const fetchCoinGeckoBatch = async cryptoAssets => {
  const ids = [...new Set(cryptoAssets.map(a => CRYPTO_IDS[a.ticker.toUpperCase()]).filter(Boolean))];
  if (!ids.length) return {};
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error(`CG ${res.status}`);
  return res.json();
};

const applyYahooPrice = (a, yahooPrice, yahooCurrency) => {
  const aCur = assetCur(a);
  if (yahooCurrency === aCur || !dolarBlue) a.currentPrice = yahooPrice;
  else if (yahooCurrency === 'USD' && aCur === 'ARS') a.currentPrice = yahooPrice * dolarBlue;
  else if (yahooCurrency === 'ARS' && aCur === 'USD') a.currentPrice = yahooPrice / dolarBlue;
  else a.currentPrice = yahooPrice;
};

// ── Price fetch orchestrator ───────────────────────────────────────────────
const fetchAllPrices = async () => {
  if (isFetching) return;
  isFetching = true;
  setPriceUIState('loading');

  assets.filter(a => ['Propiedades','Money Market','Mercaderia','Vehiculos'].includes(a.type))
        .forEach(a => { priceStatus[a.id] = 'unavailable'; });
  assets.filter(a => ['Acciones','CEDEARs','Bonos','Cripto'].includes(a.type))
        .forEach(a => { priceStatus[a.id] = 'loading'; });

  const yahooAssets = assets.filter(a => ['Acciones','CEDEARs','Bonos'].includes(a.type));
  const yahooResults = await Promise.allSettled(yahooAssets.map(async a => {
    let ticker = a.ticker.toUpperCase();
    if ((a.type === 'CEDEARs' || a.type === 'Bonos') && !ticker.includes('.')) ticker += '.BA';
    const { price, currency } = await fetchYahooQuote(ticker);
    applyYahooPrice(a, price, currency);
    priceStatus[a.id] = 'live';
  }));
  yahooAssets.forEach((a, i) => { if (yahooResults[i].status === 'rejected') priceStatus[a.id] = 'error'; });

  const cryptoAssets = assets.filter(a => a.type === 'Cripto');
  if (cryptoAssets.length) {
    try {
      const cgData = await fetchCoinGeckoBatch(cryptoAssets);
      cryptoAssets.forEach(a => {
        const usdPrice = cgData[CRYPTO_IDS[a.ticker.toUpperCase()]]?.usd;
        if (usdPrice != null) {
          a.currentPrice = assetCur(a) === 'ARS' ? usdPrice * dolarBlue : usdPrice;
          priceStatus[a.id] = 'live';
        } else { priceStatus[a.id] = 'error'; }
      });
    } catch { cryptoAssets.forEach(a => { priceStatus[a.id] = 'error'; }); }
  }

  save();
  lastPriceUpdate = Date.now();
  isFetching = false;
  setPriceUIState('done');
  renderAll();
  if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
};

const setPriceUIState = state => {
  ['btn-refresh-prices','btn-refresh-prices-portfolio'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = state === 'loading';
    btn.classList.toggle('spinning', state === 'loading');
  });
  if (state === 'done' && lastPriceUpdate) {
    const live = Object.values(priceStatus).filter(s => s === 'live').length;
    const err  = Object.values(priceStatus).filter(s => s === 'error').length;
    const time = new Date(lastPriceUpdate).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const txt  = `${live} live${err ? ` · ${err} sin datos` : ''} · ${time}`;
    ['price-update-time','price-update-time-portfolio'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = txt;
    });
  }
};

const priceDot = id => {
  const map = { live:['live','Live'], error:['error','Sin datos'], unavailable:['manual','Manual'], loading:['loading','Actualizando…'] };
  const [cls, title] = map[priceStatus[id]] || ['manual','Manual'];
  return `<span class="price-dot ${cls}" title="${title}"></span>`;
};

const startAutoRefresh = () => {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => { if (!document.hidden && assets.length) fetchAllPrices(); }, REFRESH_MS);
};
const stopAutoRefresh = () => { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } };

// ── Export / Import ────────────────────────────────────────────────────────
const exportData = () => {
  const payload = JSON.stringify({ version:1, exportedAt: new Date().toISOString(), assets }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([payload], { type:'application/json' })),
    download: `wealthtracker-${new Date().toISOString().slice(0,10)}.json`,
  });
  a.click(); URL.revokeObjectURL(a.href);
};

const importData = e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const raw = JSON.parse(ev.target.result);
      const imported = Array.isArray(raw) ? raw : (raw.assets || []);
      if (!imported.length) throw new Error('El archivo no contiene activos.');
      const existingIds = new Set(assets.map(a => a.id));
      const added = imported.filter(a => !existingIds.has(a.id));
      assets = [...assets, ...added];
      save(); renderAll();
      showToast(`✓ ${added.length} activos importados. ${imported.length - added.length} ya existían.`, 'ok');
    } catch (err) { showToast('Error al importar: ' + err.message, 'error'); }
  };
  reader.readAsText(file); e.target.value = '';
};

// ── Cloud sync (JSONBin.io) ────────────────────────────────────────────────
const SYNC_KEY   = 'wm_sync_cfg';
const BIN_URL    = 'https://api.jsonbin.io/v3/b';
let syncCfg      = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
let syncPushTimer = null;

const saveSyncCfg = () => localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));

const schedulePush = () => {
  if (!syncCfg?.binId) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => cloudPush().catch(() => setSyncDot('error')), 1500);
};

const binHeaders = (extra = {}) => ({
  'Content-Type': 'application/json', 'X-Master-Key': syncCfg.apiKey, ...extra
});

const cloudPush = async () => {
  const body = JSON.stringify({ assets, syncedAt: Date.now() });
  if (syncCfg.binId) {
    const r = await fetch(`${BIN_URL}/${syncCfg.binId}`, { method:'PUT', headers:binHeaders(), body });
    if (!r.ok) throw new Error(`PUT ${r.status}`);
  } else {
    const r = await fetch(BIN_URL, {
      method:'POST',
      headers: binHeaders({ 'X-Bin-Name':'WealthTracker', 'X-Bin-Private':'true' }),
      body,
    });
    if (!r.ok) throw new Error(`POST ${r.status}`);
    syncCfg.binId = (await r.json()).metadata.id;
    saveSyncCfg(); refreshSyncUI();
  }
  syncCfg.lastSync = Date.now(); saveSyncCfg(); setSyncDot('ok');
};

const cloudPull = async () => {
  const r = await fetch(`${BIN_URL}/${syncCfg.binId}/latest`, { headers:{'X-Master-Key':syncCfg.apiKey} });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  return (await r.json()).record;
};

const mergeAssets = (local, cloud) => {
  const map = {};
  local.forEach(a => { map[a.id] = a; });
  cloud.forEach(a => { map[a.id] = a; });
  return Object.values(map);
};

const openSyncModal  = () => { refreshSyncUI(); document.getElementById('sync-modal').classList.remove('hidden'); lucide.createIcons(); };
const closeSyncModal = () => document.getElementById('sync-modal').classList.add('hidden');
const closeSyncModalOutside = e => { if (e.target.id === 'sync-modal') closeSyncModal(); };

const setupSync = async () => {
  const apiKey = document.getElementById('sync-api-key').value.trim();
  const binId  = document.getElementById('sync-bin-id').value.trim();
  if (!apiKey) { setSyncMsg('Ingresá tu Master Key de JSONBin.io.', 'error'); return; }
  syncCfg = { apiKey, binId: binId || null, lastSync: null };
  setBtnLoading('btn-connect-sync', true);
  setSyncMsg('Conectando…', 'loading');
  try {
    if (syncCfg.binId) {
      setSyncMsg('Descargando datos de la nube…', 'loading');
      const cloudData = await cloudPull();
      assets = mergeAssets(assets, cloudData.assets || []);
      localStorage.setItem('wm_assets', JSON.stringify(assets));
    }
    setSyncMsg('Subiendo datos…', 'loading');
    await cloudPush();
    renderAll();
    if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
    setSyncMsg(`✓ Sincronizado — ${assets.length} activos en la nube`, 'ok');
  } catch (err) { syncCfg = null; saveSyncCfg(); setSyncMsg('Error: ' + err.message, 'error'); }
  setBtnLoading('btn-connect-sync', false); refreshSyncUI();
};

const syncNow = async () => {
  if (!syncCfg?.binId) return;
  setBtnLoading('btn-sync-now', true); setSyncMsg('Sincronizando…', 'loading');
  try {
    const cloudData = await cloudPull();
    assets = mergeAssets(assets, cloudData.assets || []);
    localStorage.setItem('wm_assets', JSON.stringify(assets));
    await cloudPush(); renderAll();
    if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
    setSyncMsg(`✓ Sincronizado · ${assets.length} activos`, 'ok');
  } catch (err) { setSyncMsg('Error: ' + err.message, 'error'); }
  setBtnLoading('btn-sync-now', false);
};

const disconnectSync = () => {
  if (!confirm('¿Desconectar sincronización? Tus datos locales no se borran.')) return;
  syncCfg = null; localStorage.removeItem(SYNC_KEY); refreshSyncUI();
  setSyncMsg('Sincronización desconectada.', 'error');
};

const copyBinId = () => {
  navigator.clipboard?.writeText(syncCfg?.binId || '').then(() => showToast('Bin ID copiado.', 'ok'));
};

const refreshSyncUI = () => {
  const connected = !!syncCfg?.binId;
  const el = id => document.getElementById(id);
  if (el('sync-api-key')) el('sync-api-key').value = syncCfg?.apiKey || '';
  if (el('sync-bin-id'))  el('sync-bin-id').value  = syncCfg?.binId  || '';
  toggle('sync-copy-btn',  connected);
  toggle('btn-sync-now',   connected);
  toggle('btn-disconnect', connected);
  setSyncDot(connected ? 'ok' : null);
  const badge = el('sync-badge');
  if (badge) badge.classList.toggle('hidden', !connected);
};

const setSyncMsg = (msg, state) => {
  const el = document.getElementById('sync-status-msg'); if (!el) return;
  el.textContent = msg;
  el.className = `text-xs mt-3 ${state==='ok' ? 'pos' : state==='error' ? 'neg' : 'text-amber-400'}`;
};
const setSyncDot = state => {
  const el = document.getElementById('sync-status-badge'); if (!el) return;
  if (!state) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden'); el.className = `sync-dot-badge ${state}`;
};
const toggle        = (id, show) => document.getElementById(id)?.classList.toggle('hidden', !show);
const setBtnLoading = (id, on) => { const b = document.getElementById(id); if (b) { b.disabled = on; b.classList.toggle('spinning', on); } };

const initSync = async () => {
  refreshSyncUI();
  if (!syncCfg?.binId) return;
  setSyncDot('loading');
  try {
    const cloudData = await cloudPull();
    const before = assets.length;
    assets = mergeAssets(assets, cloudData.assets || []);
    localStorage.setItem('wm_assets', JSON.stringify(assets));
    if (assets.length !== before) renderAll();
    syncCfg.lastSync = Date.now(); saveSyncCfg(); setSyncDot('ok');
  } catch { setSyncDot('error'); }
};

// ── Theme maps ─────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  'Acciones':'#3b82f6', 'CEDEARs':'#8b5cf6', 'Bonos':'#f59e0b',
  'Cripto':'#10b981', 'Propiedades':'#f97316', 'Money Market':'#06b6d4',
  'Mercaderia':'#e879f9', 'Vehiculos':'#fb7185',
};
const LOC_COLORS  = { 'Exchange':'#6366f1', 'Banco':'#0ea5e9', 'Fisico':'#84cc16' };
const TYPE_BADGE  = {
  'Acciones':'bg-blue-500/20 text-blue-400', 'CEDEARs':'bg-violet-500/20 text-violet-400',
  'Bonos':'bg-amber-500/20 text-amber-400', 'Cripto':'bg-emerald-500/20 text-emerald-400',
  'Propiedades':'bg-orange-500/20 text-orange-400', 'Money Market':'bg-cyan-500/20 text-cyan-400',
  'Mercaderia':'bg-fuchsia-500/20 text-fuchsia-400', 'Vehiculos':'bg-rose-500/20 text-rose-400',
};

// ── Formatters ─────────────────────────────────────────────────────────────
const fmtMoney = v => displayCurrency === 'ARS'
  ? 'ARS ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits:0, maximumFractionDigits:0 })
  : 'USD ' + Number(v).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

const fmtNative = (v, cur) => cur === 'ARS'
  ? 'ARS ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits:0, maximumFractionDigits:0 })
  : 'USD ' + Number(v).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });

const fmtNum = v => Number(v).toLocaleString('en-US', { maximumFractionDigits:6 });
const fmtPct = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';

// ── Calculations ───────────────────────────────────────────────────────────
const assetCur      = a => a.currency || 'USD';
const calcCostDisp  = a => toDisplay(a.purchasePrice * a.nominals, assetCur(a));
const calcValueDisp = a => toDisplay(a.currentPrice  * a.nominals, assetCur(a));
const calcPnlDisp   = a => calcValueDisp(a) - calcCostDisp(a);
const calcPct       = a => a.purchasePrice ? (a.currentPrice - a.purchasePrice) / a.purchasePrice * 100 : 0;

const enrich = a => ({
  ...a,
  cost:  calcCostDisp(a),
  value: calcValueDisp(a),
  pnl:   calcPnlDisp(a),
  pct:   calcPct(a),
});

// ── Helpers ────────────────────────────────────────────────────────────────
const setText  = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
const curBadge = cur => `<span class="cur-badge ${cur==='USD'?'cur-usd':'cur-ars'}">${cur}</span>`;

const showToast = (msg, type = 'ok') => {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = Object.assign(document.createElement('div'), { className:`toast ${type}`, textContent:msg });
  document.body.appendChild(t);
  requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add('show')); });
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
};

// ── Date quick-select ──────────────────────────────────────────────────────
const setQuickDate = offset => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  document.getElementById('f-date').value = d.toISOString().slice(0, 10);
};

// ── Portfolio Snapshots (history chart) ────────────────────────────────────
const HISTORY_KEY  = 'wm_portfolio_history';
const MAX_HISTORY  = 90;

const saveSnapshot = () => {
  if (!assets.length || !dolarBlue) return;
  const today    = new Date().toISOString().slice(0, 10);
  // Always snapshot in USD for consistent long-term tracking
  const totalUSD = assets.reduce((s, a) => {
    const v = a.currentPrice * a.nominals;
    return s + (assetCur(a) === 'ARS' ? v / dolarBlue : v);
  }, 0);
  if (!totalUSD) return;
  let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const idx = history.findIndex(s => s.d === today);
  if (idx >= 0) history[idx].v = totalUSD;
  else history.push({ d: today, v: totalUSD });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
};

const renderHistoryChart = () => {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  const section = document.getElementById('history-section');
  if (!section) return;
  if (history.length < 2) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  if (chartHistory) { chartHistory.destroy(); chartHistory = null; }

  // Convert stored USD values to displayCurrency
  const values = history.map(s => displayCurrency === 'USD' ? s.v : s.v * dolarBlue);
  const growing = values[values.length - 1] >= values[0];
  const color   = growing ? '#10b981' : '#f87171';

  const pctChange = values[0] ? ((values[values.length-1] - values[0]) / values[0] * 100).toFixed(2) : 0;
  const periodEl  = document.getElementById('history-period');
  if (periodEl) periodEl.textContent = `${history.length} días · ${pctChange >= 0 ? '+' : ''}${pctChange}%`;

  chartHistory = new Chart(document.getElementById('chart-history').getContext('2d'), {
    type: 'line',
    data: {
      labels: history.map(s => s.d),
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: growing ? 'rgba(16,185,129,0.06)' : 'rgba(248,113,113,0.06)',
        fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:'#1e293b', borderColor:'#334155', borderWidth:1,
          titleColor:'#f1f5f9', bodyColor:'#94a3b8',
          callbacks: { label: ctx => '  ' + fmtMoney(ctx.raw) },
        },
      },
      scales: {
        x: { grid:{ display:false }, ticks:{ color:'#475569', maxTicksLimit:6, font:{size:10} } },
        y: { grid:{ color:'#1e293b40' }, ticks:{ color:'#475569', font:{size:10}, callback: v => fmtMoney(v).split(' ')[1] } },
      },
    },
  });
};

// ── Top Movers ─────────────────────────────────────────────────────────────
const renderTopMovers = () => {
  const section = document.getElementById('movers-section');
  const el      = document.getElementById('top-movers');
  if (!section || !el) return;
  if (!assets.length) { section.classList.add('hidden'); return; }

  const enriched = assets.map(enrich).sort((a, b) => b.pct - a.pct);
  const best    = enriched[0];
  const worst   = enriched[enriched.length - 1];
  const biggest = [...enriched].sort((a, b) => b.value - a.value)[0];
  const latest  = [...assets].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];

  const card = (label, a, extra = '') => `
    <div class="mover-card ${extra}">
      <p style="font-size:9px;color:#475569;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${label}</p>
      <p class="font-mono font-bold text-white" style="font-size:14px">${a.ticker}</p>
      <p class="text-xs" style="color:#64748b;margin-top:1px">${TYPE_BADGE[a.type] ? a.type : ''}</p>
      <p class="font-medium text-xs mt-2 ${a.pct >= 0 ? 'pos' : 'neg'}">${fmtPct(a.pct)}</p>
      <p style="font-size:11px;color:#475569;margin-top:2px">${fmtMoney(enrich(a).value)}</p>
    </div>`;

  section.classList.remove('hidden');
  el.innerHTML =
    card('Mejor rendimiento', best, 'winner') +
    card('Peor rendimiento', worst, 'loser') +
    card('Mayor posición', biggest) +
    card('Más reciente', latest);
};

// ── Allocation Bar ─────────────────────────────────────────────────────────
const renderAllocationBar = () => {
  const section = document.getElementById('alloc-section');
  const bar     = document.getElementById('alloc-bar');
  const legend  = document.getElementById('alloc-legend');
  if (!section || !bar || !legend) return;

  const total = assets.reduce((s, a) => s + calcValueDisp(a), 0);
  if (!total) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const byType = {};
  assets.forEach(a => { byType[a.type] = (byType[a.type] || 0) + calcValueDisp(a); });
  const entries = Object.entries(byType).sort(([,a],[,b]) => b - a);

  bar.innerHTML = entries.map(([type, val]) =>
    `<div class="alloc-segment" style="width:${(val/total*100).toFixed(2)}%;background:${TYPE_COLORS[type]||'#6b7280'}"></div>`
  ).join('');

  legend.innerHTML = entries.map(([type, val]) => `
    <div style="display:flex;align-items:center;gap:5px">
      <span style="width:8px;height:8px;border-radius:2px;background:${TYPE_COLORS[type]||'#6b7280'};display:inline-block;flex-shrink:0"></span>
      <span style="font-size:11px;color:#64748b">${type}</span>
      <span style="font-size:11px;color:#334155">${(val/total*100).toFixed(1)}%</span>
    </div>
  `).join('');
};

// ── View switching ─────────────────────────────────────────────────────────
const showView = id => {
  ['dashboard','portfolio'].forEach(v => {
    document.getElementById(`view-${v}`)?.classList.toggle('hidden', v !== id);
    document.getElementById(`tab-${v}`)?.classList.toggle('active', v === id);
    document.getElementById(`bottom-${v}`)?.classList.toggle('active', v === id);
  });
  if (id === 'portfolio') renderPortfolio();
  if (id === 'dashboard') renderAll();
};

// ── KPIs ───────────────────────────────────────────────────────────────────
const renderKPIs = () => {
  const totalValue = assets.reduce((s, a) => s + calcValueDisp(a), 0);
  const totalCost  = assets.reduce((s, a) => s + calcCostDisp(a),  0);
  const pnl        = totalValue - totalCost;
  const pct        = totalCost ? pnl / totalCost * 100 : 0;
  const best       = assets.length ? assets.reduce((b, a) => calcPct(a) > calcPct(b) ? a : b) : null;

  setText('kpi-patrimonio',   fmtMoney(totalValue));
  setText('kpi-assets-count', `${assets.length} activo${assets.length!==1?'s':''} · ${displayCurrency}`);

  const pnlEl = document.getElementById('kpi-pnl');
  if (pnlEl) { pnlEl.textContent = fmtMoney(pnl); pnlEl.className = `kpi-value ${pnl>=0?'pos':'neg'}`; }

  const pnlPctEl = document.getElementById('kpi-pnl-pct');
  if (pnlPctEl) { pnlPctEl.textContent = fmtPct(pct) + ' vs costo'; pnlPctEl.className = `kpi-sub ${pnl>=0?'pos':'neg'}`; }

  const rendEl = document.getElementById('kpi-rendimiento');
  if (rendEl) { rendEl.textContent = fmtPct(pct); rendEl.className = `kpi-value ${pct>=0?'pos':'neg'}`; }

  setText('kpi-mejor', best ? `Mejor: ${best.ticker} (${fmtPct(calcPct(best))})` : '— sin activos');
};

// ── Charts ─────────────────────────────────────────────────────────────────
const makeDonut = (canvasId, labels, data, colors) => {
  const ctx   = document.getElementById(canvasId)?.getContext('2d');
  if (!ctx) return null;
  const total = data.reduce((s, v) => s + v, 0);
  return new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets:[{ data, backgroundColor:colors, borderWidth:2, borderColor:'#0f172a', hoverOffset:6 }] },
    options: {
      responsive:true, maintainAspectRatio:false, cutout:'68%',
      plugins: {
        legend: { position:'right', labels:{ color:'#94a3b8', font:{size:10}, padding:12, boxWidth:10, boxHeight:10, borderRadius:3 } },
        tooltip: {
          backgroundColor:'#1e293b', borderColor:'#334155', borderWidth:1,
          titleColor:'#f1f5f9', bodyColor:'#94a3b8',
          callbacks: { label: ctx => `  ${fmtMoney(ctx.raw)}  (${total?(ctx.raw/total*100).toFixed(1):0}%)` },
        },
      },
    },
  });
};

const renderCharts = () => {
  if (chartTipo) { chartTipo.destroy(); chartTipo = null; }
  if (chartLoc)  { chartLoc.destroy();  chartLoc  = null; }
  if (!assets.length) return;

  const groupBy = key => assets.reduce((acc, a) => {
    acc[a[key]] = (acc[a[key]] || 0) + calcValueDisp(a); return acc;
  }, {});

  const byType = groupBy('type'); const typeKeys = Object.keys(byType);
  chartTipo = makeDonut('chart-tipo', typeKeys, typeKeys.map(k=>byType[k]), typeKeys.map(k=>TYPE_COLORS[k]||'#6b7280'));

  const byLoc = groupBy('location'); const locKeys = Object.keys(byLoc);
  chartLoc = makeDonut('chart-loc', locKeys, locKeys.map(k=>byLoc[k]), locKeys.map(k=>LOC_COLORS[k]||'#6b7280'));
};

// ── Main Table ─────────────────────────────────────────────────────────────
const renderTable = () => {
  const fType = document.getElementById('filter-type').value;
  const fLoc  = document.getElementById('filter-loc').value;

  const data = assets
    .filter(a => (!fType || a.type===fType) && (!fLoc || a.location===fLoc))
    .map(enrich)
    .sort((a, b) => {
      const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
      return (typeof av==='string' ? av.localeCompare(bv) : av-bv) * sortDir;
    });

  const tbody = document.getElementById('table-body');
  const empty = document.getElementById('empty-state');
  if (!data.length) { tbody.innerHTML=''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = data.map(a => {
    const cur = assetCur(a);
    return `<tr class="tr-row">
      <td class="font-mono font-bold text-white" style="font-size:13px">${a.ticker} ${curBadge(cur)}</td>
      <td class="col-hide"><span class="badge ${TYPE_BADGE[a.type]||'bg-gray-700/50 text-gray-400'}">${a.type}</span></td>
      <td class="col-hide text-right text-gray-400 font-mono">${fmtNum(a.nominals)}</td>
      <td class="col-hide text-right text-gray-500 font-mono">${fmtMoney(toDisplay(a.purchasePrice, cur))}</td>
      <td class="text-right font-semibold font-mono">${priceDot(a.id)}${fmtMoney(a.value)}</td>
      <td class="text-right font-mono font-semibold ${a.pnl>=0?'pos':'neg'}">${fmtMoney(a.pnl)}</td>
      <td class="text-right font-mono ${a.pct>=0?'pos':'neg'}">${fmtPct(a.pct)}</td>
      <td class="col-hide"><span class="badge" style="background:#1e293b;color:#64748b">${a.location}</span></td>
      <td><div class="flex gap-1">
        <button class="btn-icon-edit" onclick="openModal('${a.id}')"><i data-lucide="pencil" style="width:11px;height:11px"></i></button>
        <button class="btn-icon-del"  onclick="deleteAsset('${a.id}')"><i data-lucide="trash-2" style="width:11px;height:11px"></i></button>
      </div></td>
    </tr>`;
  }).join('');
  lucide.createIcons();
};

const sortBy = key => {
  sortDir = sortKey===key ? -sortDir : -1;
  sortKey = key; renderTable();
};

// ── Portfolio Table ────────────────────────────────────────────────────────
const renderPortfolio = () => {
  const tbody = document.getElementById('portfolio-body');
  const empty = document.getElementById('portfolio-empty');
  if (!assets.length) { tbody.innerHTML=''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = assets.map(a => {
    const cur = assetCur(a);
    return `<tr class="tr-row">
      <td class="font-mono font-bold text-white" style="font-size:13px">${a.ticker}</td>
      <td class="col-hide"><span class="badge ${TYPE_BADGE[a.type]||'bg-gray-700/50 text-gray-400'}">${a.type}</span></td>
      <td class="text-right font-mono text-gray-300">${fmtNum(a.nominals)}</td>
      <td class="col-hide text-right font-mono text-gray-500">${fmtNative(a.purchasePrice, cur)}</td>
      <td class="text-right font-mono">${priceDot(a.id)}${fmtNative(a.currentPrice, cur)}</td>
      <td class="text-right font-mono font-semibold">${fmtNative(a.currentPrice*a.nominals, cur)}</td>
      <td class="col-hide text-gray-500" style="font-size:11px">${a.date||''}</td>
      <td class="col-hide"><span class="badge" style="background:#1e293b;color:#64748b">${a.location}</span></td>
      <td class="col-hide">${curBadge(cur)}</td>
      <td><div class="flex gap-1">
        <button class="btn-icon-edit" onclick="openModal('${a.id}')"><i data-lucide="pencil" style="width:11px;height:11px"></i></button>
        <button class="btn-icon-del"  onclick="deleteAsset('${a.id}')"><i data-lucide="trash-2" style="width:11px;height:11px"></i></button>
      </div></td>
    </tr>`;
  }).join('');
  lucide.createIcons();
};

// ── Modal / Form ───────────────────────────────────────────────────────────
const openModal = (id = null) => {
  editId = id;
  document.getElementById('asset-form').reset();
  document.getElementById('form-preview').classList.add('hidden');
  document.getElementById('modal-title').textContent = id ? 'Editar Activo' : 'Agregar Activo';
  // Default date = today
  if (!id) document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);

  if (id) {
    const a = assets.find(x => x.id === id);
    if (a) {
      document.getElementById('f-type').value     = a.type;
      document.getElementById('f-ticker').value   = a.ticker;
      document.getElementById('f-nominals').value = a.nominals;
      document.getElementById('f-currency').value = assetCur(a);
      document.getElementById('f-purchase').value = a.purchasePrice;
      document.getElementById('f-amount').value   = a.currentPrice;
      document.getElementById('f-date').value     = a.date;
      document.getElementById('f-loc').value      = a.location;
      document.getElementById('f-notes').value    = a.notes || '';
      updatePreview();
    }
  }
  document.getElementById('modal').classList.remove('hidden');
};

const closeModal = () => { document.getElementById('modal').classList.add('hidden'); editId = null; };
const closeModalOutside = e => { if (e.target.id==='modal') closeModal(); };

const updatePreview = () => {
  const nominals = parseFloat(document.getElementById('f-nominals').value) || 0;
  const purchase = parseFloat(document.getElementById('f-purchase').value) || 0;
  const current  = parseFloat(document.getElementById('f-amount').value)   || 0;
  const cur      = document.getElementById('f-currency').value             || 'USD';

  if (!nominals || !purchase || !current) { document.getElementById('form-preview').classList.add('hidden'); return; }

  const cost = purchase * nominals, value = current * nominals, pnl = value - cost;
  document.getElementById('form-preview').classList.remove('hidden');
  document.getElementById('prev-cost').textContent  = fmtNative(cost, cur);

  let valText = fmtNative(value, cur);
  if (cur !== displayCurrency && dolarBlue) valText += ` ≈ ${fmtMoney(toDisplay(value, cur))}`;
  document.getElementById('prev-value').textContent = valText;

  const pnlEl = document.getElementById('prev-pnl');
  pnlEl.textContent = fmtNative(pnl, cur) + ' (' + fmtPct((current-purchase)/purchase*100) + ')';
  pnlEl.className   = `form-preview-value ${pnl>=0?'pos':'neg'}`;
};

const saveAsset = e => {
  e.preventDefault();
  const ticker  = document.getElementById('f-ticker').value.trim().toUpperCase();
  const loc     = document.getElementById('f-loc').value;
  const cur     = document.getElementById('f-currency').value;
  const nominals     = parseFloat(document.getElementById('f-nominals').value);
  const purchasePrice= parseFloat(document.getElementById('f-purchase').value);
  const currentPrice = parseFloat(document.getElementById('f-amount').value);

  // ── Duplicate detection (new assets only) ──
  if (!editId) {
    const dup = assets.find(a => a.ticker===ticker && a.location===loc && assetCur(a)===cur);
    if (dup) {
      const totalNominals = dup.nominals + nominals;
      const wAvgPrice     = (dup.purchasePrice * dup.nominals + purchasePrice * nominals) / totalNominals;
      assets = assets.map(a => a.id===dup.id
        ? { ...a, nominals:totalNominals, purchasePrice:wAvgPrice, currentPrice, notes:document.getElementById('f-notes').value.trim()||a.notes }
        : a);
      save(); closeModal(); renderAll();
      if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
      showToast(`${ticker} sumado · ${fmtNum(totalNominals)} nominales · PPP ${fmtNative(wAvgPrice, cur)}`, 'ok');
      return;
    }
  }

  const asset = {
    id: editId || uid(),
    type:          document.getElementById('f-type').value,
    ticker, nominals, currency: cur, purchasePrice, currentPrice,
    date:          document.getElementById('f-date').value,
    location:      loc,
    notes:         document.getElementById('f-notes').value.trim(),
  };

  assets = editId ? assets.map(a => a.id===editId ? asset : a) : [...assets, asset];
  save(); closeModal(); renderAll();
  if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
};

const deleteAsset = id => {
  if (!confirm('¿Eliminar este activo permanentemente?')) return;
  assets = assets.filter(a => a.id!==id);
  delete priceStatus[id];
  save(); renderAll(); renderPortfolio();
};

// ── Master render ──────────────────────────────────────────────────────────
const renderAll = () => {
  renderKPIs();
  renderCharts();
  renderTable();
  renderTopMovers();
  renderAllocationBar();
  renderHistoryChart();
  saveSnapshot();
};

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  document.getElementById('toggle-usd').classList.toggle('active', displayCurrency==='USD');
  document.getElementById('toggle-ars').classList.toggle('active', displayCurrency==='ARS');
  window.addEventListener('resize', updateBlueUI);

  await fetchDolarBlue();
  await initSync();
  renderAll();
  fetchAllPrices();
  startAutoRefresh();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else { startAutoRefresh(); if (assets.length) fetchAllPrices(); }
  });
});
