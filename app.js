let dashboardData = null;
let rawDashboardData = null;
let activeSignalFilter = 'all';
let selectedSignalIndex = 0;
let activeLogFilter = 'all';
let activeTradeJournalFilter = 'all';
let eventsBound = false;
let currentData = null;
let previousMetricSnapshot = null;
let changedMetrics = new Set();
let liveStateTimer = null;
let refreshInFlight = false;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeReconnectAttempt = 0;
let realtimeConnected = false;
let fallbackPollTimer = null;
let lastDataReceivedAt = null;
let selectedDailyProfitDayKey = null;
let shouldScrollToSelectedDay = false;

const REALTIME_WORKER_URL = "https://bingx-dashboard-realtime.nguyenvanvinh030625.workers.dev";
const DASHBOARD_API_URL = `${REALTIME_WORKER_URL}/dashboard`;
const REALTIME_WS_URL = `${REALTIME_WORKER_URL.replace(/^http/, 'ws')}/ws`;
const LEGACY_DASHBOARD_API_URL = 'https://bingx-dashboard-api.nguyenvanvinh030625.workers.dev/dashboard';
const LOCAL_FALLBACK_URL = 'public_dashboard.json';
const DEMO_DASHBOARD_URL = 'public_dashboard.demo.json';
const DISPLAY_BRAND_NAME = '@damfuturenhucon';
const DASHBOARD_TIMEZONE = "Asia/Ho_Chi_Minh";
const FALLBACK_POLL_MS = 5000;
const RECONNECT_DELAYS_MS = [1000, 2000, 3000, 5000, 10000];
const TIME_RANGE_STORAGE_KEY = 'dashboard_time_range';
const DEFAULT_TIME_RANGE = '30D';
const TIME_RANGE_OPTIONS = ['1D', '7D', '30D', '90D', 'ALL'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);
let selectedTimeRange = readStoredTimeRange();

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
function escapeHtml(value) {
  return safeStatus(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSymbolParts(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return { base: '--', quote: '' };

  if (raw.endsWith('USDT')) {
    return {
      base: raw.slice(0, -4),
      quote: 'USDT'
    };
  }

  return {
    base: raw,
    quote: ''
  };
}

function renderSymbol(symbol) {
  const { base, quote } = formatSymbolParts(symbol);
  return `<span class="symbol-base">${escapeHtml(base)}</span>${quote ? `<span class="symbol-quote">${escapeHtml(quote)}</span>` : ''}`;
}

function renderSymbolWithIcon(symbol, iconStyle = 'width:30px;height:30px;font-size:14px;margin-right:8px') {
  return `<span class="coin-icon" style="${iconStyle}">${iconFor(symbol)}</span>${renderSymbol(symbol)}`;
}

function getPairTimeText(item = {}) {
  const fields = [
    'closed_at',
    'closed_at_iso',
    'time',
    'time_iso',
    'opened_at',
    'opened_at_iso',
    'created_at_iso',
    'created_at',
    'timestamp',
    'updated_at',
    'display_time',
    'date'
  ];

  for (const field of fields) {
    const time = parseDashboardTime(item[field], item);
    if (time !== null) return formatDateTimeVN(time);
  }

  return '';
}

function renderPairTimeCell(item = {}, options = {}) {
  const symbol = safe(firstValue(item.symbol, item.coin), options.fallbackSymbol || 'ETHUSDT');
  const timeText = getPairTimeText(item);
  const iconStyle = options.iconStyle || 'width:30px;height:30px;font-size:14px;margin-right:8px';
  const extraClass = options.className ? ` ${escapeHtml(options.className)}` : '';
  return `<div class="pair-time-cell${extraClass}">
    <strong>${renderSymbolWithIcon(symbol, iconStyle)}</strong>
    ${timeText ? `<span class="pair-time">${escapeHtml(timeText)}</span>` : ''}
  </div>`;
}

const signalList = () => {
  const signals = arr(dashboardData?.signals);
  if (signals.length) return signals;
  return dashboardData?.latest_signal ? [dashboardData.latest_signal] : [];
};
const fmtR = (value) => {
  const number = safeNumber(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(Number.isInteger(number) ? 0 : 1)}R`;
};
function getRTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'neutral';
  if (number > 0) return 'positive';
  if (number < 0) return 'negative';
  return 'neutral';
}
function formatRNumber(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 0.000001) return '0';
  const abs = Math.abs(number);
  const formatted = Number.isInteger(abs)
    ? String(abs)
    : abs.toFixed(digits).replace(/\.0$/, '');
  return `${number > 0 ? '+' : '-'}${formatted}`;
}
function renderRParts(numberText, numericValue, options = {}) {
  const tone = getRTone(numericValue);
  const onSolid = options.onSolid ? ' on-solid' : '';
  const customClass = options.className || options.extraClass || '';
  const extraClass = customClass ? ` ${escapeHtml(customClass)}` : '';
  return `<span class="r-display ${tone}${onSolid}${extraClass}"><span class="r-value">${escapeHtml(numberText)}</span><span class="r-unit">R</span></span>`;
}
function renderRValue(value, options = {}) {
  const number = Number(value);
  return renderRParts(formatRNumber(number, options.digits ?? 1), number, options);
}
function renderRText(text, options = {}) {
  const raw = safeStatus(text).trim();
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)R$/i);
  if (!match) return escapeHtml(raw || '--');
  return renderRParts(match[1], Number(match[1]), options);
}
function renderTextWithRUnits(text, options = {}) {
  const escaped = escapeHtml(text);
  return escaped.replace(/([+-]?\d+(?:\.\d+)?)R\b/gi, (_match, numberText) => (
    renderRParts(numberText, Number(numberText), options)
  ));
}
function renderSvgRText(text) {
  const raw = safeStatus(text).trim();
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)R$/i);
  if (!match) return escapeHtml(raw || '--');
  return `<tspan class="svg-r-value">${escapeHtml(match[1])}</tspan><tspan class="svg-r-unit">R</tspan>`;
}
function renderSvgRValue(value, options = {}) {
  return renderSvgRText(`${formatRNumber(value, options.digits ?? 1)}R`);
}
const clsDir = (d) => safeStatus(d) === 'LONG' ? 'long' : 'short';
const iconFor = (symbol = '') => coinIconMap[safeStatus(symbol).replace('USDT', '')] || '◎';
const metricChanged = (...keys) => keys.some(key => changedMetrics.has(key));
const isMissingPrice = (value) => {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '-' || text === '--') return true;
    value = text.replace(/,/g, '');
  }
  const number = Number(value);
  return !Number.isFinite(number) || number === 0;
};
const cleanPrice = (value) => {
  if (isMissingPrice(value)) return null;
  const number = Number(typeof value === 'string' ? value.replace(/,/g, '') : value);
  return Number.isFinite(number) ? number : null;
};
const readTradeNumber = (value) => {
  return cleanPrice(value);
};
const formatMaybePrice = (value) => {
  const number = cleanPrice(value);
  if (number === null) return '--';
  const abs = Math.abs(number);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return number.toFixed(decimals).replace(/\.?0+$/, '');
};
const sanitizeRiskRewardText = (value, signal = {}) => {
  const text = safeStatus(value);
  if (!text || text === '--') return '';
  return text
    .split(/\s*[·|,]\s*/)
    .map(part => part.trim())
    .filter(part => {
      if (!part) return false;
      const upper = part.toUpperCase();
      if (upper.includes('TP1') && isMissingPrice(signal.tp1)) return false;
      if (upper.includes('TP2') && isMissingPrice(signal.tp2)) return false;
      const rMatch = upper.match(/([+-]?\d+(?:\.\d+)?)\s*R/);
      return !rMatch || Math.abs(Number(rMatch[1])) < 100;
    })
    .join(' · ');
};
const closePriceValue = (row = {}) => firstValue(
  row.exit_price,
  row.close_price,
  row.fill_price,
  row.avg_close_price,
  row.avg_exit_price,
  row.closed_price,
  row.executed_price
);
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
  const fallbackText = sanitizeRiskRewardText(firstValue(signal.rr_text, signal.risk_reward, signal.rr_display), signal);

  if ([entry, sl].some(value => value === null) || !['LONG', 'SHORT'].includes(direction)) return fallbackText || '--';

  const risk = direction === 'LONG'
    ? Math.abs(entry - sl)
    : Math.abs(sl - entry);
  if (risk <= 0) return fallbackText || '--';

  const parts = [];
  [['TP1', tp1], ['TP2', tp2]].forEach(([label, target]) => {
    if (target === null) return;
    const rr = direction === 'LONG'
      ? Math.abs(target - entry) / risk
      : Math.abs(entry - target) / risk;
    if (Number.isFinite(rr)) parts.push(`${label} ${rr.toFixed(1)}R`);
  });

  return parts.length ? parts.join(' · ') : fallbackText || '--';
}

function publicLogType(type) {
  return type === 'Hệ thống' ? 'Trạng thái' : safe(type);
}

function logFilterValue(value) {
  return value === 'status' ? 'Hệ thống' : value;
}

function canonicalTradeKey(row = {}) {
  for (const key of ['signal_id', 'trade_id', 'order_id', 'entry_order_id', 'exchange_order_id', 'id']) {
    const value = firstValue(row[key]);
    if (value !== undefined && value !== null && value !== '') return `${key}:${safeStatus(value)}`;
  }

  const symbol = safeStatus(row.symbol || row.coin).toUpperCase() || '--';
  const direction = safeStatus(row.direction || row.side).toUpperCase() || '--';
  const timeframe = safeStatus(row.timeframe || row.tf || row.frame).toUpperCase() || '--';
  const entry = cleanPrice(row.entry);
  const entryText = entry === null ? '--' : String(entry);
  const openedAt = firstValue(row.opened_at, row.opened_at_iso, row.entry_at, row.created_at_iso, row.created_at, row.called_at);
  const fallbackTime = entry === null
    ? firstValue(row.closed_at_iso, row.closed_at, row.time_iso, row.timestamp, row.time, row.date, row.display_time)
    : '';
  return ['fields', symbol, direction, timeframe, entryText, safeStatus(openedAt || fallbackTime || '--')].join('|');
}

function statusPriority(row = {}) {
  if (isClosedTrade(row)) return 3;
  if (isJournalRunning(row)) return 2;
  if (isPendingHistoryRow(row)) return 1;
  return 0;
}

function mergeTradeRows(existing = {}, incoming = {}) {
  const preferred = statusPriority(incoming) >= statusPriority(existing) ? incoming : existing;
  const other = preferred === incoming ? existing : incoming;
  const merged = { ...other, ...preferred };
  ['entry', 'sl', 'tp1', 'tp2', 'exit_price', 'close_price'].forEach(key => {
    if (isMissingPrice(merged[key]) && !isMissingPrice(other[key])) merged[key] = other[key];
  });
  ['opened_at', 'opened_at_iso', 'closed_at', 'closed_at_iso', 'time', 'time_iso', 'created_at', 'created_at_iso', 'result', 'result_text', 'r'].forEach(key => {
    if ((merged[key] === undefined || merged[key] === null || merged[key] === '') && other[key] !== undefined && other[key] !== null && other[key] !== '') {
      merged[key] = other[key];
    }
  });
  return merged;
}

function dedupeTradeRows(rows = []) {
  const byKey = new Map();
  arr(rows).forEach(row => {
    const key = canonicalTradeKey(row);
    if (!byKey.has(key)) {
      byKey.set(key, row);
      return;
    }
    byKey.set(key, mergeTradeRows(byKey.get(key), row));
  });
  return Array.from(byKey.values());
}

function dedupeClosedTradeRows(rows = []) {
  return dedupeTradeRows(arr(rows).filter(isClosedTrade));
}

function resultActionLabel(result) {
  if (result === 'TP1' || result === 'TP2') return `Chốt ${result}`;
  if (result === 'SL') return 'Dừng lỗ';
  if (result === 'Thoát sớm') return 'Thoát sớm';
  if (result === 'Hòa vốn') return 'Hòa vốn';
  if (result === 'Đóng tay') return 'Đóng tay';
  return result || 'Đóng lệnh';
}

function formatResultDisplay(row = {}, { includePrice = false, includeR = false, action = false } = {}) {
  const result = normalizeResult(row) || compactResultLabel(row.result || row.result_text);
  if (!result || result === '--') return '--';
  let text = action ? resultActionLabel(result) : result;
  const price = includePrice ? cleanPrice(closePriceValue(row)) : null;
  if (price !== null) text += ` @ ${formatMaybePrice(price)}`;
  const rValue = readTradeR(row);
  if (includeR && rValue !== null) text += ` (${fmtR(rValue)})`;
  return text;
}

function isGenericClosedMessage(message) {
  const text = safeStatus(message).toUpperCase();
  return text
    && !normalizeResult(text)
    && (text.includes('ĐÃ ĐÓNG') || text.includes('DA DONG') || text.includes('CLOSED') || text.includes('ĐÓNG LỆNH') || text.includes('DONG LENH'));
}

function logSymbolDirection(log = {}) {
  const message = safeStatus(log.message || log.event || log.text).toUpperCase();
  const symbol = safeStatus(log.symbol).toUpperCase() || (message.match(/\b([A-Z0-9]{2,20}USDT)\b/) || [])[1] || '';
  const direction = safeStatus(log.direction).toUpperCase() || (message.match(/\b(LONG|SHORT)\b/) || [])[1] || '';
  return { symbol, direction };
}

function sameTradeLog(a = {}, b = {}) {
  const left = logSymbolDirection(a);
  const right = logSymbolDirection(b);
  if (left.symbol && right.symbol && left.symbol !== right.symbol) return false;
  if (left.direction && right.direction && left.direction !== right.direction) return false;
  const leftTime = getItemTimestamp(a);
  const rightTime = getItemTimestamp(b);
  if (leftTime !== null && rightTime !== null) return Math.abs(leftTime - rightTime) <= 10 * 60 * 1000;
  const leftHHmm = formatHHmm(firstValue(a.time_iso, a.created_at_iso, a.updated_at, a.created_at, a.time), a);
  const rightHHmm = formatHHmm(firstValue(b.time_iso, b.created_at_iso, b.updated_at, b.created_at, b.time), b);
  return leftHHmm !== '--' && leftHHmm === rightHHmm;
}

function dedupeGenericClosedLogs(logs = []) {
  const source = arr(logs);
  const specific = source.filter(log => normalizeResult(log.message || log.event || log.text));
  const seen = new Set();
  return source.filter(log => {
    if (isGenericClosedMessage(log.message || log.event || log.text) && specific.some(item => sameTradeLog(log, item))) return false;
    const key = [safeStatus(log.time || log.time_iso), safeStatus(log.type), safeStatus(log.message || log.event || log.text)].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function readStoredTimeRange() {
  try {
    const stored = window.localStorage.getItem(TIME_RANGE_STORAGE_KEY);
    return TIME_RANGE_OPTIONS.includes(stored) ? stored : DEFAULT_TIME_RANGE;
  } catch (error) {
    return DEFAULT_TIME_RANGE;
  }
}

function saveSelectedTimeRange() {
  try {
    window.localStorage.setItem(TIME_RANGE_STORAGE_KEY, selectedTimeRange);
  } catch (error) {
    console.warn('[dashboard] Could not save selected time range', error);
  }
}

function getVietnamNow() {
  return new Date();
}

function getVietnamDateParts(date = getVietnamNow()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const read = type => Number(parts.find(part => part.type === type)?.value || 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second')
  };
}

function createVietnamDate(year, month, day, hour = 0, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - VIETNAM_UTC_OFFSET_MS);
}

function getVietnamStartOfToday(date = getVietnamNow()) {
  const parts = getVietnamDateParts(date);
  return createVietnamDate(parts.year, parts.month, parts.day);
}

function getVietnamStartOfDay(date = getVietnamNow()) {
  const parts = getVietnamDateParts(date);
  return createVietnamDate(parts.year, parts.month, parts.day);
}

function addVietnamDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function getVietnamStartOfMonth(date = getVietnamNow()) {
  const parts = getVietnamDateParts(date);
  return createVietnamDate(parts.year, parts.month, 1);
}

function addVietnamMonths(date, months) {
  const parts = getVietnamDateParts(date);
  return createVietnamDate(parts.year, parts.month + months, 1);
}

function getRangeStartDate(range) {
  if (range === 'ALL') return null;
  const daysBack = { '1D': 0, '7D': 6, '30D': 29, '90D': 89 }[range];
  if (daysBack === undefined) return null;
  return new Date(getVietnamStartOfToday().getTime() - daysBack * MS_PER_DAY);
}

function getRangeBounds(range) {
  if (range === 'ALL') return { start: null, end: null };
  return {
    start: getRangeStartDate(range),
    end: getVietnamNow()
  };
}

function getRangeLabel(range = selectedTimeRange) {
  return {
    '1D': 'Hôm nay',
    '7D': '7 ngày gần nhất',
    '30D': '30 ngày gần nhất',
    '90D': '90 ngày gần nhất',
    ALL: 'Toàn bộ dữ liệu'
  }[range] || '30 ngày gần nhất';
}

function getPerformanceTitle(range = selectedTimeRange) {
  return {
    '1D': 'Hiệu suất hôm nay',
    '7D': 'Hiệu suất 7 ngày',
    '30D': 'Hiệu suất 30 ngày',
    '90D': 'Hiệu suất 90 ngày',
    ALL: 'Hiệu suất toàn thời gian'
  }[range] || 'Hiệu suất 30 ngày';
}

function getResultPeriodTitle(range = selectedTimeRange) {
  return {
    '1D': 'Kết quả hôm nay',
    '7D': 'Kết quả 7 ngày',
    '30D': 'Kết quả theo tuần',
    '90D': 'Kết quả theo tuần',
    ALL: 'Kết quả theo tuần'
  }[range] || 'Kết quả theo tuần';
}

function parseDashboardTime(value, item = {}) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const time = numeric < 1e12 ? numeric * 1000 : numeric;
      return Number.isNaN(time) ? null : time;
    }
  }

  const raw = safeStatus(value).trim();
  if (!raw || raw === '--') return null;

  let match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return createVietnamDate(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    ).getTime();
  }

  match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (match) {
    return createVietnamDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0)
    ).getTime();
  }

  match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match && item.date) {
    return parseDashboardTime(`${item.date} ${raw}`);
  }

  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;

  return null;
}

function parseDashboardTimestamp(value, item = {}) {
  return parseDashboardTime(value, item);
}

function formatDateShortYear(value, { dateOnly = false } = {}) {
  if (value === undefined || value === null || value === '') return '--';
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 1e9)) return '--';

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw || raw === '-' || raw === '--') return '--';
    const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (timeOnly) return `${String(timeOnly[1]).padStart(2, '0')}:${timeOnly[2]}`;
    const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (dmy) {
      const shortDate = `${String(dmy[1]).padStart(2, '0')}/${String(dmy[2]).padStart(2, '0')}/${String(Number(dmy[3]) % 100).padStart(2, '0')}`;
      return dmy[4] && !dateOnly ? `${shortDate} ${String(dmy[4]).padStart(2, '0')}:${dmy[5]}` : shortDate;
    }
    if (/^\d{4}$/.test(raw)) return '--';
  }

  const time = parseDashboardTime(value);
  if (time === null) return '--';
  const parts = getVietnamDateParts(new Date(time));
  const shortDate = `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}/${String(parts.year % 100).padStart(2, '0')}`;
  if (dateOnly) return shortDate;

  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return shortDate;
  return `${shortDate} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatDateVN(value) {
  return formatDateShortYear(value, { dateOnly: true });
}

function formatDateTimeVN(value) {
  return formatDateShortYear(value);
}

function formatItemDateTimeVN(item = {}) {
  const fields = ['created_at_iso', 'opened_at_iso', 'closed_at_iso', 'time_iso', 'timestamp', 'updated_at', 'created_at', 'time', 'date', 'display_time'];
  for (const field of fields) {
    const time = parseDashboardTime(item[field], item);
    if (time !== null) return formatDateTimeVN(time);
  }
  return '--';
}

function getItemTimestamp(item = {}) {
  const fields = [
    'created_at_iso',
    'opened_at_iso',
    'closed_at_iso',
    'time_iso',
    'timestamp',
    'updated_at',
    'created_at',
    'time',
    'date',
    'display_time'
  ];

  for (const field of fields) {
    const time = parseDashboardTime(item[field], item);
    if (time !== null) return time;
  }

  return null;
}

function getTradeJournalTimestamp(item = {}) {
  const fields = isClosedTrade(item)
    ? [
      'closed_at_iso',
      'closed_at',
      'exit_at',
      'exited_at',
      'closed_time',
      'time_iso',
      'timestamp',
      'updated_at',
      'time',
      'date',
      'display_time',
      'created_at_iso',
      'opened_at_iso',
      'created_at'
    ]
    : [
      'created_at_iso',
      'opened_at_iso',
      'time_iso',
      'timestamp',
      'updated_at',
      'created_at',
      'time',
      'date',
      'display_time'
    ];

  for (const field of fields) {
    const time = parseDashboardTime(item[field], item);
    if (time !== null) return time;
  }

  return null;
}

function getDatedItemTimestamp(item = {}) {
  const directTime = getItemTimestamp(item);
  if (directTime !== null) return directTime;

  const datedFields = ['date', 'range_end', 'end_date', 'range_start', 'start_date'];
  for (const field of datedFields) {
    const time = parseDashboardTime(item[field], item);
    if (time !== null) return time;
  }

  const rangeMatch = safeStatus(item.range).match(/(\d{4}-\d{2}-\d{2})\s+-\s+(\d{4}-\d{2}-\d{2})/);
  return rangeMatch ? parseDashboardTime(rangeMatch[2]) : null;
}

function isWithinSelectedRange(item, range = selectedTimeRange, timestampReader = getItemTimestamp) {
  if (range === 'ALL') return true;
  const bounds = getRangeBounds(range);
  if (!bounds.start || !bounds.end) return true;
  const time = timestampReader(item);
  if (time === null) return false;
  return time >= bounds.start.getTime() && time <= bounds.end.getTime();
}

function filterHistoricalRows(rows, range = selectedTimeRange, timestampReader = getItemTimestamp) {
  return arr(rows).filter(row => isWithinSelectedRange(row, range, timestampReader));
}

function isPendingHistoryRow(row = {}) {
  return getTradeOutcomeStatus(row) === 'Chờ xác nhận';
}

function isClosedHistoryRow(row = {}) {
  return isClosedTrade(row);
}

function normalizeDistributionOutcome(value) {
  return normalizeResult({ result: value });
}

function normalizeResult(row = {}) {
  const values = typeof row === 'object'
    ? [
      row.result,
      row.public_result,
      row.outcome,
      row.pnl_result,
      row.label,
      row.result_text,
      row.status,
      row.status_text,
      row.state,
      row.event
    ]
    : [row];
  const text = values.map(value => safeStatus(value)).join(' ').toUpperCase();
  if (/\bTP2\b/.test(text) || text.includes('TAKE_PROFIT_2') || text.includes('TAKE PROFIT 2') || /\bWIN\b/.test(text)) return 'TP2';
  if (/\bTP1\b/.test(text) || text.includes('TAKE_PROFIT_1') || text.includes('TAKE PROFIT 1')) return 'TP1';
  if (/\bTAKE[_\s-]?PROFIT\b/.test(text)) return 'TP2';
  if (/\bSL\b/.test(text) || text.includes('STOP LOSS') || text.includes('STOP_LOSS') || /\bLOST\b/.test(text) || /\bLOSS\b/.test(text)) return 'SL';
  if (text.includes('EARLY_EXIT') || text.includes('EXIT_EARLY') || text.includes('EARLY EXIT') || text.includes('THOÁT SỚM') || text.includes('THOAT SOM') || text.includes('THOAT_SOM')) return 'Thoát sớm';
  if (text.includes('BREAK_EVEN') || text.includes('BREAK EVEN') || text.includes('BREAKEVEN') || text.includes('HÒA VỐN') || text.includes('HOA VON') || /\bBE\b/.test(text)) return 'Hòa vốn';
  if (text.includes('MANUAL_CLOSE') || text.includes('CLOSED_MANUAL') || text.includes('MANUAL CLOSE') || text.includes('CLOSE MANUAL') || text.includes('ĐÓNG TAY') || text.includes('DONG TAY')) return 'Đóng tay';
  return '';
}

function readTradeR(row = {}) {
  const value = typeof row === 'object'
    ? firstValue(row.r, row.rr, row.r_multiple, row.result_r, row.pnl_r)
    : row;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const text = typeof row === 'object'
    ? safeStatus(firstValue(row.result_text, row.result, row.message))
    : safeStatus(row);
  const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*R\b/i);
  return match ? Number(match[1]) : null;
}

function isClosedTrade(row = {}) {
  const status = safeStatus(row.status).toLowerCase();
  return status.includes('đã đóng')
    || status.includes('closed')
    || Boolean(normalizeResult(row))
    || readTradeR(row) !== null;
}

function tradeLifecycleText(row = {}) {
  return [
    row.status,
    row.public_status,
    row.status_text,
    row.state,
    row.lifecycle,
    row.phase
  ].map(value => safeStatus(value)).join(' ').toUpperCase();
}

function isRunningStatus(row = {}) {
  const text = tradeLifecycleText(row);
  return row.active === true
    || row.is_active === true
    || text.includes('ĐANG CHẠY')
    || text.includes('DANG CHAY')
    || /\b(RUNNING|ACTIVE|OPEN|OPENED)\b/.test(text);
}

function isPendingStatus(row = {}) {
  const text = tradeLifecycleText(row);
  return text.includes('CHỜ')
    || text.includes('CHO')
    || /\b(PENDING|WAITING|CONFIRM|CONFIRMATION)\b/.test(text);
}

function getTradeOutcomeStatus(trade = {}) {
  if (isRunningStatus(trade)) return 'Đang chạy';
  if (isPendingStatus(trade)) return 'Chờ xác nhận';

  const outcome = normalizeResult(trade);
  if (outcome) return outcome;
  if (isClosedTrade(trade)) return 'Đã đóng';
  return '--';
}

function getTradeResultR(trade = {}) {
  const outcomeStatus = getTradeOutcomeStatus(trade);
  if (outcomeStatus === 'Đang chạy' || outcomeStatus === 'Chờ xác nhận' || outcomeStatus === '--') return null;

  const directValue = firstValue(trade.r, trade.r_multiple, trade.result_r, trade.pnl_r, trade.rr);
  const directNumber = Number(directValue);
  if (Number.isFinite(directNumber)) return directNumber;

  const text = [
    trade.result_text,
    trade.public_result,
    trade.result,
    trade.rr_text,
    trade.status,
    trade.message
  ].map(value => safeStatus(value)).join(' ');
  const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*R\b/i);
  return match ? Number(match[1]) : null;
}

