// ===== WealthTracker Pro — app.js =====

// ── State ──────────────────────────────────────────────────────────────────
let assets          = JSON.parse(localStorage.getItem('wm_assets')    || '[]');
let displayCurrency = localStorage.getItem('wm_display_cur')          || 'USD';
let dolarBlue       = 0;
let sortKey         = 'value';
let sortDir         = -1;
let editId          = null;
let chartTipo       = null;
let chartLoc        = null;

// ── Live prices state ──────────────────────────────────────────────────────
let priceStatus      = {};   // { [id]: 'live'|'error'|'manual'|'unavailable'|'loading' }
let lastPriceUpdate  = null;
let isFetching       = false;
let autoRefreshTimer = null;
const REFRESH_MS     = 60_000; // auto-refresh every 60 s

// ── Persistence ────────────────────────────────────────────────────────────
const save = () => { localStorage.setItem('wm_assets', JSON.stringify(assets)); schedulePush(); };
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Dolar Blue ─────────────────────────────────────────────────────────────
const BLUE_KEY = 'wm_blue_cache';
const BLUE_TTL = 5 * 60 * 1000;

const fetchDolarBlue = async (force = false) => {
  const cached = JSON.parse(localStorage.getItem(BLUE_KEY) || 'null');
  if (!force && cached && Date.now() - cached.ts < BLUE_TTL) {
    dolarBlue = cached.rate;
    updateBlueUI();
    return;
  }
  const btn = document.getElementById('blue-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const res  = await fetch('https://api.bluelytics.com.ar/v2/latest');
    const data = await res.json();
    dolarBlue  = data.blue.value_sell;
    localStorage.setItem(BLUE_KEY, JSON.stringify({ rate: dolarBlue, ts: Date.now() }));
  } catch {
    dolarBlue = cached?.rate || 0;
  }
  if (btn) btn.classList.remove('spinning');
  updateBlueUI();
};

const refreshBlue = () => fetchDolarBlue(true);

const updateBlueUI = () => {
  const el = document.getElementById('blue-rate');
  if (el) el.textContent = dolarBlue
    ? '$ ' + Number(dolarBlue).toLocaleString('es-AR', { maximumFractionDigits: 0 })
    : '—';
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
  BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', BNB: 'binancecoin',
  SOL: 'solana', XRP: 'ripple', USDC: 'usd-coin', ADA: 'cardano',
  AVAX: 'avalanche-2', DOGE: 'dogecoin', TRX: 'tron', DOT: 'polkadot',
  LINK: 'chainlink', MATIC: 'matic-network', POL: 'matic-network',
  SHIB: 'shiba-inu', DAI: 'dai', LTC: 'litecoin', UNI: 'uniswap',
  ATOM: 'cosmos', XLM: 'stellar', ETC: 'ethereum-classic', NEAR: 'near',
  BCH: 'bitcoin-cash', APT: 'aptos', OP: 'optimism', ARB: 'arbitrum',
  AAVE: 'aave', FTM: 'fantom', ALGO: 'algorand', VET: 'vechain',
  FIL: 'filecoin', HBAR: 'hedera-hashgraph', SAND: 'the-sandbox',
  MANA: 'decentraland', CRV: 'curve-dao-token', MKR: 'maker',
  GRT: 'the-graph', SUSHI: 'sushi', YFI: 'yearn-finance',
  WLD: 'worldcoin-wld', PEPE: 'pepe', RENDER: 'render-token',
  IMX: 'immutable-x', INJ: 'injective-protocol', SUI: 'sui',
  SEI: 'sei-network', TAO: 'bittensor',
};

// ── Yahoo Finance fetch (v8 chart endpoint — CORS-enabled) ─────────────────
const fetchYahooQuote = async ticker => {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`
  );
  if (!res.ok) throw new Error(`YF HTTP ${res.status}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('sin precio');
  return { price: meta.regularMarketPrice, currency: (meta.currency || 'USD').toUpperCase() };
};

