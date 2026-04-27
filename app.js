let dashboardData = null;
let activeSignalFilter = 'all';
let selectedSignalIndex = 0;
let activeLogFilter = 'all';
let eventsBound = false;
let previousMetricSnapshot = null;
let changedMetrics = new Set();
let liveStateTimer = null;
let refreshInFlight = false;

const DASHBOARD_API_URL = 'https://bingx-dashboard-api.nguyenvanvinh030625.workers.dev/dashboard';
const LOCAL_FALLBACK_URL = 'public_dashboard.json';
const DISPLAY_BRAND_NAME = '@damfuturenhucon';

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

function sparkSvg(points = [4,8,6,12,11,17,14,22]) {
  const max = Math.max(...points), min = Math.min(...points);
  const step = 100 / (points.length - 1);
  const coords = points.map((p, i) => `${i * step},${38 - ((p - min) / Math.max(1, max - min)) * 32}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><path d="M ${coords.replaceAll(' ', ' L ')}" /></svg>`;
}

function kpiCard(icon, label, value, sub, negative = false, metricKeys = []) {
  const keys = Array.isArray(metricKeys) ? metricKeys : metricKeys ? [metricKeys] : [];
  const changed = keys.some(key => changedMetrics.has(key));
  const metricAttr = keys.length ? ` data-metric="${keys[0]}"` : '';
  return `<article class="kpi-card ${changed ? 'value-updated' : ''}"${metricAttr}>
    <div class="kpi-icon">${icon}</div>
    <div><div class="kpi-label">${label}</div><div class="kpi-value ${negative ? 'num-red' : ''} ${changed ? 'value-flash' : ''}">${value}</div><div class="kpi-sub">${sub}</div></div>
    ${sparkSvg(negative ? [22,20,18,19,14,12,9,8] : [4,6,5,10,8,14,12,18,16,22])}
  </article>`;
}

function renderHeader() {
  const bot = dashboardData.bot || {};
  document.title = DISPLAY_BRAND_NAME;
  document.querySelector('h1').textContent = DISPLAY_BRAND_NAME;
  document.getElementById('botStatusText').textContent = safe(bot.status_text);
  const updatedAt = dashboardData.cloudflare_published_at || bot.updated_at;
  document.getElementById('updatedAt').innerHTML = `<span class="live-badge">Live</span> ${freshnessText(updatedAt)}`;
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
  renderHomePerformancePanels();
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

  if (!document.getElementById('homeAnalyticsGrid') && activeGrid) {
    const analytics = document.createElement('div');
    analytics.id = 'homeAnalyticsGrid';
    analytics.className = 'home-analytics-grid';
    analytics.innerHTML = `
      <section class="panel home-performance-panel">
        <div class="panel-title">↗ Hiệu suất 30 ngày</div>
        <div class="legend home-chart-legend"><span class="dot green"></span> Tổng lợi nhuận (R) <span class="dash"></span> Vốn tham chiếu (0R)</div>
        <div id="homeLineChart" class="line-chart home-line-chart"></div>
        <div class="home-metric-strip" id="homePerformanceStats"></div>
      </section>
      <section class="panel home-distribution-panel">
        <div class="panel-title">◔ Phân bổ tín hiệu</div>
        <div id="homeDistribution" class="distribution home-distribution"></div>
      </section>
      <section class="panel home-signal-stats-panel">
        <div class="panel-title">▦ Thống kê tín hiệu</div>
        <div id="homeSignalStats" class="home-signal-stats"></div>
      </section>`;
    activeGrid.insertAdjacentElement('afterend', analytics);
  }
}

function renderActiveTrades(activeTrades = []) {
  document.getElementById('activeTradesBody').innerHTML = activeTrades.length
    ? activeTrades.map(t => tradeRow(t, metricChanged('active_trades.count'))).join('')
    : '<tr><td colspan="7" class="empty-state">Hiện tại không có lệnh nào đang mở</td></tr>';
}

function renderHomePerformancePanels() {
  const s = dashboardData.summary || {};
  renderLineChart('homeLineChart');
  renderDistribution('homeDistribution');

  document.getElementById('homePerformanceStats').innerHTML = [
    homeMetric('Tổng PnL', fmtR(s.total_r), safeNumber(s.total_r) < 0 ? 'num-red' : 'num-green'),
    homeMetric('Win rate', `${safeNumber(s.win_rate)}%`, 'num-green'),
    homeMetric('Số lệnh', safeNumber(s.total_signals), 'num-cyan')
  ].join('');

  renderHomeSignalStats();
}

function homeMetric(label, value, cls = '') {
  return `<div class="home-mini-stat"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function renderHomeSignalStats() {
  const s = dashboardData.summary || {};
  const signals = arr(dashboardData.signals);
  const longCount = signals.filter(sig => sig.direction === 'LONG').length;
  const shortCount = signals.filter(sig => sig.direction === 'SHORT').length;
  const pendingCount = s.pending_signals ?? signals.filter(sig => safeStatus(sig.status).includes('Chờ')).length;
  const closedCount = s.closed_signals ?? signals.filter(sig => {
    const status = safeStatus(sig.status);
    return ['TP1', 'TP2', 'SL', 'Thoát'].some(x => status.includes(x));
  }).length;
  const canceledCount = signals.filter(sig => /hủy|huỷ|cancel/i.test(safeStatus(sig.status))).length;
  const rows = [
    ['Tổng tín hiệu', safeNumber(s.total_signals, signals.length), 'num-cyan'],
    ['LONG', longCount, 'num-green'],
    ['SHORT', shortCount, 'num-red'],
    ['Đang chờ', safeNumber(pendingCount), 'num-cyan'],
    ['Đã đóng', safeNumber(closedCount), 'num-green']
  ];
  if (canceledCount) rows.push(['Đã hủy', canceledCount, 'num-red']);

  document.getElementById('homeSignalStats').innerHTML = rows
    .map(([label, value, cls]) => `<div class="home-stat-row"><span>${label}</span><strong class="${cls}">${safe(value)}</strong></div>`)
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
    document.getElementById('signalsBody').innerHTML = '<tr><td colspan="8" class="empty-state">Chưa có tín hiệu public</td></tr>';
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
  const s = dashboardData.summary || {};
  document.getElementById('performanceKpis').innerHTML = [
    kpiCard('🏆', 'Win rate', `${safeNumber(s.win_rate)}%`, '30 ngày gần nhất', false, 'summary.win_rate'),
    kpiCard('$', 'Tổng lợi nhuận', fmtR(s.total_r), '30 ngày gần nhất', false, 'summary.total_r'),
    kpiCard('📡', 'Tổng tín hiệu', safeNumber(s.total_signals), '30 ngày gần nhất', false, 'summary.total_signals'),
    kpiCard('↘', 'Drawdown tối đa', fmtR(s.max_drawdown_r), '30 ngày gần nhất', true)
  ].join('');
  renderLineChart();
  renderWeeklyBars();
  renderDistribution();
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
function renderWeeklyBars() {
  const weeklyResults = arr(dashboardData.weekly_results);
  const max = Math.max(1, ...weeklyResults.map(w => Math.abs(Number(w.r) || 0)));
  document.getElementById('weeklyBars').innerHTML = weeklyResults.length
    ? weeklyResults.map(w => {
      const value = safeNumber(w.r);
      return `<div class="bar-item"><div class="bar-value">${fmtR(value)}</div><div class="bar" style="height:${Math.max(35, (Math.abs(value)/max)*180)}px"></div><div class="bar-label">${safe(w.label)}<br><small>(${safe(w.range)})</small></div></div>`;
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
  renderActivityLogs();
  renderSystemSummary();
  const d = dashboardData.daily_events || {};
  document.getElementById('dailyHighlights').innerHTML = `<div class="panel-title">☆ Sự kiện nổi bật hôm nay</div>${eventCard('＋','Tín hiệu được tạo',d.signals_created)}${eventCard('↪','Lệnh đã vào',d.entries_executed)}${eventCard('◎','TP hit',d.tp_hit)}${eventCard('✕','SL hit',d.sl_hit, true)}`;
}

function eventCard(icon, label, value, red=false) { return `<div class="event-card"><span class="kpi-icon" style="width:40px;height:40px;font-size:18px">${icon}</span><span>${label}</span><strong class="${red?'num-red':'num-green'}" style="font-size:24px">${safeNumber(value)}</strong></div>`; }

function renderSystemSummary() {
  const sys = dashboardData.system || {};
  document.getElementById('systemSummary').innerHTML = `<div class="panel-title">〽 Tóm tắt trạng thái</div>
    ${systemRow('Risk lock hôm nay', sys.risk_lock ? 'Bật' : 'Tắt', sys.risk_lock)}
    ${systemRow('Trạng thái dữ liệu', sys.data_status, false)}${systemRow('Lỗi gần nhất', sys.last_error, false)}${systemRow('Quét M1 cuối', sys.last_m1_scan, false, 'num-cyan')}${systemRow('Quét M5 cuối', sys.last_m5_scan, false, 'num-cyan')}${systemRow('Vị thế active', sys.active_positions, false)}`;
}
function systemRow(label, value, danger=false, cls='num-green') { return `<div class="system-row"><span>${label}</span><strong class="${danger?'num-red':cls}">${safe(value)}</strong></div>`; }

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
    activeLogFilter = logFilterValue(button.dataset.log);
    renderActivityLogs();
  }));
  document.getElementById('logSearch')?.addEventListener('input', renderActivityLogs);
}

function renderAll() {
  bindEvents();
  renderHeader();
  renderHome();
  renderSignals();
  renderPerformance();
  renderLogs();
}

ensureFavicon();
loadData();
setInterval(() => {
  refreshDashboard();
}, 30000);