function renderTradeResultR(trade = {}) {
  const rValue = getTradeResultR(trade);
  return rValue === null ? '--' : renderRValue(rValue);
}

function resultRowsForStats(tradeJournal, recentResults) {
  const journalRows = dedupeClosedTradeRows(tradeJournal);
  if (journalRows.length) return journalRows;
  return dedupeClosedTradeRows(recentResults);
}

function sumResultR(rows) {
  return arr(rows).reduce((sum, row) => {
    const value = readTradeR(row);
    return value !== null ? sum + value : sum;
  }, 0);
}

function recomputeSummary(source = {}, filtered = {}) {
  const base = source.summary || {};
  const activeTradesCount = Array.isArray(source.active_trades)
    ? source.active_trades.length
    : safeNumber(base.active_trades);
  const historyRows = arr(filtered.trade_journal).length ? arr(filtered.trade_journal) : arr(filtered.signals);
  const resultRows = resultRowsForStats(filtered.trade_journal, filtered.recent_results);
  const resolvedRows = resultRows.filter(row => ['TP1', 'TP2', 'SL'].includes(normalizeDistributionOutcome(row.result || row.status || row.label)));
  const wins = resolvedRows.filter(row => ['TP1', 'TP2'].includes(normalizeDistributionOutcome(row.result || row.status || row.label))).length;
  const totalR = sumResultR(resultRows);
  const totalSignals = historyRows.length || arr(filtered.signals).length || arr(filtered.recent_results).length;

  return {
    ...base,
    total_signals: totalSignals,
    win_rate: resolvedRows.length ? Number(((wins / resolvedRows.length) * 100).toFixed(1)) : 0,
    total_r: Number(totalR.toFixed(2)),
    active_trades: activeTradesCount,
    active_signals: activeTradesCount,
    pending_signals: historyRows.filter(isPendingHistoryRow).length,
    closed_signals: historyRows.filter(isClosedHistoryRow).length
  };
}