// ── CoinGecko batch fetch ──────────────────────────────────────────────────
const fetchCoinGeckoBatch = async cryptoAssets => {
  const ids = [...new Set(
    cryptoAssets.map(a => CRYPTO_IDS[a.ticker.toUpperCase()]).filter(Boolean)
  )];
  if (!ids.length) return {};
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error(`CG HTTP ${res.status}`);
  return res.json();
};

// ── Apply Yahoo price accounting for currency mismatch ─────────────────────
const applyYahooPrice = (a, yahooPrice, yahooCurrency) => {
  const aCur = assetCur(a);
  if (yahooCurrency === aCur || !dolarBlue) {
    a.currentPrice = yahooPrice;
  } else if (yahooCurrency === 'USD' && aCur === 'ARS') {
    a.currentPrice = yahooPrice * dolarBlue;
  } else if (yahooCurrency === 'ARS' && aCur === 'USD') {
    a.currentPrice = yahooPrice / dolarBlue;
  } else {
    a.currentPrice = yahooPrice;
  }
};

// ── Main price fetch orchestrator ──────────────────────────────────────────
const fetchAllPrices = async () => {
  if (isFetching) return;
  isFetching = true;
  setPriceUIState('loading');

  // Mark non-priceable assets immediately
  assets
    .filter(a => ['Propiedades', 'Money Market', 'Mercaderia', 'Vehiculos'].includes(a.type))
    .forEach(a => { priceStatus[a.id] = 'unavailable'; });

  // Set loading state for priceable assets
  assets
    .filter(a => ['Acciones', 'CEDEARs', 'Bonos', 'Cripto'].includes(a.type))
    .forEach(a => { priceStatus[a.id] = 'loading'; });

  // ── Yahoo Finance: stocks, CEDEARs, bonos ──
  const yahooAssets = assets.filter(a => ['Acciones', 'CEDEARs', 'Bonos'].includes(a.type));

  const yahooResults = await Promise.allSettled(
    yahooAssets.map(async a => {
      // CEDEARs and Bonos on BYMA use .BA suffix
      let ticker = a.ticker.toUpperCase();
      if ((a.type === 'CEDEARs' || a.type === 'Bonos') && !ticker.includes('.')) {
        ticker += '.BA';
      }
      const { price, currency } = await fetchYahooQuote(ticker);
      applyYahooPrice(a, price, currency);
      priceStatus[a.id] = 'live';
    })
  );

  // Mark failed Yahoo fetches
  yahooAssets.forEach((a, i) => {
    if (yahooResults[i].status === 'rejected') priceStatus[a.id] = 'error';
  });

  // ── CoinGecko: crypto ──
  const cryptoAssets = assets.filter(a => a.type === 'Cripto');
  if (cryptoAssets.length) {
    try {
      const cgData = await fetchCoinGeckoBatch(cryptoAssets);
      cryptoAssets.forEach(a => {
        const cgId    = CRYPTO_IDS[a.ticker.toUpperCase()];
        const usdPrice = cgData[cgId]?.usd;
        if (usdPrice != null) {
          // CoinGecko always returns USD; convert if asset is stored in ARS
          a.currentPrice = assetCur(a) === 'ARS' ? usdPrice * dolarBlue : usdPrice;
          priceStatus[a.id] = 'live';
        } else {
          // Ticker not in our map or not found
          priceStatus[a.id] = 'error';
        }
      });
    } catch {
      cryptoAssets.forEach(a => { priceStatus[a.id] = 'error'; });
    }
  }

  save();
  lastPriceUpdate = Date.now();
  isFetching = false;
  setPriceUIState('done');
  renderAll();
  if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
};

// ── Price UI state ─────────────────────────────────────────────────────────
const setPriceUIState = state => {
  ['btn-refresh-prices', 'btn-refresh-prices-portfolio'].forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = state === 'loading';
    btn.classList.toggle('spinning', state === 'loading');
  });

  if (state === 'done' && lastPriceUpdate) {
    const live = Object.values(priceStatus).filter(s => s === 'live').length;
    const err  = Object.values(priceStatus).filter(s => s === 'error').length;
    const time = new Date(lastPriceUpdate).toLocaleTimeString('es-AR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const summary = `${live} live${err ? ` · ${err} sin datos` : ''} · ${time}`;
    ['price-update-time', 'price-update-time-portfolio'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = summary;
    });
  }
};

