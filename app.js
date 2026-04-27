let dashboardData = null;
let activeSignalFilter = 'all';
let selectedSignalIndex = 0;
let activeLogFilter = 'all';
let activeTradeJournalFilter = 'all';
let eventsBound = false;
let previousMetricSnapshot = null;
let changedMetrics = new Set();
let liveStateTimer = null;
let refreshInFlight = false;

const DASHBOARD_API_URL = 'https://bingx-dashboard-api.nguyenvanvinh030625.workers.dev/dashboard';
const LOCAL_FALLBACK_URL = 'public_dashboard.json';
const DEMO_DASHBOARD_URL = 'public_dashboard.demo.json';
const DISPLAY_BRAND_NAME = '@damfuturenhucon';
const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);

const coinIconMap = {
  BTC: '₿', ETH: '◆', SOL: '≋', BNB: '◇', XRP: '✕', DOGE: 'Ð', ADA: '●', AVAX: '▲', MATIC: '⬡', LINK: '⬢'
};

const arr = (value) => Array.isArray(value) ? value : [];
const safe = (value, fallback = '--') => value === undefined || value === null || value === '' ? fallback : value;
const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const safeStatus = (value) => String(value || '');
const signalList = () => {
  const signals = arr(dashboardData?.signals);
  if (signals.length) return signals;
  return dashboardData?.latest_signal ? [dashboardData.latest_signal] : [];
};
const fmtR = (value) => {
  const number = safeNumber(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(Number.isInteger(number) ? 0 : 1)}R`;
};
const clsDir = (d) => safeStatus(d) === 'LONG' ? 'long' : 'short';
const iconFor = (symbol = '') => coinIconMap[safeStatus(symbol).replace('USDT', '')] || '◎';
const metricChanged = (...keys) => keys.some(key => changedMetrics.has(key));
const readTradeNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const internalPublicTextPattern = /\b(?:SWING_M15|SNIPER_M5|SCALP_M1|MANUAL_ENTRY|TREND|PUBLIC)\b|Hệ thống|Chiến lược|Nguồn/g;

function sanitizePublicText(value) {
  const text = safeStatus(value)
    .replace(internalPublicTextPattern, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  return text || '--';
}

function formatRiskReward(signal = {}) {
  const entry = readTradeNumber(signal.entry);
  const sl = readTradeNumber(signal.sl);
  const tp1 = readTradeNumber(signal.tp1);
  const tp2 = readTradeNumber(signal.tp2);
  const direction = safeStatus(signal.direction);

  if ([entry, sl, tp1, tp2].some(value => value === null) || !['LONG', 'SHORT'].includes(direction)) return '--';

  const risk = direction === 'LONG'
    ? Math.abs(entry - sl)
    : Math.abs(sl - entry);
  if (risk <= 0) return '--';

  const rr1 = direction === 'LONG'
    ? Math.abs(tp1 - entry) / risk
    : Math.abs(entry - tp1) / risk;
  const rr2 = direction === 'LONG'
    ? Math.abs(tp2 - entry) / risk
    : Math.abs(entry - tp2) / risk;
  if (![rr1, rr2].every(Number.isFinite)) return '--';

  return `TP1 ${rr1.toFixed(1)}R · TP2 ${rr2.toFixed(1)}R`;
}

function publicLogType(type) {
  return type === 'Hệ thống' ? 'Trạng thái' : safe(type);
}

function logFilterValue(value) {
  return value === 'status' ? 'Hệ thống' : value;
}

const trackedMetrics = {
  'summary.total_signals': data => safeNumber(data?.summary?.total_signals),
  'summary.win_rate': data => safeNumber(data?.summary?.win_rate),
  'summary.total_r': data => safeNumber(data?.summary?.total_r),
  'summary.active_trades': data => safeNumber(data?.summary?.active_trades),
  'latest_signal.symbol': data => safe(data?.latest_signal?.symbol, ''),
  'latest_signal.status': data => safe(data?.latest_signal?.status, ''),
  'active_trades.count': data => arr(data?.active_trades).length
};

function ensureFavicon() {
  if (document.querySelector('link[rel~="icon"]')) return;
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = 'data:,';
  document.head.appendChild(icon);
}

async function loadDashboardData() {
  if (isDemoMode) {
    console.info('[dashboard] Demo mode: using public_dashboard.demo.json');
    const demo = await fetch(DEMO_DASHBOARD_URL, { cache: 'no-store' });
    if (!demo.ok) throw new Error(`Demo dashboard fetch failed: ${demo.status}`);
    return await demo.json();
  }

  try {
    const res = await fetch(DASHBOARD_API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Worker fetch failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[dashboard] Worker fetch failed, using local fallback', err);
    const fallback = await fetch(LOCAL_FALLBACK_URL, { cache: 'no-store' });
    if (!fallback.ok) throw new Error(`Local fallback failed: ${fallback.status}`);
    return await fallback.json();
  }
}

function createMetricSnapshot(data) {
  return Object.fromEntries(Object.entries(trackedMetrics).map(([key, read]) => [key, read(data)]));
}

function setDashboardData(nextData) {
  const nextSnapshot = createMetricSnapshot(nextData);
  changedMetrics = previousMetricSnapshot
    ? new Set(Object.keys(nextSnapshot).filter(key => nextSnapshot[key] !== previousMetricSnapshot[key]))
    : new Set();
  previousMetricSnapshot = nextSnapshot;
  dashboardData = nextData;
}

function markRefreshStart() {
  document.body.classList.add('data-refreshing');
}

function markRefreshDone() {
  document.body.classList.remove('data-refreshing');
  document.body.classList.add('refreshed', 'live-updated');
  clearTimeout(liveStateTimer);
  liveStateTimer = setTimeout(() => {
    document.body.classList.remove('refreshed', 'live-updated');
  }, 1100);
}

async function refreshDashboard({ showError = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  markRefreshStart();
  try {
    setDashboardData(await loadDashboardData());
    renderAll();
    markRefreshDone();
  } catch (error) {
    document.body.classList.remove('data-refreshing');
    if (showError) {
      document.body.insertAdjacentHTML('afterbegin', '<div style="padding:12px;background:#341;color:#fff;text-align:center">Không đọc được public_dashboard.json. Hãy mở qua local server hoặc hosting tĩnh.</div>');
      throw error;
    }
    console.warn('[dashboard] Auto refresh failed', error);
  } finally {
    refreshInFlight = false;
  }
}

async function loadData() {
  return refreshDashboard({ showError: true });
}

function kpiCard(icon, label, value, sub, negative = false, metricKeys = []) {
  const keys = Array.isArray(metricKeys) ? metricKeys : metricKeys ? [metricKeys] : [];
  const changed = keys.some(key => changedMetrics.has(key));
  const metricAttr = keys.length ? ` data-metric="${keys[0]}"` : '';
  return `<article class="kpi-card ${changed ? 'value-updated' : ''}"${metricAttr}>
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-content"><div class="kpi-label">${label}</div><div class="kpi-value ${negative ? 'num-red' : ''} ${changed ? 'value-flash' : ''}">${value}</div><div class="kpi-sub">${sub}</div></div>
  </article>`;
}

function renderHeader() {
  const bot = dashboardData.bot || {};
  document.title = DISPLAY_BRAND_NAME;
  document.querySelector('h1').textContent = DISPLAY_BRAND_NAME;
  document.getElementById('botStatusText').textContent = 'Online';
  const updatedAt = dashboardData.cloudflare_published_at || bot.updated_at;
  document.getElementById('updatedAt').textContent = freshnessText(updatedAt);
}

function freshnessText(value) {
  const raw = safeStatus(value);
  const time = Date.parse(raw);
  if (!raw || Number.isNaN(time)) return safe(value);

  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `Cập nhật ${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Cập nhật ${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Cập nhật ${hours} giờ trước`;
  return safe(value);
}

function ensureSystemTab() {
  const tabs = document.querySelector('.tabs');
  if (tabs && !document.querySelector('.tab[data-tab="system"]')) {
    tabs.insertAdjacentHTML('beforeend', '<button class="tab" data-tab="system">Hệ thống</button>');
  }

  const app = document.querySelector('.app');
  if (app && !document.getElementById('tab-system')) {
    app.insertAdjacentHTML('beforeend', `
      <section id="tab-system" class="tab-panel system-tab">
        <div class="system-overview-grid" id="systemKpis"></div>

        <section class="panel system-scan-panel">
          <div class="panel-title">⟳ Nhịp quét tín hiệu</div>
          <div class="table-wrap">
            <table class="system-scan-table">
              <thead><tr><th>Khung</th><th>Vai trò</th><th>Lần quét cuối</th><th>Lần tới</th><th>Trạng thái</th></tr></thead>
              <tbody id="systemScanBody"></tbody>
            </table>
          </div>
        </section>

        <div class="system-two-col">
          <section class="panel">
            <div class="panel-title">▣ Dữ liệu thị trường</div>
            <div class="system-info-list" id="marketDataStatus"></div>
          </section>
          <section class="panel">
            <div class="panel-title">↔ Lệnh &amp; vị thế</div>
            <div class="system-list" id="positionsStatus"></div>
          </section>
        </div>

        <div class="system-two-col">
          <section class="panel">
            <div class="panel-title">⚙ Vận hành bot</div>
            <div class="system-list" id="botOpsStatus"></div>
          </section>
          <section class="panel">
            <div class="panel-title">⚠ Lỗi gần nhất</div>
            <div id="lastErrorStatus" class="system-error-box"></div>
          </section>
        </div>

        <section class="panel system-log-panel">
          <div class="panel-title">🧾 Nhật ký hệ thống gần đây</div>
          <div class="system-log-list" id="recentSystemLogs"></div>
        </section>
      </section>`);
  }
}

function ensureTradeJournalLayout() {
  const logs = document.getElementById('tab-logs');
  if (!logs) return;
  if (document.getElementById('tradeJournalBody') && document.getElementById('journalQuickStats')) return;

  logs.innerHTML = `
    <div class="journal-card-head">
      <div class="panel-title">Nhật ký giao dịch</div>
      <div class="journal-filter" aria-label="Lọc nhật ký giao dịch">
        ${[
          ['all', 'Tất cả'],
          ['running', 'Đang chạy'],
          ['closed', 'Đã đóng'],
          ['tp', 'TP'],
          ['sl', 'SL'],
          ['long', 'LONG'],
          ['short', 'SHORT']
        ].map(([value, label], index) => `<button class="log-pill journal-pill ${index === 0 ? 'active' : ''}" data-journal="${value}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="journal-stats-grid" id="journalQuickStats"></div>
    <section class="panel trade-journal-panel">
      <div class="table-wrap trade-journal-wrap">
        <table class="trade-journal-table">
          <thead><tr><th>Thời gian</th><th>Cặp</th><th>Hướng</th><th>Khung</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Giá trị lệnh</th><th>Trạng thái</th><th>Kết quả</th></tr></thead>
          <tbody id="tradeJournalBody"></tbody>
        </table>
      </div>
    </section>`;
}

function renderHome() {
  ensureHomeLayout();
  const s = dashboardData.summary || {};
  document.getElementById('homeKpis').innerHTML = [
    kpiCard('📡', 'Tổng tín hiệu', safeNumber(s.total_signals), '30 ngày gần nhất', false, 'summary.total_signals'),
    kpiCard('🏆', 'Win rate', `${safeNumber(s.win_rate)}%`, '30 ngày gần nhất', false, 'summary.win_rate'),
    kpiCard('$', 'Tổng lợi nhuận', fmtR(s.total_r), '30 ngày gần nhất', false, 'summary.total_r'),
    kpiCard('〽', 'Lệnh đang chạy', safeNumber(s.active_trades), 'cập nhật realtime', false, ['summary.active_trades', 'active_trades.count'])
  ].join('');

  const l = dashboardData.latest_signal || {};
  const latestSymbol = safe(l.symbol, 'ETHUSDT');
  const latestDirection = safe(l.direction, 'LONG');
  const latestStatus = safe(l.status, 'Chưa có tín hiệu');
  const latestChanged = metricChanged('latest_signal.symbol', 'latest_signal.status');
  const latestCard = document.getElementById('latestSignal');
  latestCard.classList.toggle('value-updated', latestChanged);
  document.getElementById('latestSignal').innerHTML = `<div class="latest-inner">
    <div class="panel-title">🔥 Tín hiệu mới nhất</div>
    <div class="latest-grid">
      <div class="signal-symbol"><span class="coin-icon ${metricChanged('latest_signal.symbol') ? 'soft-pulse' : ''}">${iconFor(latestSymbol)}</span><span class="big-symbol ${metricChanged('latest_signal.symbol') ? 'value-flash' : ''}">${latestSymbol}</span><span class="badge ${clsDir(latestDirection)}">${latestDirection}</span></div>
      ${field('Khung', l.timeframe)}${field('Entry', l.entry)}${field('SL', l.sl, 'num-red')}${field('TP1', l.tp1, 'num-green')}${field('TP2', l.tp2, 'num-green')}
      <div class="target-mark">◎</div>
    </div>
    <div class="latest-extra">
      ${field('Trạng thái', `<span class="badge info ${metricChanged('latest_signal.status') ? 'value-updated' : ''}">${latestStatus}</span>`)}
      ${field('R:R', formatRiskReward(l), 'num-cyan')}
      ${field('Độ tự tin', l.confidence, 'num-green')}
      ${field('Thời gian', l.created_at)}
    </div>
  </div>`;

  const activeTrades = arr(dashboardData.active_trades);
  renderActiveTrades(activeTrades);

  document.getElementById('livePanelList').innerHTML = arr(dashboardData.live_panel).map(item => {
    const status = sanitizePublicText(item.status);
    const note = sanitizePublicText(item.note);
    return `<div class="live-row"><strong>${safe(item.symbol)}</strong><span><i class="state-dot ${safeStatus(status).includes('lệnh') ? 'green' : ''}"></i>${status}</span><span class="${safeStatus(note).includes('Chờ') ? 'num-red' : safeStatus(note).includes('setup') ? 'num-green' : ''}">${note}</span></div>`;
  }).join('');
  renderSystemMini('systemMini');
  renderRecentResults();
  renderShortLogs();
}

function ensureHomeLayout() {
  const home = document.getElementById('tab-home');
  const activeTradesBody = document.getElementById('activeTradesBody');
  const activeGrid = activeTradesBody?.closest('.two-col');
  const activePanel = activeTradesBody?.closest('.panel');
  const livePanel = document.getElementById('livePanelList')?.closest('.panel');
  const bottomGrid = document.getElementById('recentResults')?.closest('.two-col');
  const riskBanner = home?.querySelector('.risk-banner');

  activeGrid?.classList.add('home-active-grid');
  activePanel?.classList.add('home-active-panel');
  livePanel?.classList.add('home-live-panel');
  bottomGrid?.classList.add('home-bottom-grid');
  riskBanner?.classList.add('home-risk-hidden');

  document.getElementById('homeAnalyticsGrid')?.remove();
}

function renderActiveTrades(activeTrades = []) {
  document.getElementById('activeTradesBody').innerHTML = activeTrades.length
    ? activeTrades.map(t => tradeRow(t, metricChanged('active_trades.count'))).join('')
    : '<tr><td colspan="7" class="empty-state">Hiện tại không có lệnh nào đang mở</td></tr>';
}

function homeMetric(label, value, cls = '') {
  return `<div class="home-mini-stat"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function formatPercent(value) {
  const number = safeNumber(value);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function percentOf(count, total) {
  const base = safeNumber(total);
  if (base <= 0) return 0;
  return (safeNumber(count) / base) * 100;
}

function readDirectionCount(direction) {
  const s = dashboardData.summary || {};
  const key = `${direction.toLowerCase()}_signals`;
  if (s[key] !== undefined) return safeNumber(s[key]);
  return arr(dashboardData.signals).filter(sig => sig.direction === direction).length;
}

function normalizeOutcomeLabel(value) {
  const text = safeStatus(value).toUpperCase();
  if (/\bTP1\b/.test(text)) return 'TP1';
  if (/\bTP2\b/.test(text)) return 'TP2';
  if (/\bSL\b/.test(text) || text.includes('STOP LOSS')) return 'SL';
  return '';
}

function readOutcomeCounts() {
  const counts = { SL: 0, TP1: 0, TP2: 0 };
  arr(dashboardData.result_distribution).forEach(item => {
    const outcome = normalizeOutcomeLabel(item.label || item.result || item.status);
    if (outcome) counts[outcome] += safeNumber(item.count);
  });

  if (Object.values(counts).some(Boolean)) return counts;

  arr(dashboardData.recent_results).forEach(item => {
    const outcome = normalizeOutcomeLabel(item.result || item.label || item.status);
    if (outcome) counts[outcome] += 1;
  });

  return counts;
}

function homeDonutBackground(items) {
  const total = items.reduce((sum, item) => sum + safeNumber(item.count), 0);
  if (total <= 0) return 'conic-gradient(rgba(255,255,255,.08) 0 100%)';

  let start = 0;
  const segments = items.map(item => {
    const end = start + (safeNumber(item.count) / total) * 100;
    const segment = `${item.color} ${start.toFixed(3)}% ${end.toFixed(3)}%`;
    start = end;
    return segment;
  });
  return `conic-gradient(${segments.join(', ')})`;
}

function readTotalSignals() {
  const summaryTotal = dashboardData.summary?.total_signals;
  if (summaryTotal !== undefined && summaryTotal !== null && summaryTotal !== '') return safeNumber(summaryTotal);
  const signalCount = arr(dashboardData.signals).length;
  if (signalCount) return signalCount;
  return Object.values(readOutcomeCounts()).reduce((sum, value) => sum + safeNumber(value), 0);
}

function signalDistributionItems() {
  const outcomes = readOutcomeCounts();
  return [
    { label: 'SL', count: outcomes.SL, color: 'var(--red)', cls: 'num-red' },
    { label: 'TP1', count: outcomes.TP1, color: 'var(--cyan)', cls: 'num-cyan' },
    { label: 'TP2', count: outcomes.TP2, color: 'var(--green)', cls: 'num-green' }
  ];
}

function renderSignalDistribution(targetId, { showTotalLine = false } = {}) {
  const items = signalDistributionItems();
  const distributionTotal = items.reduce((sum, item) => sum + safeNumber(item.count), 0);
  const totalSignals = readTotalSignals();

  const target = document.getElementById(targetId);
  if (!target) return;
  target.classList.add('home-distribution');
  target.innerHTML = `
    <div class="home-donut" style="background:${homeDonutBackground(items)}">
      <div class="home-donut-inner"><strong>${distributionTotal}</strong><span>Tổng</span></div>
    </div>
    <div class="home-distribution-legend">
      ${items.map(item => `<div class="home-legend-item"><span class="dot" style="background:${item.color}"></span><span>${item.label}</span><strong class="${item.cls}">${safeNumber(item.count)} (${formatPercent(percentOf(item.count, distributionTotal))})</strong></div>`).join('')}
    </div>
    ${showTotalLine ? `<div class="distribution-total-line">Tổng tín hiệu: <strong>${totalSignals}</strong></div>` : ''}`;
}

function renderPerformanceDistribution() {
  renderSignalDistribution('distribution', { showTotalLine: true });
}

function renderHomeSignalStats() {
  const s = dashboardData.summary || {};
  const total = safeNumber(s.total_signals);
  const longCount = readDirectionCount('LONG');
  const shortCount = readDirectionCount('SHORT');
  const pendingCount = safeNumber(s.pending_signals);
  const closedCount = safeNumber(s.closed_signals);
  const rows = [
    ['◎', 'Tổng tín hiệu', total, '', false],
    ['↗', 'LONG', longCount, 'num-green', true],
    ['↘', 'SHORT', shortCount, 'num-red', true],
    ['◌', 'Đang chờ', pendingCount, 'num-cyan', true],
    ['✓', 'Đã đóng', closedCount, 'num-green', true]
  ];

  document.getElementById('homeSignalStats').innerHTML = rows
    .map(([icon, label, value, cls, showPercent]) => `<div class="home-stat-row"><span class="home-stat-icon">${icon}</span><span class="home-stat-label">${label}</span><strong class="${cls}">${safeNumber(value)}${showPercent ? ` (${formatPercent(percentOf(value, total))})` : ''}</strong></div>`)
    .join('');
}

function renderRecentResults() {
  const recentResults = arr(dashboardData.recent_results);
  document.getElementById('recentResults').innerHTML = recentResults.length
    ? recentResults.map(r => {
      const result = safe(r.result);
      return `<div class="result-row"><strong><span class="coin-icon" style="width:28px;height:28px;font-size:14px;margin-right:8px">${iconFor(r.symbol)}</span>${safe(r.symbol)}</strong><span class="${clsDir(r.direction)}">${safe(r.direction)}</span><strong class="${safeStatus(result).includes('SL') ? 'num-red' : safeStatus(result).includes('Thoát') ? 'num-cyan' : 'num-green'}">${result}</strong><strong class="${safeNumber(r.r) < 0 ? 'num-red' : 'num-green'}">${fmtR(r.r)}</strong></div>`;
    }).join('')
    : '<div class="empty-state">Chưa có kết quả gần đây</div>';
}

function renderShortLogs() {
  document.getElementById('shortLogs').innerHTML = arr(dashboardData.activity_logs).slice(0, 5).map(logRow).join('');
}

function field(label, value, cls = '') {
  return `<div><div class="field-label">${label}</div><div class="field-value ${cls}">${safe(value)}</div></div>`;
}

function tradeRow(t, changed = false) {
  const status = safe(t.status);
  const statusClass = safeStatus(status).includes('Chờ') ? 'wait' : 'green';
  return `<tr class="${changed ? 'row-enter' : ''}"><td><strong><span class="coin-icon" style="width:30px;height:30px;font-size:14px;margin-right:8px">${iconFor(t.symbol)}</span>${safe(t.symbol)}</strong></td><td class="${clsDir(t.direction)}"><strong>${safe(t.direction)}</strong></td><td>${safe(t.entry)}</td><td>${safe(t.tp1)}</td><td>${safe(t.tp2)}</td><td class="num-red">${safe(t.sl)}</td><td><span class="badge ${statusClass}">${status}</span></td></tr>`;
}

function renderSystemMini(id) {
  const sys = dashboardData.system || {};
  document.getElementById(id).innerHTML = `
    <div>🛡 Risk lock hôm nay: <strong class="${sys.risk_lock ? 'num-red' : 'num-green'}">${sys.risk_lock ? 'Bật' : 'Tắt'}</strong></div>
    <div>▣ Dữ liệu: <strong class="num-green">${safe(sys.data_status)}</strong></div>
    <div>⚠ Lỗi gần nhất: <strong class="num-green">${safe(sys.last_error)}</strong></div>`;
}

function renderSignals() {
  const s = dashboardData.summary || {};
  const signalsDescription = document.querySelector('#tab-signals .page-head p');
  if (signalsDescription) signalsDescription.textContent = 'Theo dõi tín hiệu giao dịch theo thời gian thực.';
  document.getElementById('signalsKpis').innerHTML = [
    miniKpi('Tổng hôm nay', safeNumber(s.today_signals)), miniKpi('Đang active', safeNumber(s.active_signals)), miniKpi('Chờ xác nhận', safeNumber(s.pending_signals)), miniKpi('Đã đóng', safeNumber(s.closed_signals))
  ].join('');
  fillFilters();
  renderSignalTable();
}

function miniKpi(label, value) { return `<div class="mini-kpi"><span>${label}</span><strong>${value}</strong></div>`; }

function fillFilters() {
  const pair = document.getElementById('pairFilter');
  const tf = document.getElementById('tfFilter');
  const signals = signalList();
  const pairs = [...new Set(signals.map(x => safe(x.symbol, '')).filter(Boolean))];
  const tfs = [...new Set(signals.map(x => safe(x.timeframe, '')).filter(Boolean))];
  pair.innerHTML = '<option value="all">Tất cả</option>' + pairs.map(p => `<option>${p}</option>`).join('');
  tf.innerHTML = '<option value="all">Tất cả</option>' + tfs.map(t => `<option>${t}</option>`).join('');
}

function getFilteredSignals() {
  const pair = document.getElementById('pairFilter')?.value || 'all';
  const tf = document.getElementById('tfFilter')?.value || 'all';
  const dir = document.getElementById('dirFilter')?.value || 'all';
  return signalList().filter(sig => {
    const status = safeStatus(sig.status);
    const closed = ['TP1 HIT', 'TP2 HIT', 'SL', 'Thoát sớm'].some(x => status.includes(x));
    const statusOK = activeSignalFilter === 'all' || (activeSignalFilter === 'closed' ? closed : status === activeSignalFilter);
    return statusOK && (pair === 'all' || sig.symbol === pair) && (tf === 'all' || sig.timeframe === tf) && (dir === 'all' || sig.direction === dir);
  });
}

function renderSignalTable() {
  document.querySelector('.signal-table thead').innerHTML = '<tr><th>Cặp</th><th>Hướng</th><th>Khung</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Trạng thái</th></tr>';
  const hasPublicSignals = arr(dashboardData.signals).length > 0;
  const rows = hasPublicSignals ? getFilteredSignals() : [];
  if (selectedSignalIndex >= rows.length) selectedSignalIndex = 0;
  if (!rows.length) {
    document.getElementById('signalsBody').innerHTML = '<tr><td colspan="8" class="empty-state">Chưa có tín hiệu</td></tr>';
    document.getElementById('signalCountText').textContent = 'Hiển thị 0 tín hiệu';
    renderSignalDetail(signalList()[0] || {});
    return;
  }

  document.getElementById('signalsBody').innerHTML = rows.map((sig, idx) => {
    const status = safe(sig.status, 'Chưa có tín hiệu');
    return `<tr class="${idx === selectedSignalIndex ? 'selected' : ''}" data-signal-index="${idx}">
      <td><strong><span class="coin-icon" style="width:30px;height:30px;font-size:14px;margin-right:8px">${iconFor(sig.symbol)}</span>${safe(sig.symbol, 'ETHUSDT')}</strong></td>
      <td class="${clsDir(sig.direction)}"><strong>${safe(sig.direction, 'LONG')}</strong></td>
      <td>${safe(sig.timeframe)}</td><td>${safe(sig.entry)}</td><td class="num-red">${safe(sig.sl)}</td><td class="num-green">${safe(sig.tp1)}</td><td class="num-green">${safe(sig.tp2)}</td>
      <td><span class="badge ${statusClass(status)}">${status}</span></td>
    </tr>`;
  }).join('');
  document.getElementById('signalCountText').textContent = `Hiển thị 1 - ${rows.length} của ${signalList().length} tín hiệu`;
  renderSignalDetail(rows[selectedSignalIndex] || signalList()[0] || {});
  document.querySelectorAll('#signalsBody tr').forEach(tr => tr.addEventListener('click', () => { selectedSignalIndex = Number(tr.dataset.signalIndex); renderSignalTable(); }));
}

function statusClass(status) {
  const text = safeStatus(status);
  if (text.includes('SL')) return 'short';
  if (text.includes('Chờ') || text.includes('Thoát')) return 'wait';
  if (text.includes('TP') || text.includes('Đang')) return 'green';
  return 'info';
}

function renderSignalDetail(sig = {}) {
  const symbol = safe(sig.symbol, 'ETHUSDT');
  const direction = safe(sig.direction, 'LONG');
  const status = safe(sig.status, 'Chưa có tín hiệu');
  const date = safe(sig.date, '');
  const time = safe(sig.time, '');
  const timeText = safe([date, time].filter(Boolean).join(' '), safe(sig.created_at));

  document.getElementById('signalDetail').innerHTML = `<div class="panel-title">◎ Chi tiết tín hiệu</div>
    <div class="signal-symbol" style="margin-bottom:16px"><span class="coin-icon">${iconFor(symbol)}</span><span class="big-symbol">${symbol}</span><span class="badge ${clsDir(direction)}">${direction}</span></div>
    ${detailRow('R:R', formatRiskReward(sig), 'num-cyan')}${detailRow('Khung thời gian', safe(sig.timeframe))}${detailRow('Entry', safe(sig.entry))}${detailRow('Stop Loss (SL)', safe(sig.sl), 'num-red')}${detailRow('Take Profit 1 (TP1)', safe(sig.tp1), 'num-green')}${detailRow('Take Profit 2 (TP2)', safe(sig.tp2), 'num-green')}${detailRow('Độ tự tin', safe(sig.confidence), 'num-green')}${detailRow('Trạng thái', `<span class="badge ${statusClass(status)}">${status}</span>`)}${detailRow('Thời gian', timeText)}
    <div class="note-box"><strong class="num-green">ⓘ Ghi chú</strong><br>${sanitizePublicText(sig.note) === '--' ? 'Không có ghi chú' : sanitizePublicText(sig.note)}</div>`;
}

function detailRow(label, value, cls = '') { return `<div class="detail-row"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`; }

function renderPerformance() {
  ensurePerformanceLayout();
  const s = dashboardData.summary || {};
  document.getElementById('performanceKpis').innerHTML = [
    kpiCard('🏆', 'Win rate', `${safeNumber(s.win_rate)}%`, '30 ngày gần nhất', false, 'summary.win_rate'),
    kpiCard('$', 'Tổng lợi nhuận', fmtR(s.total_r), '30 ngày gần nhất', false, 'summary.total_r'),
    kpiCard('📡', 'Tổng tín hiệu', safeNumber(s.total_signals), '30 ngày gần nhất', false, 'summary.total_signals'),
    kpiCard('↘', 'Drawdown tối đa', fmtR(s.max_drawdown_r), '30 ngày gần nhất', true)
  ].join('');
  renderLineChart();
  renderPerformanceOverviewStats();
  renderWeeklyBars();
  renderPerformanceDistribution();
  const pairPerformance = arr(dashboardData.pair_performance);
  document.getElementById('pairPerfBody').innerHTML = pairPerformance.length
    ? pairPerformance.map(p => `<tr><td><strong><span class="coin-icon" style="width:28px;height:28px;font-size:14px;margin-right:8px">${iconFor(p.symbol)}</span>${safe(p.symbol)}</strong></td><td>${safeNumber(p.trades)}</td><td class="num-green">${safeNumber(p.win_rate)}%</td><td class="${safeNumber(p.r) < 0 ? 'num-red' : 'num-green'}">${fmtR(p.r)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">Chưa có hiệu suất theo cặp</td></tr>';
  const best = pairPerformance.slice().sort((a,b)=>safeNumber(b.r)-safeNumber(a.r))[0] || {};
  document.getElementById('insights').innerHTML = `<div class="panel-title">🎯 Insights nhanh</div>
    ${insight('🏆', 'Cặp tốt nhất', safe(best.symbol, 'ETHUSDT'), 'Tổng R', fmtR(best.r))}
    ${insight('🕘', 'Khung hiệu quả', 'M5', 'Win rate', '61.3%')}
    ${insight('↗', 'Chuỗi thắng dài nhất', '5', 'Tín hiệu', '(17/04 – 21/04)')}`;
}

function ensurePerformanceLayout() {
  const lineChart = document.getElementById('lineChart');
  lineChart?.classList.add('performance-overview-chart');
  lineChart?.closest('.panel')?.classList.add('performance-overview-panel');
  if (lineChart && !document.getElementById('performanceOverviewStats')) {
    const stats = document.createElement('div');
    stats.id = 'performanceOverviewStats';
    stats.className = 'home-metric-strip performance-overview-stats';
    lineChart.insertAdjacentElement('afterend', stats);
  }
}

function renderPerformanceOverviewStats() {
  const s = dashboardData.summary || {};
  const target = document.getElementById('performanceOverviewStats');
  if (!target) return;
  target.innerHTML = [
    homeMetric('Tổng PnL', fmtR(s.total_r), safeNumber(s.total_r) < 0 ? 'num-red' : 'num-green'),
    homeMetric('Win rate', `${safeNumber(s.win_rate)}%`, 'num-green'),
    homeMetric('Số lệnh', safeNumber(s.total_signals), 'num-cyan')
  ].join('');
}

function insight(icon, label, value, rightLabel, rightValue) {
  return `<div class="insight-row"><div class="kpi-icon" style="width:44px;height:44px;font-size:20px">${icon}</div><div><small>${label}</small><br><strong style="font-size:23px">${safe(value)}</strong></div><div style="text-align:right"><small>${rightLabel}</small><br><strong class="num-green" style="font-size:22px">${safe(rightValue)}</strong></div></div>`;
}

function renderLineChart(targetId = 'lineChart') {
  const target = document.getElementById(targetId);
  if (!target) return;
  const data = arr(dashboardData.performance_30d);
  if (!data.length) {
    target.innerHTML = '<div class="empty-state">Chưa có dữ liệu hiệu suất</div>';
    return;
  }

  // v3: keep every visual element inside the SVG viewBox so the chart
  // never escapes the card/div on real browser sizes.
  const w = 820, h = 320;
  const padL = 54, padR = 92, padT = 26, padB = 44;
  const ys = data.map(d => safeNumber(d.r));
  const min = Math.min(-4, ...ys);
  const max = Math.max(24, ...ys);
  const x = i => padL + (i / Math.max(1, data.length - 1)) * (w - padL - padR);
  const y = v => h - padB - ((v - min) / Math.max(1, max - min)) * (h - padT - padB);

  const pts = data.map((d,i)=>`${x(i)},${y(safeNumber(d.r))}`).join(' ');
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length-1)},${y(0)}`;
  const grid = [-4,0,4,8,12,16,20,24]
    .map(v => `<line class="chart-grid" x1="${padL}" x2="${w-padR+14}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="8" y="${y(v)+4}">${v}R</text>`)
    .join('');
  const labelIndexes = new Set([0, 3, 6, 9, 12, data.length - 1]);
  const labels = data
    .map((d, i) => labelIndexes.has(i) ? `<text class="axis-label" x="${Math.max(padL - 10, x(i)-18)}" y="${h-10}">${safe(d.date)}</text>` : '')
    .join('');

  const last = data[data.length - 1];
  const bx = Math.min(w - padR + 10, x(data.length - 1) - 6);
  const by = Math.max(8, y(safeNumber(last.r)) - 28);

  target.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${grid}<polygon class="performance-area" points="${area}"/><polyline class="performance-line" points="${pts}"/><line class="chart-grid" stroke-dasharray="5 5" x1="${padL}" x2="${w-padR+14}" y1="${y(0)}" y2="${y(0)}"/>${labels}<rect x="${bx}" y="${by}" width="70" height="26" rx="9" fill="rgba(103,240,92,.18)" stroke="rgba(103,240,92,.8)"/><text x="${bx+8}" y="${by+18}" fill="#67f05c" font-size="15" font-weight="800">${fmtR(last.r)}</text></svg>`;
}

function formatWeekDate(value) {
  const raw = safeStatus(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return safe(raw);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(time));
}

function weeklyLabelHtml(week = {}) {
  const [rangeStart = '--', rangeEnd = '--'] = safeStatus(week.range).split(/\s+-\s+/);
  const start = week.start_date || rangeStart;
  const end = week.end_date || rangeEnd;
  return `<div class="bar-label">
    <span>${safe(week.label)}</span>
    <span class="bar-separator">•</span>
    <span>${formatWeekDate(start)}</span>
    <span class="bar-separator">-</span>
    <span>${formatWeekDate(end)}</span>
  </div>`;
}

function renderWeeklyBars() {
  const weeklyResults = arr(dashboardData.weekly_results);
  const max = Math.max(1, ...weeklyResults.map(w => Math.abs(Number(w.r) || 0)));
  document.getElementById('weeklyBars').innerHTML = weeklyResults.length
    ? weeklyResults.map(w => {
      const value = safeNumber(w.r);
      return `<div class="bar-item"><div class="bar-value">${fmtR(value)}</div><div class="bar" style="height:${Math.max(35, (Math.abs(value)/max)*180)}px"></div>${weeklyLabelHtml(w)}</div>`;
    }).join('')
    : '<div class="empty-state">Chưa có kết quả theo tuần</div>';
}

function renderDistribution(targetId = 'distribution') {
  const target = document.getElementById(targetId);
  if (!target) return;
  const total = safeNumber(dashboardData.summary?.total_signals);
  target.innerHTML = `<div class="donut"><div class="donut-inner"><strong>${total}</strong><br><span>Tín hiệu</span></div></div><div class="legend-list">${arr(dashboardData.result_distribution).map((x,i)=>`<div><span class="dot" style="background:${['var(--green)','var(--cyan)','var(--red)','var(--yellow)'][i]}"></span> ${safe(x.label)} <strong style="float:right">${safeNumber(x.count)} (${safeNumber(x.percent)}%)</strong></div>`).join('')}<small>Tổng: ${total} tín hiệu</small></div>`;
}

function renderLogs() {
  ensureTradeJournalLayout();
  renderTradeJournal();
  hideLogSystemSummary();
}

function eventCard(icon, label, value, red=false) { return `<div class="event-card"><span class="kpi-icon" style="width:40px;height:40px;font-size:18px">${icon}</span><span>${label}</span><strong class="${red?'num-red':'num-green'}" style="font-size:24px">${safeNumber(value)}</strong></div>`; }

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function journalResultFromStatus(status) {
  const text = safeStatus(status);
  const outcome = normalizeOutcomeLabel(text);
  if (outcome) return outcome;
  return text.includes('Thoát') ? 'Thoát sớm' : '';
}

function normalizeJournalRow(row = {}, fallback = {}) {
  const status = firstValue(row.status, fallback.status, row.result ? 'Đã đóng' : '');
  return {
    time: firstValue(row.time, row.created_at, row.created_at_iso, row.opened_at, row.closed_at, row.updated_at, fallback.time),
    symbol: firstValue(row.symbol, fallback.symbol),
    direction: safeStatus(firstValue(row.direction, fallback.direction)).toUpperCase(),
    timeframe: firstValue(row.timeframe, row.tf, row.frame, fallback.timeframe),
    entry: firstValue(row.entry, fallback.entry),
    sl: firstValue(row.sl, row.stop_loss, fallback.sl),
    tp1: firstValue(row.tp1, fallback.tp1),
    tp2: firstValue(row.tp2, fallback.tp2),
    position_value: firstValue(row.position_value, row.positionValue, row.order_value, row.value, fallback.position_value),
    status,
    result: firstValue(row.result, row.outcome, row.pnl_result, journalResultFromStatus(status), fallback.result),
    r: firstValue(row.r, row.rr, row.r_multiple, row.result_r, row.pnl_r, fallback.r)
  };
}

function fallbackJournalRows() {
  const rows = [];
  const latest = dashboardData.latest_signal || {};

  arr(dashboardData.active_trades).forEach(trade => {
    rows.push(normalizeJournalRow(trade, {
      time: trade.time || trade.created_at || latest.created_at,
      timeframe: trade.timeframe || latest.timeframe,
      status: trade.status || 'Đang chạy'
    }));
  });

  arr(dashboardData.signals).forEach(signal => {
    rows.push(normalizeJournalRow(signal, {
      status: signal.status,
      result: journalResultFromStatus(signal.status)
    }));
  });

  arr(dashboardData.recent_results).forEach(result => {
    rows.push(normalizeJournalRow(result, {
      status: 'Đã đóng',
      result: result.result
    }));
  });

  if (!rows.length && latest.symbol && !safeStatus(latest.status).includes('Chưa có tín hiệu')) {
    rows.push(normalizeJournalRow(latest, {
      status: latest.status,
      result: journalResultFromStatus(latest.status)
    }));
  }

  return rows;
}

function tradeJournalRows() {
  const journal = arr(dashboardData.trade_journal);
  return (journal.length ? journal : fallbackJournalRows()).map(row => normalizeJournalRow(row));
}

function matchesTradeJournalFilter(row) {
  const status = safeStatus(row.status).toLowerCase();
  const result = safeStatus(row.result).toUpperCase();
  const direction = safeStatus(row.direction).toUpperCase();

  if (activeTradeJournalFilter === 'running') return status.includes('đang chạy') || status.includes('active') || status.includes('running');
  if (activeTradeJournalFilter === 'closed') return status.includes('đã đóng') || status.includes('closed');
  if (activeTradeJournalFilter === 'tp') return /\bTP(?:1|2)?\b/.test(result);
  if (activeTradeJournalFilter === 'sl') return /\bSL\b/.test(result) || result.includes('STOP LOSS');
  if (activeTradeJournalFilter === 'long') return direction === 'LONG';
  if (activeTradeJournalFilter === 'short') return direction === 'SHORT';
  return true;
}

function formatTradeNumber(value) {
  if (value === undefined || value === null || value === '') return '--';
  const number = Number(value);
  if (!Number.isFinite(number)) return safe(value);
  const decimals = Math.abs(number) >= 100 ? 2 : Math.abs(number) >= 1 ? 4 : 6;
  return number.toFixed(decimals).replace(/\.?0+$/, '');
}

function formatPositionValue(value) {
  if (value === undefined || value === null || value === '') return '--';
  const number = Number(value);
  return Number.isFinite(number) ? `${formatTradeNumber(number)} USDT` : safe(value);
}

function journalResultClass(result) {
  const text = safeStatus(result).toUpperCase();
  if (text.includes('SL')) return 'num-red';
  if (text.includes('TP2')) return 'num-green';
  if (text.includes('TP')) return 'num-cyan';
  return 'muted-text';
}

function compactResultLabel(result) {
  const text = safeStatus(result).trim();
  const upper = text.toUpperCase();
  if (!text || text === '--') return '--';
  if (upper.includes('TP1')) return 'TP1';
  if (upper.includes('TP2')) return 'TP2';
  if (/\bTP\b/.test(upper)) return 'TP';
  if (/\bSL\b/.test(upper) || upper.includes('STOP LOSS')) return 'SL';
  return text;
}

function formatJournalR(value) {
  if (value === undefined || value === null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number === 0) return '0R';
  return `${number > 0 ? '+' : ''}${number.toFixed(1)}R`;
}

function formatJournalResult(row = {}) {
  const status = safeStatus(row.status).toLowerCase();
  if (status.includes('đang chạy') || status.includes('running') || status.includes('active') || status.includes('chờ')) return '--';

  const label = compactResultLabel(row.result);
  if (label === '--') return '--';
  const rText = formatJournalR(row.r);
  return rText ? `${label} (${rText})` : label;
}

function isJournalRunning(row) {
  const status = safeStatus(row.status).toLowerCase();
  return status.includes('đang chạy') || status.includes('active') || status.includes('running');
}

function isJournalClosed(row) {
  const status = safeStatus(row.status).toLowerCase();
  return status.includes('đã đóng') || status.includes('closed');
}

function journalResultText(row) {
  return safeStatus(row.result).toUpperCase();
}

function statCard(label, value, cls = '') {
  return `<div class="journal-stat-card"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function renderJournalQuickStats(rows) {
  const target = document.getElementById('journalQuickStats');
  if (!target) return;
  const totalR = rows.reduce((sum, row) => sum + safeNumber(row.r), 0);
  target.innerHTML = [
    statCard('Tổng lệnh', rows.length),
    statCard('Đang chạy', rows.filter(isJournalRunning).length, 'num-cyan'),
    statCard('Đã đóng', rows.filter(isJournalClosed).length, 'num-green'),
    statCard('Thoát sớm', rows.filter(row => /THOÁT SỚM|EARLY/.test(journalResultText(row))).length, 'num-cyan'),
    statCard('SL', rows.filter(row => /\bSL\b|STOP LOSS/.test(journalResultText(row))).length, 'num-red'),
    statCard('TP1', rows.filter(row => /\bTP1\b/.test(journalResultText(row))).length, 'num-cyan'),
    statCard('TP2', rows.filter(row => /\bTP2\b/.test(journalResultText(row))).length, 'num-green'),
    statCard('R:R', formatJournalR(totalR) || '0R', totalR < 0 ? 'num-red' : totalR > 0 ? 'num-green' : '')
  ].join('');
}

function renderTradeJournal() {
  const target = document.getElementById('tradeJournalBody');
  if (!target) return;

  document.querySelectorAll('.journal-pill').forEach(button => {
    button.classList.toggle('active', button.dataset.journal === activeTradeJournalFilter);
  });

  const rows = tradeJournalRows().filter(matchesTradeJournalFilter);
  renderJournalQuickStats(rows);
  target.innerHTML = rows.length
    ? rows.map(row => {
      const direction = safe(row.direction);
      const directionClass = direction === 'LONG' ? 'long' : direction === 'SHORT' ? 'short' : 'info';
      const result = formatJournalResult(row);
      return `<tr>
        <td class="journal-time">${formatSystemDateTime(row.time)}</td>
        <td><strong>${safe(row.symbol)}</strong></td>
        <td><span class="badge ${directionClass}">${direction}</span></td>
        <td>${safe(row.timeframe)}</td>
        <td>${formatTradeNumber(row.entry)}</td>
        <td class="num-red">${formatTradeNumber(row.sl)}</td>
        <td class="num-cyan">${formatTradeNumber(row.tp1)}</td>
        <td class="num-green">${formatTradeNumber(row.tp2)}</td>
        <td>${formatPositionValue(row.position_value)}</td>
        <td><span class="badge ${statusClass(row.status)}">${safe(row.status)}</span></td>
        <td><strong class="${journalResultClass(result)}">${result}</strong></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="11" class="empty-state">Chưa có nhật ký giao dịch.</td></tr>';
}

function renderSystemSummary() {
  const sys = dashboardData.system || {};
  document.getElementById('systemSummary').innerHTML = `<div class="panel-title">〽 Tóm tắt trạng thái</div>
    ${systemRow('Risk lock hôm nay', sys.risk_lock ? 'Bật' : 'Tắt', sys.risk_lock)}
    ${systemRow('Trạng thái dữ liệu', sys.data_status, false)}${systemRow('Lỗi gần nhất', sys.last_error, false)}${systemRow('Quét M5 cuối', sys.last_m5_scan, false, 'num-cyan')}${systemRow('Vị thế active', sys.active_positions, false)}`;
}
function systemRow(label, value, danger=false, cls='num-green') { return `<div class="system-row"><span>${label}</span><strong class="${danger?'num-red':cls}">${safe(value)}</strong></div>`; }

function hideLogSystemSummary() {
  const panel = document.getElementById('systemSummary');
  if (!panel) return;
  panel.classList.add('logs-system-summary-hidden');
  panel.innerHTML = '';
}

function displayBool(value, fallback = '--') {
  if (value === true) return 'Bật';
  if (value === false) return 'Tắt';
  return safe(value, fallback);
}

function displayNormalBool(value) {
  if (value === true) return 'Có';
  if (value === false) return 'Không';
  return safe(value, '--');
}

function displayList(value) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '--';
  return safe(value);
}

function shortErrorText(value) {
  const text = safeStatus(value).trim();
  if (!text) return '';
  return text.split('\n')[0].replace(/\s{2,}/g, ' ').slice(0, 180);
}

function formatSystemDateTime(value) {
  if (value === undefined || value === null) return '--';
  const raw = safeStatus(value).trim();
  if (!raw || raw === '--') return '--';

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]} ${isoMatch[4]}:${isoMatch[5]}`;

  if (typeof value === 'number' || /^\d{10,13}$/.test(raw)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
      if (!Number.isNaN(date.getTime())) {
        const pad = part => String(part).padStart(2, '0');
        return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
    }
  }

  return safe(value);
}

function systemScanRows() {
  const sys = dashboardData.system || {};
  const source = sys.scan_timeframes;
  const fallbackRows = [
    { timeframe: 'M5', role: 'Intraday', last_scan: sys.last_m5_scan, next_scan: '--', status: sys.scan_status || 'Chờ nến đóng' },
    { timeframe: 'M15', role: 'Swing', last_scan: '--', next_scan: '--', status: sys.scan_status || 'Chờ nến đóng' },
    { timeframe: 'H1', role: 'Position', last_scan: '--', next_scan: '--', status: sys.scan_status || 'Chờ nến đóng' }
  ];

  const rows = Array.isArray(source)
    ? source
    : source && typeof source === 'object'
      ? Object.entries(source).map(([timeframe, value]) => ({ timeframe, ...(typeof value === 'object' ? value : { status: value }) }))
      : fallbackRows;

  const cleanedRows = rows
    .map(row => ({
      timeframe: safe(row.timeframe || row.tf || row.frame || row.name || row.label, '').toUpperCase(),
      role: safe(row.role || row.description),
      last_scan: safe(row.last_scan || row.lastScan || row.last || row.last_at),
      next_scan: safe(row.next_scan || row.nextScan || row.next || row.next_at),
      status: safe(row.status || sys.scan_status, 'Chờ nến đóng')
    }))
    .filter(row => row.timeframe && row.timeframe !== 'M1');

  return cleanedRows.length ? cleanedRows : fallbackRows;
}

function systemListRow(label, value, cls = '') {
  return `<div class="system-list-row"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function systemInfoRow(label, value, cls = '') {
  return `<div class="system-info-row"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function watchlistItems(value) {
  const source = Array.isArray(value)
    ? value
    : safeStatus(value).split(/[,\s|]+/);
  return source
    .map(item => safeStatus(item).trim())
    .filter(Boolean)
    .map(item => item.replace(/USDT$/i, '').toUpperCase());
}

function renderWatchlistChips(watchlist) {
  const items = watchlistItems(watchlist);
  if (!items.length) {
    return `<div class="watchlist-block">
      <div class="watchlist-label">Watchlist</div>
      <div class="watchlist-empty">--</div>
    </div>`;
  }

  return `<div class="watchlist-block">
    <div class="watchlist-label">Watchlist</div>
    <div class="watchlist-chips">${items.map(item => `<span class="watchlist-chip">${item}</span>`).join('')}</div>
  </div>`;
}

function systemStatusCard(icon, label, value, note, cls = '') {
  return `<article class="system-status-card">
    <div class="system-card-icon">${icon}</div>
    <div class="system-card-content">
      <div class="system-card-label">${label}</div>
      <div class="system-card-value ${cls}">${safe(value)}</div>
      <div class="system-card-note">${note}</div>
    </div>
  </article>`;
}

function renderSystemTab() {
  const sys = dashboardData.system || {};
  const summary = dashboardData.summary || {};
  const bot = dashboardData.bot || {};

  const botStatus = safe(sys.bot_status_text || bot.status_text, 'Đang hoạt động');
  const scanStatus = safe(sys.scan_status, 'Chờ nến đóng');
  const riskLock = sys.risk_lock ? 'Bật' : 'Tắt';
  const activePositions = safeNumber(sys.active_positions);

  document.getElementById('systemKpis').innerHTML = [
    systemStatusCard('●', 'Bot trạng thái', botStatus, 'trạng thái vận hành', 'num-green'),
    systemStatusCard('⟳', 'Scan status', scanStatus, 'nhịp quét tín hiệu', 'num-cyan'),
    systemStatusCard('🛡', 'Risk lock', riskLock, 'kiểm soát rủi ro', sys.risk_lock ? 'num-red' : 'num-green'),
    systemStatusCard('↔', 'Vị thế active', activePositions, 'đang theo dõi', 'num-green')
  ].join('');

  document.getElementById('systemScanBody').innerHTML = systemScanRows().map(row => `<tr>
    <td><strong>${safe(row.timeframe)}</strong></td>
    <td>${safe(row.role)}</td>
    <td class="num-cyan">${formatSystemDateTime(row.last_scan)}</td>
    <td>${formatSystemDateTime(row.next_scan)}</td>
    <td><span class="badge info">${safe(row.status, 'Chờ nến đóng')}</span></td>
  </tr>`).join('');

  document.getElementById('marketDataStatus').innerHTML = [
    renderWatchlistChips(sys.watchlist_public),
    systemInfoRow('Data status', safe(sys.data_status, 'Bình thường'), 'num-green'),
    systemInfoRow('Cache', safe(sys.cache_status)),
    systemInfoRow('Stale data', displayNormalBool(sys.stale_data), sys.stale_data ? 'num-red' : 'num-green'),
    systemInfoRow('Đồng bộ dashboard', safe(sys.dashboard_sync, 'Bình thường'), 'num-green')
  ].join('');

  document.getElementById('positionsStatus').innerHTML = [
    systemListRow('Active positions', safeNumber(sys.active_positions)),
    systemListRow('Active signals', safeNumber(sys.active_signals, safeNumber(summary.active_signals))),
    systemListRow('Pending signals', safeNumber(sys.pending_signals, safeNumber(summary.pending_signals))),
    systemListRow('Closed hôm nay', safeNumber(sys.closed_today)),
    systemListRow('Daily loss count', safeNumber(sys.daily_loss_count))
  ].join('');

  document.getElementById('botOpsStatus').innerHTML = [
    systemListRow('Execution mode', safe(sys.execution_mode_public)),
    systemListRow('Send group calls', displayBool(sys.send_group_calls)),
    systemListRow('Send admin reports', displayBool(sys.send_admin_reports)),
    systemListRow('Lần reset gần nhất', formatSystemDateTime(sys.last_reset_at))
  ].join('');

  const errorText = shortErrorText(sys.last_error);
  document.getElementById('lastErrorStatus').innerHTML = errorText
    ? `<strong class="num-red">${errorText}</strong>`
    : '<strong class="num-green">Không có lỗi gần đây</strong><span>Hệ thống đang hoạt động ổn định</span>';

  const recentLogs = arr(sys.recent_system_logs).length
    ? arr(sys.recent_system_logs)
    : arr(dashboardData.activity_logs).filter(log => ['SYSTEM', 'Hệ thống', 'Trạng thái'].includes(safeStatus(log.type)));
  document.getElementById('recentSystemLogs').innerHTML = recentLogs.length
    ? recentLogs.slice(0, 8).map(log => `<div class="system-log-row"><span class="timeline-time">${formatSystemDateTime(log.time || log.created_at)}</span><span>${highlightMessage(log.message || log.event || log.text)}</span></div>`).join('')
    : '<div class="empty-state">Chưa có nhật ký hệ thống.</div>';
}

function renderActivityLogs() {
  const search = (document.getElementById('logSearch')?.value || '').toLowerCase();
  const logs = arr(dashboardData.activity_logs).filter(l => (activeLogFilter === 'all' || l.type === activeLogFilter) && safeStatus(l.message).toLowerCase().includes(search));
  document.getElementById('activityLogs').innerHTML = logs.length
    ? logs.map(log => `<div class="timeline-row"><span class="timeline-time">${safe(log.time)}</span><span class="log-type ${typeClass(log.type)}">${publicLogType(log.type)}</span><span>${highlightMessage(log.message)}</span></div>`).join('')
    : '<div class="empty-state">Chưa có nhật ký</div>';
}

function logRow(log) {
  return `<div class="timeline-row"><span class="timeline-time">${safeStatus(log.time).slice(0,5) || '--'}</span><span class="timeline-dot ${dotClass(log.type)}"></span><span>${highlightMessage(log.message)}</span></div>`;
}
function dotClass(type) { return type === 'Cảnh báo' ? 'yellow' : type === 'Thoát lệnh' ? 'red' : type === 'Vào lệnh' ? 'green' : ''; }
function typeClass(type) { return type === 'Cảnh báo' ? 'num-red' : type === 'Thoát lệnh' ? 'num-red' : type === 'Vào lệnh' ? 'num-green' : type === 'Tín hiệu' ? 'num-cyan' : 'num-cyan'; }
function highlightMessage(message) {
  return sanitizePublicText(message)
    .replace(/\bLONG\b/g, '<strong class="pos">LONG</strong>')
    .replace(/\bSHORT\b/g, '<strong class="neg">SHORT</strong>')
    .replace(/TP1|TP2/g, '<strong class="num-green">$&</strong>')
    .replace(/\bSL\b/g, '<strong class="num-red">SL</strong>');
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    button.classList.add('active');
    const panel = document.getElementById(`tab-${button.dataset.tab}`);
    if (panel) {
      panel.classList.add('active', 'tab-transitioning');
      setTimeout(() => panel.classList.remove('tab-transitioning'), 260);
    }
  }));

  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    activeSignalFilter = button.dataset.filter;
    selectedSignalIndex = 0;
    renderSignalTable();
  }));
  ['pairFilter','tfFilter','dirFilter'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { selectedSignalIndex = 0; renderSignalTable(); }));
  document.getElementById('resetFilters')?.addEventListener('click', () => {
    activeSignalFilter = 'all'; selectedSignalIndex = 0;
    document.querySelectorAll('.filter').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    document.getElementById('pairFilter').value = 'all'; document.getElementById('tfFilter').value = 'all'; document.getElementById('dirFilter').value = 'all'; renderSignalTable();
  });
  document.querySelectorAll('.log-pill').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.log-pill').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    if (button.classList.contains('journal-pill')) {
      activeTradeJournalFilter = button.dataset.journal || 'all';
      renderTradeJournal();
    } else {
      activeLogFilter = logFilterValue(button.dataset.log);
      renderActivityLogs();
    }
  }));
  document.getElementById('logSearch')?.addEventListener('input', renderActivityLogs);
}

function renderAll() {
  ensureSystemTab();
  ensureTradeJournalLayout();
  bindEvents();
  renderHeader();
  renderHome();
  renderSignals();
  renderPerformance();
  renderLogs();
  renderSystemTab();
}

ensureFavicon();
loadData();
setInterval(() => {
  refreshDashboard();
}, 30000);