function recomputeResultDistribution(tradeJournal, recentResults, fallback = []) {
  const resultRows = resultRowsForStats(tradeJournal, recentResults);
  if (!resultRows.length && !arr(tradeJournal).length && !arr(recentResults).length) return arr(fallback);

  const counts = { SL: 0, TP1: 0, TP2: 0, 'Thoát sớm': 0 };
  resultRows.forEach(row => {
    const outcome = normalizeDistributionOutcome(row.result || row.status || row.label);
    if (outcome && counts[outcome] !== undefined) counts[outcome] += 1;
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return Object.entries(counts).map(([label, count]) => ({
    label,
    count,
    percent: total ? Number(((count / total) * 100).toFixed(1)) : 0
  }));
}

function recomputePairPerformance(tradeJournal, fallback = []) {
  const rows = arr(tradeJournal).filter(row => row.symbol && (isClosedHistoryRow(row) || row.r !== undefined));
  if (!arr(tradeJournal).length) return arr(fallback);

  const groups = new Map();
  rows.forEach(row => {
    const symbol = safeStatus(row.symbol).toUpperCase();
    if (!symbol) return;
    if (!groups.has(symbol)) groups.set(symbol, []);
    groups.get(symbol).push(row);
  });

  return Array.from(groups.entries())
    .map(([symbol, symbolRows]) => {
      const resolvedRows = symbolRows.filter(row => ['TP1', 'TP2', 'SL'].includes(normalizeDistributionOutcome(row.result || row.status || row.label)));
      const wins = resolvedRows.filter(row => ['TP1', 'TP2'].includes(normalizeDistributionOutcome(row.result || row.status || row.label))).length;
      const r = sumResultR(symbolRows);
      return {
        symbol,
        trades: symbolRows.length,
        win_rate: resolvedRows.length ? Number(((wins / resolvedRows.length) * 100).toFixed(1)) : 0,
        r: Number(r.toFixed(2))
      };
    })
    .sort((a, b) => safeNumber(b.r) - safeNumber(a.r));
}

function createFilteredDashboardData(source = {}) {
  if (!source || typeof source !== 'object') return source;

  const filtered = {
    ...source,
    signals: filterHistoricalRows(source.signals),
    trade_journal: dedupeTradeRows(filterHistoricalRows(source.trade_journal, selectedTimeRange, getTradeJournalTimestamp)),
    recent_results: dedupeClosedTradeRows(filterHistoricalRows(source.recent_results)),
    activity_logs: dedupeGenericClosedLogs(filterHistoricalRows(source.activity_logs)),
    performance_30d: filterHistoricalRows(source.performance_30d, selectedTimeRange, getDatedItemTimestamp),
    weekly_results: filterHistoricalRows(source.weekly_results, selectedTimeRange, getDatedItemTimestamp)
  };

  filtered.summary = recomputeSummary(source, filtered);
  filtered.result_distribution = recomputeResultDistribution(filtered.trade_journal, filtered.recent_results, source.result_distribution);
  filtered.pair_performance = recomputePairPerformance(filtered.trade_journal, source.pair_performance);
  return filtered;
}

function applyGlobalTimeRange() {
  if (!rawDashboardData) return;
  const nextData = createFilteredDashboardData(rawDashboardData);
  const nextSnapshot = createMetricSnapshot(nextData);
  changedMetrics = previousMetricSnapshot
    ? new Set(Object.keys(nextSnapshot).filter(key => nextSnapshot[key] !== previousMetricSnapshot[key]))
    : new Set();
  previousMetricSnapshot = nextSnapshot;
  dashboardData = nextData;
  currentData = nextData;
}

async function fetchDashboardJson(url, label) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`);
  return await res.json();
}

async function fetchRealtimeDashboard() {
  return await fetchDashboardJson(DASHBOARD_API_URL, 'Realtime dashboard');
}

async function loadDashboardData() {
  if (isDemoMode) {
    console.info('[dashboard] Demo mode: using public_dashboard.demo.json');
    return await fetchDashboardJson(DEMO_DASHBOARD_URL, 'Demo dashboard');
  }

  try {
    return await fetchRealtimeDashboard();
  } catch (err) {
    console.warn('[dashboard] Realtime worker fetch failed, trying local fallback', err);
  }

  try {
    return await fetchDashboardJson(LOCAL_FALLBACK_URL, 'Local fallback');
  } catch (err) {
    console.warn('[dashboard] Local fallback failed, trying legacy worker as final fallback', err);
  }

  return await fetchDashboardJson(LEGACY_DASHBOARD_API_URL, 'Legacy dashboard');
}

function createMetricSnapshot(data) {
  return Object.fromEntries(Object.entries(trackedMetrics).map(([key, read]) => [key, read(data)]));
}

function setDashboardData(nextRawData) {
  rawDashboardData = nextRawData;
  applyGlobalTimeRange();
  lastDataReceivedAt = new Date().toISOString();
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

function applyRealtimeSnapshot(nextData) {
  if (!nextData || typeof nextData !== 'object') return;
  markRefreshStart();
  setDashboardData(nextData);
  renderAll();
  markRefreshDone();
}

async function pollRealtimeDashboard() {
  if (isDemoMode || realtimeConnected || refreshInFlight) return;
  refreshInFlight = true;
  markRefreshStart();
  try {
    setDashboardData(await fetchRealtimeDashboard());
    renderAll();
    markRefreshDone();
  } catch (error) {
    document.body.classList.remove('data-refreshing');
    console.warn('[dashboard] Fallback realtime polling failed', error);
  } finally {
    refreshInFlight = false;
  }
}

function startFallbackPolling() {
  if (isDemoMode || fallbackPollTimer) return;
  fallbackPollTimer = setInterval(pollRealtimeDashboard, FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
}

function scheduleRealtimeReconnect(reason) {
  if (isDemoMode || realtimeReconnectTimer || realtimeConnected) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(realtimeReconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  realtimeReconnectAttempt += 1;
  console.warn(`[dashboard] WebSocket ${reason}; reconnecting in ${delay / 1000}s`);
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    connectRealtimeWebSocket();
  }, delay);
}

function handleRealtimeDisconnect(reason) {
  realtimeConnected = false;
  startFallbackPolling();
  scheduleRealtimeReconnect(reason);
  if (dashboardData) renderHeader();
}

function handleRealtimeMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    console.warn('[dashboard] Ignoring invalid WebSocket message', error);
    return;
  }

  if (message?.type === 'snapshot' && message.data) {
    applyRealtimeSnapshot(message.data);
  }
}

function connectRealtimeWebSocket() {
  if (isDemoMode) return;
  if (!('WebSocket' in window)) {
    console.warn('[dashboard] WebSocket is not available; using fallback polling');
    startFallbackPolling();
    return;
  }
  if (realtimeSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(realtimeSocket.readyState)) return;

  const socket = new WebSocket(REALTIME_WS_URL);
  realtimeSocket = socket;

  socket.addEventListener('open', () => {
    if (socket !== realtimeSocket) return;
    realtimeConnected = true;
    realtimeReconnectAttempt = 0;
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
    stopFallbackPolling();
    console.info('[dashboard] WebSocket connected');
    if (dashboardData) renderHeader();
  });

  socket.addEventListener('message', event => {
    if (socket !== realtimeSocket) return;
    handleRealtimeMessage(event);
  });

  socket.addEventListener('error', () => {
    if (socket !== realtimeSocket) return;
    handleRealtimeDisconnect('error');
    try {
      socket.close();
    } catch (error) {
      console.warn('[dashboard] WebSocket close after error failed', error);
    }
  });

  socket.addEventListener('close', () => {
    if (socket !== realtimeSocket) return;
    handleRealtimeDisconnect('closed');
  });
}

function startRealtimeUpdates() {
  if (isDemoMode) return;
  connectRealtimeWebSocket();
  startFallbackPolling();
}

function ensureHeaderRangeFilter() {
  const statusBox = document.querySelector('.status-box');
  if (!statusBox) return;
  if (statusBox.querySelector('.header-range-filter')) {
    updateRangeFilterButtons();
    return;
  }

  statusBox.innerHTML = `<div class="header-range-filter" aria-label="Lọc dữ liệu theo thời gian">
    ${TIME_RANGE_OPTIONS.map(range => `<button type="button" class="range-filter-button" data-range="${range}">${range}</button>`).join('')}
  </div>`;
  updateRangeFilterButtons();
}

function updateRangeFilterButtons() {
  document.querySelectorAll('.range-filter-button').forEach(button => {
    button.classList.toggle('active', button.dataset.range === selectedTimeRange);
  });
}

function handleTimeRangeChange(range) {
  if (!TIME_RANGE_OPTIONS.includes(range) || range === selectedTimeRange) return;
  selectedTimeRange = range;
  saveSelectedTimeRange();
  applyGlobalTimeRange();
  renderAll();
  markRefreshDone();
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
  document.title = DISPLAY_BRAND_NAME;
  document.querySelector('h1').textContent = DISPLAY_BRAND_NAME;
  ensureHeaderRangeFilter();
  updateRangeFilterButtons();
  updateHeaderScrollState();
}

function updateHeaderScrollState() {
  const header = document.querySelector('.app-header');
  if (!header) return;
  header.classList.toggle('is-scrolled', window.scrollY > 8);
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
  if (document.getElementById('tradeJournalBody') && document.getElementById('journalQuickStats') && document.getElementById('dailyProfitGrid')) return;

  logs.innerHTML = `
    <div class="journal-stats-grid" id="journalQuickStats"></div>
    <section class="panel daily-profit-panel">
      <div class="panel-title">📅 Lãi/lỗ theo ngày</div>
      <div class="daily-profit-grid" id="dailyProfitGrid"></div>
    </section>
    <section class="panel trade-journal-panel">
      <div class="journal-card-head">
        <div class="panel-title">Nhật ký giao dịch</div>
        <div class="journal-filter" aria-label="Lọc nhật ký giao dịch">
          ${[
            ['all', 'Tất cả'],
            ['running', 'Đang chạy'],
            ['closed', 'Đã đóng'],
            ['long', 'LONG'],
            ['short', 'SHORT'],
            ['sl', 'SL'],
            ['tp1', 'TP1'],
            ['tp2', 'TP2']
          ].map(([value, label], index) => `<button class="log-pill journal-pill ${index === 0 ? 'active' : ''}" data-journal="${value}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="table-wrap trade-journal-wrap">
        <table class="trade-journal-table">
          <thead><tr><th>Cặp / Thời gian</th><th>Hướng</th><th>Khung</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Giá trị lệnh</th><th>Trạng thái</th><th>Kết quả</th></tr></thead>
          <tbody id="tradeJournalBody"></tbody>
        </table>
      </div>
    </section>`;
}

function renderHome() {
  ensureHomeLayout();
  const s = dashboardData.summary || {};
  const rangeLabel = getRangeLabel();
  document.getElementById('homeKpis').innerHTML = [
    kpiCard('📡', 'Tổng tín hiệu', safeNumber(s.total_signals), rangeLabel, false, 'summary.total_signals'),
    kpiCard('🏆', 'Win rate', `${safeNumber(s.win_rate)}%`, rangeLabel, false, 'summary.win_rate'),
    kpiCard('$', 'Tổng lợi nhuận', renderRValue(s.total_r), rangeLabel, false, 'summary.total_r'),
    kpiCard('〽', 'Lệnh đang chạy', safeNumber(s.active_trades), 'cập nhật realtime', false, ['summary.active_trades', 'active_trades.count'])
  ].join('');

  const l = dashboardData.latest_signal || {};
  const latestSymbol = safe(l.symbol, 'ETHUSDT');
  const latestDirection = safe(l.direction, 'LONG');
  const latestStatus = getTradeOutcomeStatus(l);
  const latestChanged = metricChanged('latest_signal.symbol', 'latest_signal.status');
  const latestCard = document.getElementById('latestSignal');
  latestCard.classList.toggle('value-updated', latestChanged);
  document.getElementById('latestSignal').innerHTML = `<div class="latest-inner">
    <div class="panel-title">🔥 Tín hiệu mới nhất</div>
    <div class="latest-grid">
      <div class="signal-symbol"><span class="coin-icon ${metricChanged('latest_signal.symbol') ? 'soft-pulse' : ''}">${iconFor(latestSymbol)}</span><span class="big-symbol ${metricChanged('latest_signal.symbol') ? 'value-flash' : ''}">${renderSymbol(latestSymbol)}</span><span class="badge ${clsDir(latestDirection)}">${latestDirection}</span></div>
      ${field('Khung', l.timeframe)}${field('Entry', formatMaybePrice(l.entry))}${field('SL', formatMaybePrice(l.sl), 'num-red')}${field('TP1', formatMaybePrice(l.tp1), 'num-green')}${field('TP2', formatMaybePrice(l.tp2), 'num-green')}
      <div class="target-mark">◎</div>
    </div>
    <div class="latest-extra">
      ${field('Trạng thái', `<span class="badge ${statusClass(latestStatus)} ${metricChanged('latest_signal.status') ? 'value-updated' : ''}">${latestStatus}</span>`)}
      ${field('R:R', renderTextWithRUnits(formatRiskReward(l)), 'num-cyan')}
      ${field('Độ tự tin', l.confidence, 'num-green')}
      ${field('Thời gian', formatItemDateTimeVN(l))}
    </div>
  </div>`;

  const activeTrades = arr(dashboardData.active_trades);
  renderActiveTrades(activeTrades);

  document.getElementById('livePanelList').innerHTML = arr(dashboardData.live_panel).map(item => {
    const status = sanitizePublicText(item.status);
    const note = sanitizePublicText(item.note);
    return `<div class="live-row"><strong>${renderSymbol(item.symbol)}</strong><span><i class="state-dot ${safeStatus(status).includes('lệnh') ? 'green' : ''}"></i>${status}</span><span class="${safeStatus(note).includes('Chờ') ? 'num-red' : safeStatus(note).includes('setup') ? 'num-green' : ''}">${note}</span></div>`;
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
  const recentPanel = document.getElementById('recentResults')?.closest('.panel');
  const shortLogsPanel = document.getElementById('shortLogs')?.closest('.panel');
  const riskBanner = home?.querySelector('.risk-banner');

  shortLogsPanel?.remove();
  activeGrid?.classList.add('home-active-grid');
  activePanel?.classList.add('home-active-panel');
  livePanel?.classList.add('home-live-panel');
  recentPanel?.classList.add('home-results-panel');
  bottomGrid?.classList.add('home-bottom-grid', 'home-results-only');
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
  return normalizeResult({ result: value });
}

function readOutcomeCounts() {
  const counts = { SL: 0, TP1: 0, TP2: 0 };
  arr(dashboardData.result_distribution).forEach(item => {
    const outcome = normalizeOutcomeLabel(item.label || item.result || item.status);
    if (outcome) counts[outcome] += safeNumber(item.count);
  });

  if (Object.values(counts).some(Boolean)) return counts;

  dedupeClosedTradeRows(dashboardData.recent_results).forEach(item => {
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

  const target = document.getElementById(targetId);
  if (!target) return;
  target.classList.add('home-distribution');
  target.innerHTML = `
    <div class="home-donut" style="background:${homeDonutBackground(items)}">
      <div class="home-donut-inner"><strong>${distributionTotal}</strong><span>Lệnh đóng</span></div>
    </div>
    <div class="home-distribution-legend">
      ${items.map(item => `<div class="home-legend-item"><span class="dot" style="background:${item.color}"></span><span class="home-legend-label">${item.label}</span><strong class="${item.cls}">${safeNumber(item.count)}</strong><span class="home-legend-percent">${formatPercent(percentOf(item.count, distributionTotal))}</span></div>`).join('')}
    </div>
    ${showTotalLine ? `<div class="distribution-total-line">Lệnh đóng: <strong>${distributionTotal}</strong></div>` : ''}`;
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
  const recentResults = recentResultsForHome();
  document.getElementById('recentResults').innerHTML = recentResults.length
    ? `<div class="recent-results-table">
        <div class="recent-results-head"><span>Cặp / Thời gian</span><span>Hướng</span><span>Trạng thái</span><span>R</span></div>
        ${recentResults.map(r => {
      const status = getTradeOutcomeStatus(r);
      const rValue = getTradeResultR(r);
      return `<div class="recent-result-row">
        ${renderPairTimeCell(r, { iconStyle: 'width:28px;height:28px;font-size:14px;margin-right:8px' })}
        <span><span class="badge ${clsDir(r.direction)}">${safe(r.direction)}</span></span>
        <strong><span class="badge ${statusClass(status)}">${status}</span></strong>
        <strong class="${safeNumber(rValue) < 0 ? 'num-red' : 'num-green'}">${rValue === null ? '--' : renderRValue(rValue)}</strong>
      </div>`;
    }).join('')}
      </div>`
    : '<div class="empty-state">Chưa có kết quả gần đây</div>';
}

function recentResultsForHome() {
  const existing = dedupeClosedTradeRows(dashboardData.recent_results);
  if (existing.length) return sortNewestRows(existing).slice(0, 5);

  return dedupeClosedTradeRows(getFilteredTradeJournal())
    .sort((a, b) => (rowTimestamp(b) ?? -Infinity) - (rowTimestamp(a) ?? -Infinity))
    .slice(0, 5)
    .map(row => ({
      symbol: row.symbol,
      direction: row.direction,
      result: normalizeResult(row) || compactResultLabel(row.result),
      r: readTradeR(row),
      time: row.time,
      entry: row.entry,
      timeframe: row.timeframe,
      opened_at: row.opened_at,
      exit_price: closePriceValue(row),
      close_price: closePriceValue(row)
    }));
}

function renderShortLogs() {
  const target = document.getElementById('shortLogs');
  if (!target) return;
  const logs = shortLogsForHome();
  target.innerHTML = logs.length
    ? logs.map(logRow).join('')
    : '<div class="empty-state">Chưa có nhật ký bot</div>';
}

function journalLogMessage(row = {}) {
  const symbol = safe(row.symbol);
  const direction = safe(row.direction);

  if (isClosedTrade(row)) {
    return `${symbol} ${direction} - ${formatResultDisplay(row, { includePrice: true, includeR: true, action: true })}`;
  }

  if (isPendingHistoryRow(row)) return `${symbol} ${direction} - Chờ xác nhận`;
  if (isJournalRunning(row)) return `${symbol} ${direction} - Đang chạy`;
  return `${symbol} ${direction} - ${safe(row.status, 'Đang chạy')}`;
}

function shortLogsForHome() {
  const existing = dedupeGenericClosedLogs(dashboardData.activity_logs);
  if (existing.length) return existing.slice(0, 5);

  return dedupeTradeRows(getFilteredTradeJournal())
    .slice(0, 5)
    .map(row => ({
      time: formatHHmm(row.time, row),
      type: isClosedTrade(row) ? 'RESULT' : 'SIGNAL',
      message: journalLogMessage(row)
    }));
}

function field(label, value, cls = '') {
  return `<div><div class="field-label">${label}</div><div class="field-value ${cls}">${safe(value)}</div></div>`;
}

function tradeRow(t, changed = false) {
  const status = getTradeOutcomeStatus(t);
  return `<tr class="${changed ? 'row-enter' : ''}"><td><strong>${renderSymbolWithIcon(t.symbol)}</strong></td><td class="${clsDir(t.direction)}"><strong>${safe(t.direction)}</strong></td><td>${formatMaybePrice(t.entry)}</td><td>${formatMaybePrice(t.tp1)}</td><td>${formatMaybePrice(t.tp2)}</td><td class="num-red">${formatMaybePrice(t.sl)}</td><td><span class="badge ${statusClass(status)}">${status}</span></td></tr>`;
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
    miniKpi(`Tổng ${getRangeLabel().toLowerCase()}`, safeNumber(s.total_signals)), miniKpi('Đang active', safeNumber(s.active_signals)), miniKpi('Chờ xác nhận', safeNumber(s.pending_signals)), miniKpi('Đã đóng', safeNumber(s.closed_signals))
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
    const status = getTradeOutcomeStatus(sig);
    const closed = isClosedTrade(sig) && status !== 'Đang chạy' && status !== 'Chờ xác nhận';
    const statusOK = activeSignalFilter === 'all' || (activeSignalFilter === 'closed' ? closed : status === activeSignalFilter);
    return statusOK && (pair === 'all' || sig.symbol === pair) && (tf === 'all' || sig.timeframe === tf) && (dir === 'all' || sig.direction === dir);
  });
}

function renderSignalTable() {
  document.querySelector('.signal-table thead').innerHTML = '<tr><th>Cặp / Thời gian</th><th>Hướng</th><th>Khung</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>Trạng thái</th><th>Kết quả</th></tr>';
  const hasPublicSignals = arr(dashboardData.signals).length > 0;
  const rows = hasPublicSignals ? getFilteredSignals() : [];
  if (selectedSignalIndex >= rows.length) selectedSignalIndex = 0;
  if (!rows.length) {
    document.getElementById('signalsBody').innerHTML = '<tr><td colspan="9" class="empty-state">Chưa có tín hiệu</td></tr>';
    document.getElementById('signalCountText').textContent = 'Hiển thị 0 tín hiệu';
    return;
  }

  document.getElementById('signalsBody').innerHTML = rows.map((sig, idx) => {
    const status = getTradeOutcomeStatus(sig);
    return `<tr data-signal-index="${idx}">
      <td>${renderPairTimeCell(sig)}</td>
      <td class="${clsDir(sig.direction)}"><strong>${safe(sig.direction, 'LONG')}</strong></td>
      <td>${safe(sig.timeframe)}</td><td>${formatMaybePrice(sig.entry)}</td><td class="num-red">${formatMaybePrice(sig.sl)}</td><td class="num-green">${formatMaybePrice(sig.tp1)}</td><td class="num-green">${formatMaybePrice(sig.tp2)}</td>
      <td><span class="badge ${statusClass(status)}">${status}</span></td>
      <td><strong class="signal-result-r">${renderTradeResultR(sig)}</strong></td>
    </tr>`;
  }).join('');
  document.getElementById('signalCountText').textContent = `Hiển thị 1 - ${rows.length} của ${signalList().length} tín hiệu`;
}

function statusClass(status) {
  const text = safeStatus(status).toUpperCase();
  if (text.includes('SL')) return 'short';
  if (text.includes('TP2') || text.includes('ĐANG CHẠY') || text.includes('DANG CHAY')) return 'green';
  if (text.includes('TP1')) return 'info';
  if (text.includes('CHỜ') || text.includes('CHO') || text.includes('PENDING') || text.includes('THOÁT') || text.includes('THOAT')) return 'wait';
  if (text.includes('HÒA VỐN') || text.includes('HOA VON')) return 'neutral';
  if (text.includes('ĐÓNG TAY') || text.includes('DONG TAY') || text.includes('ĐÃ ĐÓNG') || text.includes('DA DONG')) return 'info';
  return 'info';
}

function renderPerformance() {
  ensurePerformanceLayout();
  const s = dashboardData.summary || {};
  const rangeLabel = getRangeLabel();
  document.getElementById('performanceKpis').innerHTML = [
    kpiCard('🏆', 'Win rate', `${safeNumber(s.win_rate)}%`, rangeLabel, false, 'summary.win_rate'),
    kpiCard('$', 'Tổng lợi nhuận', renderRValue(s.total_r), rangeLabel, false, 'summary.total_r'),
    kpiCard('📡', 'Tổng tín hiệu', safeNumber(s.total_signals), rangeLabel, false, 'summary.total_signals'),
    kpiCard('↘', 'Drawdown tối đa', renderRValue(s.max_drawdown_r), rangeLabel, true)
  ].join('');
  renderLineChart();
  renderPerformanceOverviewStats();
  renderRangeResultAxisCard(buildRangeResultBuckets(rangeResultTrades(), selectedTimeRange), selectedTimeRange);
  renderPerformanceDistribution();
  const pairPerformance = arr(dashboardData.pair_performance);
  document.getElementById('pairPerfBody').innerHTML = pairPerformance.length
    ? pairPerformance.map(p => `<tr><td><strong>${renderSymbolWithIcon(p.symbol, 'width:28px;height:28px;font-size:14px;margin-right:8px')}</strong></td><td>${safeNumber(p.trades)}</td><td class="num-green">${safeNumber(p.win_rate)}%</td><td class="${safeNumber(p.r) < 0 ? 'num-red' : 'num-green'}">${renderRValue(p.r)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty-state">Chưa có hiệu suất theo cặp</td></tr>';
  const best = pairPerformance.slice().sort((a, b) => safeNumber(b.r) - safeNumber(a.r))[0] || {};
  document.getElementById('insights').innerHTML = `<div class="panel-title">🎯 Insights nhanh</div>
    ${insight('🏆', 'Cặp tốt nhất', renderSymbol(safe(best.symbol, 'ETHUSDT')), 'Tổng R', renderRValue(best.r))}
    ${insight('🕘', 'Khung hiệu quả', 'M5', 'Win rate', '61.3%')}
    ${insight('↗', 'Chuỗi thắng dài nhất', '5', 'Tín hiệu', '(17/04 – 21/04)')}`;
}

function ensurePerformanceLayout() {
  const lineChart = document.getElementById('lineChart');
  const resultBars = document.getElementById('weeklyBars');
  const chartLayout = lineChart?.closest('.chart-layout') || resultBars?.closest('.chart-layout');
  const linePanel = lineChart?.closest('.panel');
  const resultPanel = resultBars?.closest('.panel');
  const lineTitle = lineChart?.closest('.panel')?.querySelector('.panel-title');
  if (lineTitle) lineTitle.textContent = `↗ ${getPerformanceTitle()}`;
  const weeklyTitle = resultBars?.closest('.panel')?.querySelector('.panel-title');
  if (weeklyTitle) {
    weeklyTitle.textContent = `▮ ${getRangeResultTitle()}`;
    weeklyTitle.classList.add('range-result-external-title');
  }
  const lineLegend = linePanel?.querySelector('.legend');
  if (lineLegend) {
    lineLegend.innerHTML = '<span class="dot green"></span> Lợi nhuận cộng dồn (R) <span class="dash"></span> Mốc 0R';
  }
  const distributionTitle = document.getElementById('distribution')?.closest('.panel')?.querySelector('.panel-title');
  if (distributionTitle) distributionTitle.textContent = '◔ Phân bổ kết quả cuối';
  lineChart?.classList.add('performance-overview-chart');
  linePanel?.classList.add('performance-overview-panel', 'performance-chart-card');
  resultPanel?.classList.add('range-result-card');
  chartLayout?.classList.add('performance-main-grid');
  chartLayout?.classList.toggle('performance-wide-layout', selectedTimeRange !== '1D');
  chartLayout?.classList.toggle('performance-range-1d', selectedTimeRange === '1D');
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
    homeMetric('Tổng PnL', renderRValue(s.total_r), safeNumber(s.total_r) < 0 ? 'num-red' : 'num-green'),
    homeMetric('Win rate', `${safeNumber(s.win_rate)}%`, 'num-green'),
    homeMetric('Số lệnh', safeNumber(s.total_signals), 'num-cyan')
  ].join('');
}

function insight(icon, label, value, rightLabel, rightValue) {
  return `<div class="insight-row"><div class="kpi-icon" style="width:44px;height:44px;font-size:20px">${icon}</div><div><small>${label}</small><br><strong style="font-size:23px">${safe(value)}</strong></div><div style="text-align:right"><small>${rightLabel}</small><br><strong class="num-green" style="font-size:22px">${safe(rightValue)}</strong></div></div>`;
}

function getNiceLineStep(value) {
  const raw = Math.abs(Number(value));
  if (!Number.isFinite(raw) || raw <= 0) return 0.5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  const steps = [0.5, 1, 2, 5, 10];
  const step = steps.find(item => normalized <= item) || 10;
  return step * magnitude;
}

function buildLineChartAxis(values = []) {
  const nums = arr(values).map(safeNumber).filter(Number.isFinite);
  let minValue = Math.min(0, ...nums);
  let maxValue = Math.max(0, ...nums);
  if (minValue === maxValue) {
    minValue -= 0.5;
    maxValue += 0.5;
  }
  const span = Math.max(0.5, maxValue - minValue);
  const paddedMin = minValue - span * 0.15;
  const paddedMax = maxValue + span * 0.15;
  let step = getNiceLineStep((paddedMax - paddedMin) / 4);
  let min = Math.floor(paddedMin / step) * step;
  let max = Math.ceil(paddedMax / step) * step;

  if ((max - min) / step > 8) {
    step = getNiceLineStep((max - min) / 5);
    min = Math.floor(paddedMin / step) * step;
    max = Math.ceil(paddedMax / step) * step;
  }

  const ticks = [];
  const limit = 16;
  for (let value = min, index = 0; value <= max + step / 2 && index < limit; value += step, index += 1) {
    ticks.push(roundR(value));
  }

  return { min: roundR(min), max: roundR(max), ticks };
}

function formatLineAxisTick(value) {
  const number = safeNumber(value);
  return `${Number.isInteger(number) ? number : number.toFixed(1)}R`;
}

function getPerformanceTone(value) {
  const number = safeNumber(value);
  if (number > 0) return 'positive';
  if (number < 0) return 'negative';
  return 'neutral';
}

function renderPerformanceLineSegment(a, b, tone) {
  if (!a || !b) return '';
  if (a.x === b.x && a.y === b.y) return '';
  return `<line class="performance-line-segment ${tone}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
}

function renderPerformanceLineSegments(points, yZero) {
  return arr(points).slice(1).map((point, index) => {
    const previous = points[index];
    const a = { x: previous.x, y: previous.y, r: safeNumber(previous.r) };
    const b = { x: point.x, y: point.y, r: safeNumber(point.r) };

    if (a.r === 0 && b.r === 0) {
      return renderPerformanceLineSegment(a, b, 'neutral');
    }

    if (a.r === 0 || b.r === 0 || Math.sign(a.r) === Math.sign(b.r)) {
      return renderPerformanceLineSegment(a, b, getPerformanceTone((a.r + b.r) / 2));
    }

    const ratio = (0 - a.r) / (b.r - a.r);
    const zeroPoint = {
      x: a.x + (b.x - a.x) * ratio,
      y: yZero,
      r: 0
    };

    return [
      renderPerformanceLineSegment(a, zeroPoint, getPerformanceTone(a.r)),
      renderPerformanceLineSegment(zeroPoint, b, getPerformanceTone(b.r))
    ].join('');
  }).join('');
}

function renderLineChart(targetId = 'lineChart') {
  const target = document.getElementById(targetId);
  if (!target) return;
  const data = performanceSeriesForChart();
  if (!data.length) {
    target.innerHTML = '<div class="empty-state">Chưa có dữ liệu hiệu suất</div>';
    return;
  }

  // v3: keep every visual element inside the SVG viewBox so the chart
  // never escapes the card/div on real browser sizes.
  const rect = target.getBoundingClientRect();
  const panelRect = target.closest('.panel')?.getBoundingClientRect();
  const measuredWidth = rect.width || target.clientWidth || (panelRect?.width ? panelRect.width - 32 : 0) || 900;
  const measuredHeight = rect.height || target.clientHeight || 320;
  const w = Math.max(720, Math.round(measuredWidth));
  const h = Math.max(220, Math.round(measuredHeight));
  const padL = 54, padR = 92, padT = 26, padB = 44;
  const ys = data.map(d => safeNumber(d.r));
  const axis = buildLineChartAxis(ys);
  const min = axis.min;
  const max = axis.max;
  const x = i => padL + (i / Math.max(1, data.length - 1)) * (w - padL - padR);
  const y = v => h - padB - ((v - min) / Math.max(1, max - min)) * (h - padT - padB);

  const pts = data.map((d, i) => `${x(i)},${y(safeNumber(d.r))}`).join(' ');
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`;
  const chartPoints = data.map((d, i) => ({
    x: x(i),
    y: y(safeNumber(d.r)),
    r: safeNumber(d.r)
  }));
  const lineSegments = renderPerformanceLineSegments(chartPoints, y(0));
  const grid = axis.ticks
    .map(v => `<line class="chart-grid" x1="${padL}" x2="${w - padR + 14}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="8" y="${y(v) + 4}">${renderSvgRText(formatLineAxisTick(v))}</text>`)
    .join('');
  const labelIndexes = new Set([0, 3, 6, 9, 12, data.length - 1]);
  const labels = data
    .map((d, i) => labelIndexes.has(i) ? `<text class="axis-label" x="${Math.max(padL - 10, x(i) - 18)}" y="${h - 10}">${performancePointLabel(d)}</text>` : '')
    .join('');
  const markers = chartPoints
    .map((point) => `<circle class="performance-dot ${getPerformanceTone(point.r)}" cx="${point.x}" cy="${point.y}" r="${data.length === 1 ? 5 : 3.5}"/>`)
    .join('');

  const last = data[data.length - 1];
  const bx = Math.min(w - padR + 10, x(data.length - 1) - 6);
  const by = Math.max(8, y(safeNumber(last.r)) - 28);
  const lastR = safeNumber(last.r);
  const isNegative = lastR < 0;
  const isPositive = lastR > 0;
  const finalTone = getPerformanceTone(lastR);
  const areaClass = finalTone;
  const tagFill = isNegative ? 'rgba(255,77,79,.18)' : isPositive ? 'rgba(103,240,92,.18)' : 'rgba(180,195,200,.14)';
  const tagStroke = isNegative ? 'rgba(255,77,79,.8)' : isPositive ? 'rgba(103,240,92,.8)' : 'rgba(180,195,200,.55)';

  target.innerHTML = `<svg class="performance-svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">${grid}<polygon class="performance-area ${areaClass}" points="${area}"/>${lineSegments}${markers}<line class="chart-grid" stroke-dasharray="5 5" x1="${padL}" x2="${w - padR + 14}" y1="${y(0)}" y2="${y(0)}"/>${labels}<rect x="${bx}" y="${by}" width="70" height="26" rx="9" fill="${tagFill}" stroke="${tagStroke}"/><text class="performance-label ${finalTone}" x="${bx + 8}" y="${by + 18}" font-size="15" font-weight="800">${renderSvgRValue(last.r)}</text></svg>`;
}

function performancePointLabel(point = {}) {
  if (point.label) return safe(point.label);
  if (selectedTimeRange === '1D') return formatHHmm(firstValue(point.time, point.created_at, point.date), point);
  return formatDateVN(firstValue(point.date, point.time, point.created_at));
}

function getRangeResultTitle(range = selectedTimeRange) {
  return {
    '1D': 'Kết quả hôm nay',
    '7D': 'Kết quả 7 ngày',
    '30D': 'Kết quả 30 ngày',
    '90D': 'Kết quả 90 ngày',
    ALL: 'Kết quả toàn thời gian'
  }[range] || 'Kết quả theo mốc thời gian';
}

function getTradeCloseTime(trade) {
  return trade.closed_at
    || trade.closed_at_iso
    || trade.time
    || trade.created_at_iso
    || trade.opened_at
    || trade.opened_at_iso
    || trade.created_at
    || null;
}

function getTradeR(trade) {
  const value = Number(trade.r);
  if (Number.isFinite(value)) return value;
  const parsed = readTradeR(trade);
  return parsed !== null ? parsed : 0;
}

function rangeResultTrades() {
  return resultRowsForStats(dashboardData?.trade_journal, dashboardData?.recent_results)
    .filter(trade => parseDashboardTime(getTradeCloseTime(trade), trade) !== null);
}

function emptyRangeBucket(key, label, start, end, tooltipLabel = label) {
  return {
    key,
    label,
    tooltipLabel,
    start,
    end,
    r: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    tp1: 0,
    tp2: 0,
    sl: 0
  };
}

function buildTimeBucketsForRange(range, now = new Date(), trades = []) {
  const todayStart = getVietnamStartOfDay(now);
  const buckets = [];

  if (range === '1D') {
    const start = todayStart;
    const end = now;
    return [emptyRangeBucket('today', 'Hôm nay', start, end, formatDateVN(start))];
  }

  if (range === '7D' || range === '30D') {
    const days = range === '7D' ? 7 : 30;
    const firstDay = addVietnamDays(todayStart, -(days - 1));
    for (let index = 0; index < days; index += 1) {
      const start = addVietnamDays(firstDay, index);
      const nextDay = addVietnamDays(start, 1);
      const end = index === days - 1 ? now : nextDay;
      const label = range === '30D' ? formatDayMonthVN(start) : formatDateVN(start);
      buckets.push(emptyRangeBucket(formatDateKeyVN(start), label, start, end, formatDateVN(start)));
    }
    return buckets;
  }

  if (range === '90D') {
    const firstDay = addVietnamDays(todayStart, -89);
    for (let index = 0; index < 13; index += 1) {
      const start = addVietnamDays(firstDay, index * 7);
      if (start > now) break;
      const end = index === 12 ? now : new Date(Math.min(addVietnamDays(start, 7).getTime(), now.getTime()));
      const from = formatDayMonthVN(start);
      const to = index === 12 ? formatDayMonthVN(end) : formatDayMonthVN(addVietnamDays(end, -1));
      const weekOffset = 12 - index;
      const label = weekOffset === 0 ? 'Tuần này' : `Tuần -${weekOffset}`;
      buckets.push(emptyRangeBucket(`week-${index}`, label, start, end, `${from} - ${to}`));
    }
    return buckets;
  }

  const tradeTimes = arr(trades)
    .map(trade => parseDashboardTime(getTradeCloseTime(trade), trade))
    .filter(time => time !== null)
    .map(time => new Date(time));
  const startMonth = tradeTimes.length
    ? getVietnamStartOfMonth(new Date(Math.min(...tradeTimes.map(date => date.getTime()))))
    : getVietnamStartOfMonth(now);
  const lastMonth = tradeTimes.length
    ? getVietnamStartOfMonth(new Date(Math.max(...tradeTimes.map(date => date.getTime()))))
    : getVietnamStartOfMonth(now);
  const currentMonth = getVietnamStartOfMonth(now);
  const endMonth = lastMonth > currentMonth ? lastMonth : currentMonth;

  let cursor = startMonth;
  let guard = 0;
  while (cursor <= endMonth && guard < 240) {
    const start = cursor;
    const next = addVietnamMonths(start, 1);
    const end = next > now && formatMonthYearVN(start) === formatMonthYearVN(currentMonth) ? now : next;
    buckets.push(emptyRangeBucket(formatMonthYearVN(start), formatMonthYearVN(start), start, end, formatMonthYearVN(start)));
    cursor = next;
    guard += 1;
  }
  return buckets;
}

function addTradeToRangeBucket(bucket, trade) {
  const r = getTradeR(trade);
  const outcome = normalizeDistributionOutcome(trade.result || trade.status || trade.label);
  bucket.r += r;
  bucket.trades += 1;
  if (outcome === 'TP1') bucket.tp1 += 1;
  if (outcome === 'TP2') bucket.tp2 += 1;
  if (outcome === 'SL') bucket.sl += 1;
  if (outcome === 'TP1' || outcome === 'TP2' || r > 0) bucket.wins += 1;
  if (outcome === 'SL' || r < 0) bucket.losses += 1;
}

function buildRangeResultBuckets(trades, range = selectedTimeRange) {
  const sourceTrades = arr(trades);
  const buckets = buildTimeBucketsForRange(range, getVietnamNow(), sourceTrades);
  sourceTrades.forEach(trade => {
    const time = parseDashboardTime(getTradeCloseTime(trade), trade);
    if (time === null) return;
    const bucket = buckets.find(item => time >= item.start.getTime() && time < item.end.getTime());
    if (bucket) addTradeToRangeBucket(bucket, trade);
  });
  return buckets.map(bucket => ({ ...bucket, r: roundR(bucket.r) }));
}

function rangeBucketTooltip(bucket) {
  return [
    bucket.tooltipLabel || bucket.label,
    `Tổng R: ${fmtR(bucket.r)}`,
    `Số lệnh: ${safeNumber(bucket.trades)}`,
    `TP1: ${safeNumber(bucket.tp1)}`,
    `TP2: ${safeNumber(bucket.tp2)}`,
    `SL: ${safeNumber(bucket.sl)}`,
    `Win: ${safeNumber(bucket.wins)}`,
    `Loss: ${safeNumber(bucket.losses)}`
  ].join('\n');
}

function getNiceAxisMax(maxAbsR) {
  const value = Number(maxAbsR);
  if (!Number.isFinite(value) || value <= 0) return 1;

  const padded = value * 1.12;
  const magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
  const normalized = padded / magnitude;
  const niceSteps = [0.5, 1, 1.5, 2, 3, 5, 10];
  const step = niceSteps.find(item => normalized <= item) || 10;
  return Math.max(0.5, roundR(step * magnitude));
}

function buildYAxisTicks(axisMax) {
  const max = Number(axisMax);
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  let divisions = 4;
  if (max <= 0.5) divisions = 1;
  else if (max <= 1.5) divisions = Math.round(max / 0.5);
  else if (max <= 2) divisions = 4;
  else if (max === 3) divisions = 3;
  else if (max <= 5) divisions = 5;
  return Array.from({ length: divisions + 1 }, (_, index) => roundR((max / divisions) * index));
}

function formatAxisTickR(value, axisMax) {
  const number = safeNumber(value);
  if (number === 0) return '0R';
  if (axisMax <= 2) return `${number.toFixed(1)}R`;
  return `${Number.isInteger(number) ? number : number.toFixed(1)}R`;
}

function shouldShowRangeXAxisLabel(index, total, range) {
  if (total <= 13) return true;
  if (range === '30D') return index % 3 === 0 || index === total - 1;
  const interval = Math.max(1, Math.ceil(total / 12));
  return index % interval === 0 || index === total - 1;
}

function renderRangeResultAxisChart(buckets, range = selectedTimeRange) {
  const rows = arr(buckets);
  const maxAbs = Math.max(0, ...rows.map(bucket => Math.abs(safeNumber(bucket.r))));
  const axisMax = getNiceAxisMax(maxAbs);
  const ticks = buildYAxisTicks(axisMax);
  const margin = { top: 34, right: 26, bottom: range === '30D' ? 78 : 68, left: 74 };
  const height = 360;
  const slotWidth = range === '30D' ? 42 : range === '90D' ? 70 : range === '1D' ? 190 : 86;
  const baseWidth = range === '1D' ? 420 : 780;
  const width = Math.max(baseWidth, rows.length * slotWidth + margin.left + margin.right);
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const bottomY = margin.top + plotHeight;
  const slot = plotWidth / Math.max(1, rows.length);
  const barWidth = Math.min(range === '30D' ? 18 : 34, Math.max(8, slot * 0.42));
  const xAxisLabelY = height - 10;
  const yAxisLabelX = 16;
  const yAxisLabelY = margin.top + plotHeight / 2;

  const grid = ticks.map(tick => {
    const y = bottomY - (safeNumber(tick) / axisMax) * plotHeight;
    return `<g class="range-axis-tick">
      <line class="range-axis-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>
      <text class="range-axis-y-text" x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${renderSvgRText(formatAxisTickR(tick, axisMax))}</text>
    </g>`;
  }).join('');

  const bars = rows.map((bucket, index) => {
    const value = safeNumber(bucket.r);
    const absValue = Math.abs(value);
    const isPositive = value > 0;
    const isNegative = value < 0;
    const barHeight = value === 0 ? 3 : Math.max(6, (absValue / axisMax) * plotHeight);
    const x = margin.left + index * slot + (slot - barWidth) / 2;
    const y = bottomY - barHeight;
    const labelY = Math.max(16, y - 8);
    const centerX = x + barWidth / 2;
    const xLabel = shouldShowRangeXAxisLabel(index, rows.length, range)
      ? `<text class="range-axis-x-text" x="${centerX}" y="${bottomY + 24}" text-anchor="middle">${escapeHtml(bucket.label || '--')}</text>`
      : '';
    const valueLabel = value !== 0
      ? `<text class="range-axis-value ${isNegative ? 'negative' : 'positive'}" x="${centerX}" y="${labelY}" text-anchor="middle">${renderSvgRValue(value)}</text>`
      : '';
    return `<g class="range-axis-bar-group" role="img" aria-label="${escapeHtml(rangeBucketTooltip(bucket))}">
      ${valueLabel}
      <rect class="range-axis-bar ${isPositive ? 'positive' : isNegative ? 'negative' : 'zero'}" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="5"></rect>
      ${xLabel}
    </g>`;
  }).join('');

  return `<div class="range-axis-scroll">
    <svg class="range-result-axis-chart" viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="img" aria-label="${escapeHtml(getRangeResultTitle(range))}">
      ${grid}
      <line class="range-axis-line" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${bottomY}"></line>
      <line class="range-axis-line" x1="${margin.left}" y1="${bottomY}" x2="${width - margin.right}" y2="${bottomY}"></line>
      <text class="range-axis-title y" x="${yAxisLabelX}" y="${yAxisLabelY}" transform="rotate(-90 ${yAxisLabelX} ${yAxisLabelY})">Độ lớn R</text>
      <text class="range-axis-title x" x="${margin.left + plotWidth / 2}" y="${xAxisLabelY}" text-anchor="middle">Thời gian</text>
      ${bars}
    </svg>
  </div>`;
}

function ensureAxisRangeRenderProbe() {
  if (document.getElementById('axisRangeRenderProbe')) return;
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div id="axisRangeRenderProbe" class="axis-range-render-probe">Độ lớn R Thời gian</div>'
  );
}

function renderRangeResultAxisCard(buckets, range = selectedTimeRange) {
  const target = document.getElementById('weeklyBars');
  if (!target) return;
  ensureAxisRangeRenderProbe();
  target.classList.add('range-result-bars', 'range-result-axis-rendered');

  const totalR = roundR(buckets.reduce((sum, bucket) => sum + safeNumber(bucket.r), 0));
  const totalTrades = buckets.reduce((sum, bucket) => sum + safeNumber(bucket.trades), 0);
  const best = buckets.reduce((winner, bucket) => safeNumber(bucket.r) > safeNumber(winner.r) ? bucket : winner, buckets[0] || { label: '--', r: 0 });
  const worst = buckets.reduce((loser, bucket) => safeNumber(bucket.r) < safeNumber(loser.r) ? bucket : loser, buckets[0] || { label: '--', r: 0 });
  const compact = buckets.length > 13 ? ' compact' : '';
  const single = buckets.length === 1 ? ' single' : '';
  const rangeClass = ` range-${safeStatus(range).toLowerCase() || 'all'}`;

  target.innerHTML = `
    <div class="range-result-chart${compact}${single}${rangeClass}" data-renderer="axis-range-bars-v2">
      <div class="debug-axis-chart-version" style="display:none">AXIS_RANGE_BARS_V2_0459e51</div>
      <div class="range-result-header">
        <div class="range-result-title">${escapeHtml(getRangeResultTitle(range))}</div>
        <div class="range-result-subtitle">Biểu đồ cột theo mốc thời gian</div>
      </div>
      <div class="range-axis-dom-labels" aria-hidden="true"><span>Độ lớn R</span><span>Thời gian</span></div>
      <div class="range-result-plot">${renderRangeResultAxisChart(buckets, range)}</div>
      <div class="range-bars-summary">
        <div><span>Tổng R</span><strong class="${totalR < 0 ? 'num-red' : totalR > 0 ? 'num-green' : ''}">${renderRValue(totalR)}</strong></div>
        <div><span>Số lệnh</span><strong>${safeNumber(totalTrades)}</strong></div>
        <div><span>Tốt nhất</span><strong class="${safeNumber(best.r) > 0 ? 'num-green' : ''}">${escapeHtml(best.label || '--')} · ${renderRValue(best.r)}</strong></div>
        <div><span>Xấu nhất</span><strong class="${safeNumber(worst.r) < 0 ? 'num-red' : ''}">${escapeHtml(worst.label || '--')} · ${renderRValue(worst.r)}</strong></div>
      </div>
    </div>`;
}

function renderDistribution(targetId = 'distribution') {
  const target = document.getElementById(targetId);
  if (!target) return;
  const total = arr(dashboardData.result_distribution).reduce((sum, item) => sum + safeNumber(item.count), 0);
  target.innerHTML = `<div class="donut"><div class="donut-inner"><strong>${total}</strong><br><span>Lệnh đóng</span></div></div><div class="legend-list">${arr(dashboardData.result_distribution).map((x, i) => `<div><span class="dot" style="background:${['var(--green)', 'var(--cyan)', 'var(--red)', 'var(--yellow)'][i]}"></span> ${safe(x.label)} <strong style="float:right">${safeNumber(x.count)} (${safeNumber(x.percent)}%)</strong></div>`).join('')}<small>Lệnh đóng: ${total}</small></div>`;
}

function renderLogs() {
  ensureTradeJournalLayout();
  renderTradeJournal();
  hideLogSystemSummary();
}

function eventCard(icon, label, value, red = false) { return `<div class="event-card"><span class="kpi-icon" style="width:40px;height:40px;font-size:18px">${icon}</span><span>${label}</span><strong class="${red ? 'num-red' : 'num-green'}" style="font-size:24px">${safeNumber(value)}</strong></div>`; }

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
  const result = firstValue(row.result, row.outcome, row.pnl_result, journalResultFromStatus(status), fallback.result);
  const closed = isClosedTrade({ ...row, status, result });
  const time = closed
    ? firstValue(row.closed_at_iso, row.closed_at, row.exit_at, row.exited_at, row.closed_time, row.time_iso, row.timestamp, row.updated_at, row.time, row.date, row.display_time, row.created_at_iso, row.opened_at_iso, row.created_at, fallback.time)
    : firstValue(row.created_at_iso, row.opened_at_iso, row.time_iso, row.timestamp, row.updated_at, row.created_at, row.time, row.date, row.display_time, fallback.time);
  return {
    time,
    signal_id: firstValue(row.signal_id, fallback.signal_id),
    trade_id: firstValue(row.trade_id, fallback.trade_id),
    order_id: firstValue(row.order_id, fallback.order_id),
    entry_order_id: firstValue(row.entry_order_id, fallback.entry_order_id),
    exchange_order_id: firstValue(row.exchange_order_id, fallback.exchange_order_id),
    id: firstValue(row.id, fallback.id),
    symbol: firstValue(row.symbol, fallback.symbol),
    direction: safeStatus(firstValue(row.direction, fallback.direction)).toUpperCase(),
    timeframe: firstValue(row.timeframe, row.tf, row.frame, fallback.timeframe),
    entry: firstValue(row.entry, fallback.entry),
    sl: firstValue(row.sl, row.stop_loss, fallback.sl),
    tp1: firstValue(row.tp1, fallback.tp1),
    tp2: firstValue(row.tp2, fallback.tp2),
    position_value: firstValue(row.position_value, row.positionValue, row.order_value, row.value, fallback.position_value),
    status,
    result,
    r: firstValue(row.r, row.rr, row.r_multiple, row.result_r, row.pnl_r, fallback.r),
    opened_at: firstValue(row.opened_at, row.opened_at_iso, fallback.opened_at),
    closed_at: firstValue(row.closed_at, row.closed_at_iso, row.exit_at, row.exited_at, fallback.closed_at),
    exit_price: firstValue(row.exit_price, row.close_price, row.fill_price, row.avg_close_price, fallback.exit_price),
    close_price: firstValue(row.close_price, row.exit_price, row.fill_price, row.avg_close_price, fallback.close_price),
    result_text: firstValue(row.result_text, fallback.result_text),
    rr_text: firstValue(row.rr_text, row.risk_reward, fallback.rr_text)
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
  return dedupeTradeRows(journal.map(row => normalizeJournalRow(row)));
}

function rowTimestamp(row = {}) {
  return getItemTimestamp(row);
}

function sortNewestRows(rows) {
  return arr(rows).slice().sort((a, b) => (rowTimestamp(b) ?? -Infinity) - (rowTimestamp(a) ?? -Infinity));
}

function sortOldestRows(rows) {
  return arr(rows).slice().sort((a, b) => (rowTimestamp(a) ?? Infinity) - (rowTimestamp(b) ?? Infinity));
}

function getFilteredTradeJournal() {
  return sortNewestRows(dedupeTradeRows(arr(dashboardData?.trade_journal)
    .map(row => normalizeJournalRow(row))
    .filter(row => isWithinSelectedRange(row))));
}

function formatHHmm(value, item = {}) {
  const time = parseDashboardTime(value, item);
  if (time !== null) {
    const parts = getVietnamDateParts(new Date(time));
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  }

  const match = safeStatus(value).match(/\b(\d{1,2}):(\d{2})/);
  return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : '--';
}

function formatDateKeyVN(value, item = {}) {
  const time = parseDashboardTime(value, item);
  if (time === null) return '';
  const parts = getVietnamDateParts(new Date(time));
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatDayMonthVN(value) {
  const time = parseDashboardTime(value);
  if (time === null) return '--';
  const parts = getVietnamDateParts(new Date(time));
  return `${String(parts.day).padStart(2, '0')}/${String(parts.month).padStart(2, '0')}`;
}

function formatMonthYearVN(value) {
  const time = parseDashboardTime(value);
  if (time === null) return '--';
  const parts = getVietnamDateParts(new Date(time));
  return `${String(parts.month).padStart(2, '0')}/${String(parts.year % 100).padStart(2, '0')}`;
}

function roundR(value) {
  return Number(safeNumber(value).toFixed(2));
}

function resultCountsForRows(rows) {
  const counts = { SL: 0, TP1: 0, TP2: 0, 'Thoát sớm': 0 };
  arr(rows).forEach(row => {
    const result = normalizeResult(row);
    if (counts[result] !== undefined) counts[result] += 1;
  });
  return counts;
}

function closedJournalRowsWithR() {
  return sortOldestRows(getFilteredTradeJournal())
    .filter(row => isClosedTrade(row) && readTradeR(row) !== null);
}

function derivePerformanceSeriesFromTradeJournal() {
  const rows = closedJournalRowsWithR();
  if (!rows.length) return [];

  let cumulative = 0;
  if (selectedTimeRange === '1D') {
    return rows.map(row => {
      const value = readTradeR(row);
      cumulative += value;
      return {
        time: row.time,
        label: formatHHmm(row.time, row),
        r: roundR(cumulative),
        symbol: row.symbol,
        result: normalizeResult(row)
      };
    });
  }

  const groups = new Map();
  rows.forEach(row => {
    const key = formatDateKeyVN(row.time, row);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, { date: key, time: row.time, rows: [], r: 0 });
    const group = groups.get(key);
    group.rows.push(row);
    group.r += readTradeR(row);
  });

  return Array.from(groups.values())
    .sort((a, b) => (parseDashboardTime(a.date) ?? 0) - (parseDashboardTime(b.date) ?? 0))
    .map(group => {
      cumulative += group.r;
      return {
        date: group.date,
        time: group.time,
        label: formatDateVN(group.date),
        r: roundR(cumulative),
        period_r: roundR(group.r)
      };
    });
}

function performanceSeriesForChart() {
  const buckets = buildRangeResultBuckets(rangeResultTrades(), selectedTimeRange);
  const summaryTotalR = roundR(dashboardData?.summary?.total_r);
  let cumulative = 0;
  const series = buckets.map(bucket => {
    cumulative = roundR(cumulative + safeNumber(bucket.r));
    return {
      date: bucket.key,
      time: bucket.end,
      label: bucket.label,
      r: cumulative,
      period_r: bucket.r,
      trades: bucket.trades
    };
  });

  if (series.length) series[series.length - 1].r = summaryTotalR;
  return series.length ? series : derivePerformanceSeriesFromTradeJournal();
}

function matchesTradeJournalFilter(row) {
  const result = normalizeResult(row);
  const direction = safeStatus(row.direction).toUpperCase();

  if (activeTradeJournalFilter === 'running') return isJournalRunning(row);
  if (activeTradeJournalFilter === 'closed') return isJournalClosed(row);
  if (activeTradeJournalFilter === 'long') return direction === 'LONG';
  if (activeTradeJournalFilter === 'short') return direction === 'SHORT';
  if (activeTradeJournalFilter === 'sl') return result === 'SL';
  if (activeTradeJournalFilter === 'tp1') return result === 'TP1';
  if (activeTradeJournalFilter === 'tp2') return result === 'TP2';
  return true;
}

function formatTradeNumber(value) {
  return formatMaybePrice(value);
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
  if (upper.includes('TP2')) return 'TP2';
  if (upper.includes('TP1')) return 'TP1';
  if (/\bTP\b/.test(upper)) return 'TP';
  if (/\bSL\b/.test(upper) || upper.includes('STOP LOSS')) return 'SL';
  if (upper.includes('BREAK_EVEN') || upper.includes('BREAK EVEN') || upper.includes('HÒA VỐN') || upper.includes('HOA VON') || /\bBE\b/.test(upper)) return 'Hòa vốn';
  if (upper.includes('MANUAL_CLOSE') || upper.includes('CLOSED_MANUAL') || upper.includes('ĐÓNG TAY') || upper.includes('DONG TAY')) return 'Đóng tay';
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
  return renderTradeResultR(row);
}

function isJournalRunning(row) {
  return getTradeOutcomeStatus(row) === 'Đang chạy';
}

function isJournalClosed(row) {
  const status = getTradeOutcomeStatus(row);
  return isClosedTrade(row) && status !== 'Đang chạy' && status !== 'Chờ xác nhận';
}

function journalResultText(row) {
  return safeStatus(normalizeResult(row) || row.result).toUpperCase();
}

function statCard(label, value, cls = '', tone = 'neutral') {
  const resolvedTone = ['neutral', 'cyan', 'green', 'red'].includes(tone) ? tone : 'neutral';
  return `<div class="journal-stat-card journal-stat-${resolvedTone}"><span class="journal-stat-label">${label}</span><strong class="${cls}">${safe(value)}</strong></div>`;
}

function renderJournalQuickStats(rows) {
  const target = document.getElementById('journalQuickStats');
  if (!target) return;
  const totalR = rows.reduce((sum, row) => sum + safeNumber(row.r), 0);
  const totalTone = totalR < 0 ? 'red' : totalR > 0 ? 'green' : 'neutral';
  target.innerHTML = [
    statCard('Tổng lệnh', rows.length, '', 'neutral'),
    statCard('Đang chạy', rows.filter(isJournalRunning).length, 'num-cyan', 'cyan'),
    statCard('Đã đóng', rows.filter(isJournalClosed).length, 'num-green', 'green'),
    statCard('Thoát sớm', rows.filter(row => /THOÁT SỚM|EARLY/.test(journalResultText(row))).length, 'num-cyan', 'cyan'),
    statCard('SL', rows.filter(row => /\bSL\b|STOP LOSS/.test(journalResultText(row))).length, 'num-red', 'red'),
    statCard('TP1', rows.filter(row => /\bTP1\b/.test(journalResultText(row))).length, 'num-cyan', 'cyan'),
    statCard('TP2', rows.filter(row => /\bTP2\b/.test(journalResultText(row))).length, 'num-green', 'green'),
    statCard('R:R', renderRText(formatJournalR(totalR) || '0R'), totalR < 0 ? 'num-red' : totalR > 0 ? 'num-green' : '', totalTone)
  ].join('');
}

function getDailyProfitTimestamp(row = {}) {
  return parseDashboardTime(
    firstValue(
      row.closed_at,
      row.closed_at_iso,
      row.time,
      row.opened_at,
      row.opened_at_iso,
      row.created_at_iso,
      row.created_at
    ),
    row
  );
}

function dailyProfitTone(value) {
  const number = safeNumber(value);
  if (number > 0) return 'positive';
  if (number < 0) return 'negative';
  return 'neutral';
}

function dailyProfitRows(rows = []) {
  const groups = new Map();
  arr(rows).forEach(row => {
    const r = readTradeR(row);
    if (r === null || !isClosedTrade(row)) return;
    const timestamp = getDailyProfitTimestamp(row);
    if (timestamp === null) return;
    const key = formatDateKeyVN(timestamp, row);
    if (!key) return;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        time: createVietnamDate(...key.split('-').map(Number)).getTime(),
        label: formatDateVN(timestamp),
        r: 0
      });
    }
    groups.get(key).r += r;
  });

  return Array.from(groups.values())
    .map(item => ({ ...item, r: roundR(item.r) }))
    .sort((a, b) => b.time - a.time);
}

function renderDailyProfitCards(rows = []) {
  const target = document.getElementById('dailyProfitGrid');
  if (!target) return;
  const days = dailyProfitRows(rows);
  if (selectedDailyProfitDayKey && !days.some(day => day.key === selectedDailyProfitDayKey)) {
    selectedDailyProfitDayKey = null;
    shouldScrollToSelectedDay = false;
  }
  target.innerHTML = days.length
    ? days.map(day => {
      const active = selectedDailyProfitDayKey === day.key ? ' active' : '';
      return `<div class="daily-profit-card ${dailyProfitTone(day.r)}${active}" data-day-key="${escapeHtml(day.key)}" role="button" tabindex="0" aria-pressed="${selectedDailyProfitDayKey === day.key ? 'true' : 'false'}">
      <div class="daily-profit-date">${escapeHtml(day.label)}</div>
      <div class="daily-profit-r">${renderRValue(day.r, { onSolid: true })}</div>
    </div>`;
    }).join('')
    : '<div class="daily-profit-empty">Chưa có dữ liệu lãi/lỗ theo ngày</div>';
}

function handleDailyProfitCardSelect(card) {
  const dayKey = card?.dataset?.dayKey;
  if (!dayKey) return;
  selectedDailyProfitDayKey = selectedDailyProfitDayKey === dayKey ? null : dayKey;
  shouldScrollToSelectedDay = Boolean(selectedDailyProfitDayKey);
  renderTradeJournal();
}

function renderTradeJournal() {
  const target = document.getElementById('tradeJournalBody');
  if (!target) return;

  document.querySelectorAll('.journal-pill').forEach(button => {
    button.classList.toggle('active', button.dataset.journal === activeTradeJournalFilter);
  });

  const allRows = tradeJournalRows();
  const rows = allRows.filter(matchesTradeJournalFilter);
  renderJournalQuickStats(rows);
  renderDailyProfitCards(allRows);
  target.innerHTML = rows.length
    ? rows.map(row => {
      const direction = safe(row.direction);
      const directionClass = direction === 'LONG' ? 'long' : direction === 'SHORT' ? 'short' : 'info';
      const result = formatJournalResult(row);
      const status = getTradeOutcomeStatus(row);
      const dayKey = formatDateKeyVN(getDailyProfitTimestamp(row), row);
      const highlightClass = dayKey && selectedDailyProfitDayKey === dayKey ? ' class="journal-day-highlight"' : '';
      const dayAttr = dayKey ? ` data-trade-day="${escapeHtml(dayKey)}"` : '';
      return `<tr${dayAttr}${highlightClass}>
        <td>${renderPairTimeCell(row)}</td>
        <td><span class="badge ${directionClass}">${direction}</span></td>
        <td>${safe(row.timeframe)}</td>
        <td>${formatTradeNumber(row.entry)}</td>
        <td class="num-red">${formatTradeNumber(row.sl)}</td>
        <td class="num-cyan">${formatTradeNumber(row.tp1)}</td>
        <td class="num-green">${formatTradeNumber(row.tp2)}</td>
        <td>${formatPositionValue(row.position_value)}</td>
        <td><span class="badge ${statusClass(status)}">${status}</span></td>
        <td><strong class="${journalResultClass(result)}">${result}</strong></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="10" class="empty-state">Chưa có nhật ký giao dịch.</td></tr>';

  if (shouldScrollToSelectedDay) {
    const firstHighlighted = document.querySelector('.journal-day-highlight');
    firstHighlighted?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    shouldScrollToSelectedDay = false;
  }
}

function renderSystemSummary() {
  const sys = dashboardData.system || {};
  document.getElementById('systemSummary').innerHTML = `<div class="panel-title">〽 Tóm tắt trạng thái</div>
    ${systemRow('Risk lock hôm nay', sys.risk_lock ? 'Bật' : 'Tắt', sys.risk_lock)}
    ${systemRow('Trạng thái dữ liệu', sys.data_status, false)}${systemRow('Lỗi gần nhất', sys.last_error, false)}${systemRow('Quét M5 cuối', sys.last_m5_scan, false, 'num-cyan')}${systemRow('Vị thế active', activePositionsCount(), false)}`;
}
function systemRow(label, value, danger = false, cls = 'num-green') { return `<div class="system-row"><span>${label}</span><strong class="${danger ? 'num-red' : cls}">${safe(value)}</strong></div>`; }

function activePositionsCount() {
  if (Array.isArray(dashboardData?.active_trades)) return dashboardData.active_trades.length;
  return safeNumber(dashboardData?.system?.active_positions);
}

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
  return formatDateTimeVN(value);
}

function getLogTimestamp(log = {}) {
  return (
    log.time ||
    log.created_at ||
    log.created_at_iso ||
    log.closed_at ||
    log.opened_at ||
    log.updated_at ||
    log.timestamp ||
    log.time_iso ||
    null
  );
}

function isValidDateTimeParts(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function formatSystemLogTime(log = {}) {
  const value = getLogTimestamp(log);
  if (value === undefined || value === null || value === '') return '--';

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value < 1e9) return '--';
    const time = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(time) && time > 0 ? formatDateTimeVN(time) : '--';
  }

  const raw = safeStatus(value).trim();
  if (!raw || raw === '-' || raw === '--') return '--';

  const timeOnly = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    return '--';
  }

  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const hour = Number(dmy[4] || 0);
    const minute = Number(dmy[5] || 0);
    const second = Number(dmy[6] || 0);
    if (!isValidDateTimeParts(year, month, day, hour, minute, second)) return '--';
    const time = createVietnamDate(year, month, day, hour, minute, second).getTime();
    if (!Number.isFinite(time)) return '--';
    const formatted = formatDateTimeVN(time);
    return dmy[4] ? formatted : formatted.split(' ')[0];
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (ymd) {
    const hasTime = Boolean(ymd[4]);
    const hasTimezone = Boolean(ymd[7]);
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    const hour = Number(ymd[4] || 0);
    const minute = Number(ymd[5] || 0);
    const second = Number(ymd[6] || 0);
    if (!isValidDateTimeParts(year, month, day, hour, minute, second)) return '--';
    const time = raw.includes('T') && hasTimezone
      ? Date.parse(raw)
      : createVietnamDate(
        year,
        month,
        day,
        hour,
        minute,
        second
      ).getTime();
    if (!Number.isFinite(time) || Number.isNaN(time)) return '--';
    const formatted = formatDateTimeVN(time);
    return hasTime ? formatted : formatted.split(' ')[0];
  }

  return '--';
}

function systemLogMatchKey(log = {}) {
  const message = safeStatus(log.message || log.event || log.text).trim();
  const type = safeStatus(log.type).trim();
  return message ? `${type}::${message}` : '';
}

function buildActivityLogTimestampBuckets(logs = []) {
  const buckets = new Map();
  arr(logs).forEach(log => {
    if (formatSystemLogTime(log) === '--') return;
    const key = systemLogMatchKey(log);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(log);
  });
  return buckets;
}

function enrichSystemLogTimestamp(log = {}, activityBuckets = new Map()) {
  if (formatSystemLogTime(log) !== '--') return log;
  const key = systemLogMatchKey(log);
  const bucket = key ? activityBuckets.get(key) : null;
  const source = bucket?.shift();
  if (!source) return log;
  return {
    ...log,
    time: getLogTimestamp(source),
    created_at: source.created_at,
    created_at_iso: source.created_at_iso,
    closed_at: source.closed_at,
    opened_at: source.opened_at,
    updated_at: source.updated_at,
    timestamp: source.timestamp,
    time_iso: source.time_iso
  };
}

function systemRecentLogRows(sys = {}) {
  const systemLogs = arr(sys.recent_system_logs);
  const activityLogs = arr(dashboardData.activity_logs);
  if (!systemLogs.length) return activityLogs;

  const activityBuckets = buildActivityLogTimestampBuckets(activityLogs);
  return systemLogs.map(log => enrichSystemLogTimestamp(log, activityBuckets));
}

function formatActivityLogTime(log = {}) {
  const formatted = formatItemDateTimeVN(log);
  if (formatted !== '--') return formatted;
  return safeStatus(log.time).slice(0, 5) || '--';
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
  const activePositions = activePositionsCount();

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
    systemListRow('Active positions', activePositions),
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

  const recentLogs = dedupeGenericClosedLogs(systemRecentLogRows(sys));
  document.getElementById('recentSystemLogs').innerHTML = recentLogs.length
    ? recentLogs.slice(0, 8).map(log => `<div class="system-log-row"><span class="timeline-time">${formatSystemLogTime(log)}</span><span>${highlightMessage(log.message || log.event || log.text)}</span></div>`).join('')
    : '<div class="empty-state">Chưa có nhật ký hệ thống.</div>';
}

function renderActivityLogs() {
  const search = (document.getElementById('logSearch')?.value || '').toLowerCase();
  const logs = dedupeGenericClosedLogs(dashboardData.activity_logs)
    .filter(l => (activeLogFilter === 'all' || l.type === activeLogFilter) && safeStatus(l.message).toLowerCase().includes(search));
  document.getElementById('activityLogs').innerHTML = logs.length
    ? logs.map(log => `<div class="timeline-row"><span class="timeline-time">${formatActivityLogTime(log)}</span><span class="log-type ${typeClass(log.type)}">${publicLogType(log.type)}</span><span>${highlightMessage(log.message)}</span></div>`).join('')
    : '<div class="empty-state">Chưa có nhật ký</div>';
}

function logRow(log) {
  return `<div class="timeline-row"><span class="timeline-time">${formatActivityLogTime(log)}</span><span class="timeline-dot ${dotClass(log.type)}"></span><span>${highlightMessage(log.message)}</span></div>`;
}
function dotClass(type) { return type === 'Cảnh báo' ? 'yellow' : type === 'Thoát lệnh' ? 'red' : type === 'Vào lệnh' ? 'green' : ''; }
function typeClass(type) { return type === 'Cảnh báo' ? 'num-red' : type === 'Thoát lệnh' ? 'num-red' : type === 'Vào lệnh' ? 'num-green' : type === 'Tín hiệu' ? 'num-cyan' : 'num-cyan'; }
function highlightMessage(message) {
  return renderTextWithRUnits(sanitizePublicText(message))
    .replace(/\b([A-Z0-9]{2,20}USDT)\b/g, symbol => renderSymbol(symbol))
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
      if (button.dataset.tab === 'performance') {
        requestAnimationFrame(() => renderLineChart());
      }
    }
  }));

  document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.filter').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    activeSignalFilter = button.dataset.filter;
    selectedSignalIndex = 0;
    renderSignalTable();
  }));
  ['pairFilter', 'tfFilter', 'dirFilter'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { selectedSignalIndex = 0; renderSignalTable(); }));
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
  document.getElementById('dailyProfitGrid')?.addEventListener('click', event => {
    const card = event.target.closest('.daily-profit-card[data-day-key]');
    if (card) handleDailyProfitCardSelect(card);
  });
  document.getElementById('dailyProfitGrid')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.daily-profit-card[data-day-key]');
    if (!card) return;
    event.preventDefault();
    handleDailyProfitCardSelect(card);
  });
  document.querySelectorAll('.range-filter-button').forEach(button => {
    button.addEventListener('click', () => handleTimeRangeChange(button.dataset.range));
  });
  window.addEventListener('resize', () => {
    if (document.getElementById('tab-performance')?.classList.contains('active')) {
      renderLineChart();
    }
  });
  window.addEventListener('scroll', updateHeaderScrollState, { passive: true });
  updateHeaderScrollState();
}

function renderAll() {
  ensureSystemTab();
  ensureTradeJournalLayout();
  ensureHeaderRangeFilter();
  bindEvents();
  renderHeader();
  renderHome();
  renderSignals();
  renderPerformance();
  renderLogs();
  renderSystemTab();
}

ensureFavicon();
loadData()
  .then(() => {
    startRealtimeUpdates();
  })
  .catch(error => {
    console.error('[dashboard] Initial load failed', error);
  });
setInterval(() => {
  if (dashboardData) renderHeader();
}, 30000);