// Price status dot HTML
const priceDot = id => {
  const s = priceStatus[id];
  const map = {
    live:        ['live',    'Precio en tiempo real'],
    error:       ['error',   'No se pudo obtener precio'],
    unavailable: ['manual',  'Precio manual'],
    loading:     ['loading', 'Actualizando...'],
  };
  const [cls, title] = map[s] || ['manual', 'Precio manual'];
  return `<span class="price-dot ${cls}" title="${title}"></span>`;
};

// Auto-refresh management
const startAutoRefresh = () => {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => {
    if (!document.hidden && assets.length) fetchAllPrices();
  }, REFRESH_MS);
};
const stopAutoRefresh = () => {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
};

// ── Theme maps ─────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  'Acciones':     '#3b82f6',
  'CEDEARs':      '#8b5cf6',
  'Bonos':        '#f59e0b',
  'Cripto':       '#10b981',
  'Propiedades':  '#f97316',
  'Money Market': '#06b6d4',
  'Mercaderia':   '#e879f9',
  'Vehiculos':    '#fb7185',
};

const LOC_COLORS = {
  'Exchange': '#6366f1',
  'Banco':    '#0ea5e9',
  'Fisico':   '#84cc16',
};

const TYPE_BADGE = {
  'Acciones':     'bg-blue-500/20 text-blue-400',
  'CEDEARs':      'bg-violet-500/20 text-violet-400',
  'Bonos':        'bg-amber-500/20 text-amber-400',
  'Cripto':       'bg-emerald-500/20 text-emerald-400',
  'Propiedades':  'bg-orange-500/20 text-orange-400',
  'Money Market': 'bg-cyan-500/20 text-cyan-400',
  'Mercaderia':   'bg-fuchsia-500/20 text-fuchsia-400',
  'Vehiculos':    'bg-rose-500/20 text-rose-400',
};

// ── Formatters ─────────────────────────────────────────────────────────────
const fmtMoney = v => {
  if (displayCurrency === 'ARS')
    return 'ARS ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return 'USD ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtNative = (v, cur) => {
  if (cur === 'ARS')
    return 'ARS ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return 'USD ' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtNum = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: 6 });
const fmtPct = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';

// ── Calculations ───────────────────────────────────────────────────────────
const assetCur      = a => a.currency || 'USD';
const calcCostDisp  = a => toDisplay(a.purchasePrice * a.nominals, assetCur(a));
const calcValueDisp = a => toDisplay(a.currentPrice  * a.nominals, assetCur(a));
const calcPnlDisp   = a => calcValueDisp(a) - calcCostDisp(a);
const calcPct       = a => a.purchasePrice
  ? (a.currentPrice - a.purchasePrice) / a.purchasePrice * 100 : 0;

const enrich = a => ({
  ...a,
  cost:  calcCostDisp(a),
  value: calcValueDisp(a),
  pnl:   calcPnlDisp(a),
  pct:   calcPct(a),
});

// ── Helpers ────────────────────────────────────────────────────────────────
const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

const curBadge = cur =>
  `<span class="cur-badge ${cur === 'USD' ? 'cur-usd' : 'cur-ars'}">${cur}</span>`;

// ── View switching ─────────────────────────────────────────────────────────
const showView = id => {
  ['dashboard', 'portfolio'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== id);
    document.getElementById(`tab-${v}`)?.classList.toggle('active', v === id);
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

  setText('kpi-patrimonio', fmtMoney(totalValue));
  setText('kpi-assets-count',
    `${assets.length} activo${assets.length !== 1 ? 's' : ''} · en ${displayCurrency}`);

  const pnlEl = document.getElementById('kpi-pnl');
  if (pnlEl) { pnlEl.textContent = fmtMoney(pnl); pnlEl.className = `kpi-value ${pnl >= 0 ? 'pos' : 'neg'}`; }

  const pnlPctEl = document.getElementById('kpi-pnl-pct');
  if (pnlPctEl) { pnlPctEl.textContent = fmtPct(pct) + ' vs costo'; pnlPctEl.className = `kpi-sub ${pnl >= 0 ? 'pos' : 'neg'}`; }

  const rendEl = document.getElementById('kpi-rendimiento');
  if (rendEl) { rendEl.textContent = fmtPct(pct); rendEl.className = `kpi-value ${pct >= 0 ? 'pos' : 'neg'}`; }

  setText('kpi-mejor', best ? `Mejor: ${best.ticker} (${fmtPct(calcPct(best))})` : '— sin activos');
};

// ── Charts ─────────────────────────────────────────────────────────────────
const makeDonut = (canvasId, labels, data, colors) => {
  const ctx   = document.getElementById(canvasId).getContext('2d');
  const total = data.reduce((s, v) => s + v, 0);
  return new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#0f172a', hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#94a3b8', font: { size: 11 }, padding: 14, boxWidth: 11, boxHeight: 11, borderRadius: 3 },
        },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          titleColor: '#f1f5f9', bodyColor: '#94a3b8',
          callbacks: {
            label: ctx => {
              const pct = total ? (ctx.raw / total * 100).toFixed(1) : 0;
              return `  ${fmtMoney(ctx.raw)}  (${pct}%)`;
            },
          },
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
    acc[a[key]] = (acc[a[key]] || 0) + calcValueDisp(a);
    return acc;
  }, {});

  const byType = groupBy('type');
  const typeKeys = Object.keys(byType);
  chartTipo = makeDonut('chart-tipo', typeKeys, typeKeys.map(k => byType[k]), typeKeys.map(k => TYPE_COLORS[k] || '#6b7280'));

  const byLoc = groupBy('location');
  const locKeys = Object.keys(byLoc);
  chartLoc = makeDonut('chart-loc', locKeys, locKeys.map(k => byLoc[k]), locKeys.map(k => LOC_COLORS[k] || '#6b7280'));
};

// ── Main Table ─────────────────────────────────────────────────────────────
const renderTable = () => {
  const fType = document.getElementById('filter-type').value;
  const fLoc  = document.getElementById('filter-loc').value;

  const data = assets
    .filter(a => (!fType || a.type === fType) && (!fLoc || a.location === fLoc))
    .map(enrich)
    .sort((a, b) => {
      const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDir;
    });

  const tbody = document.getElementById('table-body');
  const empty = document.getElementById('empty-state');

  if (!data.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = data.map(a => {
    const cur = assetCur(a);
    const purchaseDisp = toDisplay(a.purchasePrice, cur);
    return `
    <tr class="tr-row">
      <td class="font-mono font-bold text-white">${a.ticker} ${curBadge(cur)}</td>
      <td><span class="badge ${TYPE_BADGE[a.type] || 'bg-gray-700/50 text-gray-400'}">${a.type}</span></td>
      <td class="text-right text-gray-300 font-mono">${fmtNum(a.nominals)}</td>
      <td class="text-right text-gray-400 font-mono">${fmtMoney(purchaseDisp)}</td>
      <td class="text-right font-semibold font-mono">
        ${priceDot(a.id)}${fmtMoney(a.value)}
      </td>
      <td class="text-right font-mono font-semibold ${a.pnl >= 0 ? 'pos' : 'neg'}">${fmtMoney(a.pnl)}</td>
      <td class="text-right font-mono ${a.pct >= 0 ? 'pos' : 'neg'}">${fmtPct(a.pct)}</td>
      <td><span class="badge bg-gray-700/40 text-gray-400">${a.location}</span></td>
      <td>
        <div class="flex gap-1">
          <button class="btn-icon-edit" onclick="openModal('${a.id}')">
            <i data-lucide="pencil" style="width:12px;height:12px"></i>
          </button>
          <button class="btn-icon-del" onclick="deleteAsset('${a.id}')">
            <i data-lucide="trash-2" style="width:12px;height:12px"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  lucide.createIcons();
};

const sortBy = key => {
  sortDir = sortKey === key ? -sortDir : -1;
  sortKey = key;
  renderTable();
};

// ── Portfolio Table ────────────────────────────────────────────────────────
const renderPortfolio = () => {
  const tbody = document.getElementById('portfolio-body');
  const empty = document.getElementById('portfolio-empty');

  if (!assets.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  tbody.innerHTML = assets.map(a => {
    const cur = assetCur(a);
    return `
    <tr class="tr-row">
      <td class="font-mono font-bold text-white">${a.ticker}</td>
      <td><span class="badge ${TYPE_BADGE[a.type] || 'bg-gray-700/50 text-gray-400'}">${a.type}</span></td>
      <td class="text-right font-mono text-gray-300">${fmtNum(a.nominals)}</td>
      <td class="text-right font-mono text-gray-400">${fmtNative(a.purchasePrice, cur)}</td>
      <td class="text-right font-mono">
        ${priceDot(a.id)}${fmtNative(a.currentPrice, cur)}
      </td>
      <td class="text-right font-mono font-semibold">${fmtNative(a.currentPrice * a.nominals, cur)}</td>
      <td class="text-gray-400 text-xs">${a.date}</td>
      <td><span class="badge bg-gray-700/40 text-gray-400">${a.location}</span></td>
      <td>${curBadge(cur)}</td>
      <td>
        <div class="flex gap-1">
          <button class="btn-icon-edit" onclick="openModal('${a.id}')">
            <i data-lucide="pencil" style="width:12px;height:12px"></i>
          </button>
          <button class="btn-icon-del" onclick="deleteAsset('${a.id}')">
            <i data-lucide="trash-2" style="width:12px;height:12px"></i>
          </button>
        </div>
      </td>
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
      updatePreview();
    }
  }
  document.getElementById('modal').classList.remove('hidden');
};

const closeModal = () => {
  document.getElementById('modal').classList.add('hidden');
  editId = null;
};

const closeModalOutside = e => { if (e.target.id === 'modal') closeModal(); };

const updatePreview = () => {
  const nominals = parseFloat(document.getElementById('f-nominals').value) || 0;
  const purchase = parseFloat(document.getElementById('f-purchase').value) || 0;
  const current  = parseFloat(document.getElementById('f-amount').value)   || 0;
  const cur      = document.getElementById('f-currency').value             || 'USD';

  if (!nominals || !purchase || !current) {
    document.getElementById('form-preview').classList.add('hidden');
    return;
  }

  const cost = purchase * nominals;
  const value = current * nominals;
  const pnl   = value - cost;
  const pct   = (current - purchase) / purchase * 100;

  document.getElementById('form-preview').classList.remove('hidden');
  document.getElementById('prev-cost').textContent  = fmtNative(cost, cur);

  let valueText = fmtNative(value, cur);
  if (cur !== displayCurrency && dolarBlue) {
    valueText += ` ≈ ${fmtMoney(toDisplay(value, cur))}`;
  }
  document.getElementById('prev-value').textContent = valueText;

  const pnlEl = document.getElementById('prev-pnl');
  pnlEl.textContent = fmtNative(pnl, cur) + ' (' + fmtPct(pct) + ')';
  pnlEl.className   = `font-semibold ${pnl >= 0 ? 'pos' : 'neg'}`;
};

const saveAsset = e => {
  e.preventDefault();
  const asset = {
    id:            editId || uid(),
    type:          document.getElementById('f-type').value,
    ticker:        document.getElementById('f-ticker').value.trim().toUpperCase(),
    nominals:      parseFloat(document.getElementById('f-nominals').value),
    currency:      document.getElementById('f-currency').value,
    purchasePrice: parseFloat(document.getElementById('f-purchase').value),
    currentPrice:  parseFloat(document.getElementById('f-amount').value),
    date:          document.getElementById('f-date').value,
    location:      document.getElementById('f-loc').value,
  };

  assets = editId
    ? assets.map(a => a.id === editId ? asset : a)
    : [...assets, asset];

  save();
  closeModal();
  renderAll();
  if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
};

const deleteAsset = id => {
  if (!confirm('¿Eliminar este activo permanentemente?')) return;
  assets = assets.filter(a => a.id !== id);
  delete priceStatus[id];
  save();
  renderAll();
  renderPortfolio();
};

// ── Export / Import ────────────────────────────────────────────────────────
const exportData = () => {
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), assets }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([payload], { type: 'application/json' })),
    download: `wealthtracker-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

const importData = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const raw      = JSON.parse(ev.target.result);
      const imported = Array.isArray(raw) ? raw : (raw.assets || []);
      if (!imported.length) throw new Error('El archivo no contiene activos.');
      const existingIds = new Set(assets.map(a => a.id));
      const added = imported.filter(a => !existingIds.has(a.id));
      assets = [...assets, ...added];
      save();
      renderAll();
      setSyncMsg(`✓ ${added.length} activos importados. ${imported.length - added.length} ya existían.`, 'ok');
    } catch (err) {
      setSyncMsg('Error al importar: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
};

// ── Cloud sync (JSONBin.io) ────────────────────────────────────────────────
const SYNC_KEY   = 'wm_sync_cfg';
const BIN_URL    = 'https://api.jsonbin.io/v3/b';
let syncCfg      = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
let syncPushTimer = null;

const saveSyncCfg = () => localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));

// Debounced auto-push: called by save() — fires 1.5 s after last change
const schedulePush = () => {
  if (!syncCfg?.binId) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => cloudPush().catch(() => setSyncDot('error')), 1500);
};

const binHeaders = (extra = {}) => ({
  'Content-Type': 'application/json',
  'X-Master-Key': syncCfg.apiKey,
  ...extra,
});

// Push local data → cloud
const cloudPush = async () => {
  const body = JSON.stringify({ assets, syncedAt: Date.now() });
  if (syncCfg.binId) {
    const r = await fetch(`${BIN_URL}/${syncCfg.binId}`, { method: 'PUT', headers: binHeaders(), body });
    if (!r.ok) throw new Error(`PUT ${r.status}`);
  } else {
    const r = await fetch(BIN_URL, {
      method: 'POST',
      headers: binHeaders({ 'X-Bin-Name': 'WealthTracker', 'X-Bin-Private': 'true' }),
      body,
    });
    if (!r.ok) throw new Error(`POST ${r.status}`);
    const d = await r.json();
    syncCfg.binId = d.metadata.id;
    saveSyncCfg();
    refreshSyncUI();  // show the new bin ID
  }
  syncCfg.lastSync = Date.now();
  saveSyncCfg();
  setSyncDot('ok');
};

// Pull cloud → return { assets, syncedAt }
const cloudPull = async () => {
  const r = await fetch(`${BIN_URL}/${syncCfg.binId}/latest`, { headers: { 'X-Master-Key': syncCfg.apiKey } });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  return (await r.json()).record;
};

// Union merge: every unique ID survives
const mergeAssets = (local, cloud) => {
  const map = {};
  local.forEach(a => { map[a.id] = a; });
  cloud.forEach(a => { map[a.id] = a; }); // cloud wins on conflict (more recent push)
  return Object.values(map);
};

// ── Sync modal actions ─────────────────────────────────────────────────────
const openSyncModal  = () => { refreshSyncUI(); document.getElementById('sync-modal').classList.remove('hidden'); lucide.createIcons(); };
const closeSyncModal = () => document.getElementById('sync-modal').classList.add('hidden');
const closeSyncModalOutside = e => { if (e.target.id === 'sync-modal') closeSyncModal(); };

// First-time setup or re-connect
const setupSync = async () => {
  const apiKey = document.getElementById('sync-api-key').value.trim();
  const binId  = document.getElementById('sync-bin-id').value.trim();
  if (!apiKey) { setSyncMsg('Ingresá tu Master Key de JSONBin.io.', 'error'); return; }

  syncCfg = { apiKey, binId: binId || null, lastSync: null };
  setBtnLoading('btn-connect-sync', true);
  setSyncMsg('Conectando…', 'loading');

  try {
    if (syncCfg.binId) {
      // Existing bin: pull, merge, push
      setSyncMsg('Descargando datos de la nube…', 'loading');
      const cloudData  = await cloudPull();
      const cloudCount = (cloudData.assets || []).length;
      assets = mergeAssets(assets, cloudData.assets || []);
      localStorage.setItem('wm_assets', JSON.stringify(assets));
      setSyncMsg(`Combinando ${assets.length} activos (${cloudCount} en la nube)…`, 'loading');
    }
    // Push current (merged) state to cloud
    setSyncMsg('Subiendo datos…', 'loading');
    await cloudPush();
    renderAll();
    if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
    setSyncMsg(`✓ Sincronizado — ${assets.length} activos en la nube`, 'ok');
  } catch (err) {
    syncCfg = null;
    saveSyncCfg();
    setSyncMsg('Error: ' + err.message, 'error');
  }
  setBtnLoading('btn-connect-sync', false);
  refreshSyncUI();
};

// Manual full sync (pull + merge + push)
const syncNow = async () => {
  if (!syncCfg?.binId) return;
  setBtnLoading('btn-sync-now', true);
  setSyncMsg('Sincronizando…', 'loading');
  try {
    const cloudData = await cloudPull();
    assets = mergeAssets(assets, cloudData.assets || []);
    localStorage.setItem('wm_assets', JSON.stringify(assets));
    await cloudPush();
    renderAll();
    if (!document.getElementById('view-portfolio').classList.contains('hidden')) renderPortfolio();
    const t = new Date(syncCfg.lastSync).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    setSyncMsg(`✓ Sincronizado a las ${t} — ${assets.length} activos`, 'ok');
  } catch (err) {
    setSyncMsg('Error: ' + err.message, 'error');
  }
  setBtnLoading('btn-sync-now', false);
};

const disconnectSync = () => {
  if (!confirm('¿Desconectar la sincronización en la nube? Tus datos locales no se borran.')) return;
  syncCfg = null;
  localStorage.removeItem(SYNC_KEY);
  refreshSyncUI();
  setSyncMsg('Sincronización desconectada.', 'error');
};

const copyBinId = () => {
  navigator.clipboard?.writeText(syncCfg?.binId || '').then(() => setSyncMsg('Bin ID copiado al portapapeles.', 'ok'));
};

// Update modal UI to reflect current syncCfg state
const refreshSyncUI = () => {
  const connected = !!syncCfg?.binId;
  const apiKeyEl  = document.getElementById('sync-api-key');
  const binIdEl   = document.getElementById('sync-bin-id');
  if (apiKeyEl) apiKeyEl.value = syncCfg?.apiKey || '';
  if (binIdEl)  binIdEl.value  = syncCfg?.binId  || '';
  toggle('sync-copy-btn',   connected);
  toggle('btn-sync-now',    connected);
  toggle('btn-disconnect',  connected);
  toggle('btn-connect-sync', true);  // always visible (re-connect allowed)
  setSyncDot(connected ? 'ok' : null);
  // Header cloud badge
  const badge = document.getElementById('sync-badge');
  if (badge) badge.classList.toggle('hidden', !connected);
};

const setSyncMsg = (msg, state) => {
  const el = document.getElementById('sync-status-msg');
  if (!el) return;
  el.textContent = msg;
  el.className = `text-xs mt-3 ${state === 'ok' ? 'pos' : state === 'error' ? 'neg' : 'text-amber-400'}`;
};

const setSyncDot = state => {
  const el = document.getElementById('sync-status-badge');
  if (!el) return;
  if (!state) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.className = `sync-dot-badge ${state}`;
};

const toggle = (id, show) => document.getElementById(id)?.classList.toggle('hidden', !show);

const setBtnLoading = (id, loading) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('spinning', loading);
};

// On startup: if sync configured, pull and merge silently
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
    syncCfg.lastSync = Date.now();
    saveSyncCfg();
    setSyncDot('ok');
  } catch {
    setSyncDot('error');
  }
};

// ── Master render ──────────────────────────────────────────────────────────
const renderAll = () => { renderKPIs(); renderCharts(); renderTable(); };

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  document.getElementById('toggle-usd').classList.toggle('active', displayCurrency === 'USD');
  document.getElementById('toggle-ars').classList.toggle('active', displayCurrency === 'ARS');

  // First: fetch dolar blue, then render, then fetch live prices
  await fetchDolarBlue();
  await initSync();
  renderAll();
  fetchAllPrices();
  startAutoRefresh();

  // Pause auto-refresh when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefresh();
    else { startAutoRefresh(); if (assets.length) fetchAllPrices(); }
  });
});
