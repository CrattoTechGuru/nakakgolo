'use strict';

/* NakaKgolo: seed and recovery session tracker.
   Everything runs in the browser. Session state is saved to localStorage after every round. */

const STORAGE_KEY = 'nakakgolo.session.v1';
const ACCOUNT_KEY = 'nakakgolo.account.v1';
const UNLOCK_KEY = 'nakakgolo.unlocked';          // sessionStorage: stays unlocked for this tab only
const PBKDF2_ITERATIONS = 310000;
const MIN_PASSWORD_LENGTH = 6;
const MAX_TABLE_ROWS = 300;
const CHART_MAX_POINTS = 800;
const SIM_ROUNDS_PER_FRAME = 400;
const MAX_SIM_ROUNDS = 50000;
const SETTING_IDS = ['p-capital', 'p-stake', 'p-rate', 'p-dp', 'p-threshold',
  'sl-win', 'sl-loss', 'sl-gap', 'sl-rectrig', 'sl-recwin', 'sim-rounds'];

/* ---------- Small helpers ---------- */
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = n => Math.round(n * 100) / 100;
const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = n => (n >= 0 ? '+' : '') + fmt(n);
const fmtStake = n => (Number.isFinite(n) ? n.toFixed(2) : '—');
const toHex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => Uint8Array.from(hex.match(/../g) || [], h => parseInt(h, 16));
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isFloating = () => document.body.classList.contains('is-floating');

function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}
function setText(id, text, color) {
  const el = $(id);
  el.textContent = text;
  if (color !== undefined) el.style.color = color;
}
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/* ---------- State ---------- */
function freshState(capital) {
  return {
    phase: 'seed', round: 0, tl: 0, gaps: 0,
    balance: capital, startCap: capital, peakBal: capital,
    maxTL: 0, maxDD: 0,
    recWins: 0, recAttempts: 0,
    seedWins: 0, totalWins: 0, totalLosses: 0, totalGaps: 0, consecLosses: 0,
    history: [], balData: [], profitData: [], tlData: [], recStakeData: [],
    mode: 'manual', simRunning: false,
  };
}
const S = freshState(1000);

function P() {
  return {
    capital: num('p-capital', 1000),
    stake: num('p-stake', 2),
    rate: num('p-rate', 0.9),
    dp: Math.max(0, num('p-dp', 0.1)),
    threshold: Math.max(0, num('p-threshold', 50)),
  };
}
function recStake() {
  const p = P();
  if (!(p.rate > 0)) return Infinity;
  return Math.max(0, (S.tl + p.dp * S.gaps) / p.rate);
}
function totalProfit() {
  return S.balance - S.startCap;
}

/* ---------- Persistence ---------- */
function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22);
}
function setStorageNote(text) {
  $('storage-note').textContent = text;
}
function buildSnapshot(keepRows) {
  const keep = arr => (keepRows ? arr.slice(-keepRows) : arr);
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    state: {
      ...S, simRunning: false,
      history: keep(S.history), balData: keep(S.balData),
      profitData: keep(S.profitData), tlData: keep(S.tlData),
    },
    settings: Object.fromEntries(SETTING_IDS.map(id => [id, $(id).value])),
  };
}
function saveState() {
  for (const keepRows of [null, 5000, 2000, 500]) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSnapshot(keepRows)));
      setStorageNote(keepRows
        ? `Device storage is nearly full, so only the latest ${keepRows} rounds are kept. Export your CSV to keep everything.`
        : 'Your session is saved on this device after every round.');
      return true;
    } catch (err) {
      if (!isQuotaError(err)) { console.warn('Could not save session:', err); break; }
    }
  }
  setStorageNote('Could not save the session on this device. Export your CSV now.');
  flashAlert('Could not save the session. Export your CSV now.');
  return false;
}
function restoreState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.state || !Array.isArray(saved.state.history)) return false;

    Object.assign(S, freshState(1000), saved.state, { simRunning: false });
    S.balance = Number.isFinite(Number(S.balance)) ? Number(S.balance) : 1000;
    S.startCap = Number(S.startCap) > 0 ? Number(S.startCap) : 1000;
    S.round = Math.max(0, Number(S.round) || 0);
    S.tl = Math.max(0, Number(S.tl) || 0);
    S.gaps = Math.max(0, Number(S.gaps) || 0);
    if (!['seed', 'recovery'].includes(S.phase)) S.phase = 'seed';
    if (!['manual', 'sim', 'hybrid'].includes(S.mode)) S.mode = 'manual';

    if (saved.settings) {
      for (const id of SETTING_IDS) {
        if (saved.settings[id] !== undefined && $(id)) $(id).value = saved.settings[id];
      }
    }
    return true;
  } catch (err) {
    console.warn('Saved session could not be restored:', err);
    return false;
  }
}

/* ---------- Login (local lock, PBKDF2-hashed password) ---------- */
let loginMode = 'login';

function readAccount() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
    return a && a.username && a.salt && a.hash ? a : null;
  } catch (err) {
    return null;
  }
}
async function deriveHash(password, saltBytes, iterations) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error('Secure login needs HTTPS or localhost. Open NakaKgolo from a secure address.');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return toHex(bits);
}
function renderLoginMode() {
  const account = readAccount();
  loginMode = account ? 'login' : 'setup';
  $('login-user').value = account ? account.username : '';
  $('login-pass').value = '';
  $('login-pass2').value = '';
  $('login-pass').setAttribute('autocomplete', loginMode === 'setup' ? 'new-password' : 'current-password');
  $('confirm-group').classList.toggle('hidden', loginMode === 'login');
  $('login-submit').textContent = loginMode === 'setup' ? 'Create login' : 'Login';
  $('login-reset').classList.toggle('hidden', loginMode === 'setup');
  $('login-msg').textContent = loginMode === 'setup'
    ? `Create a login for this device (at least ${MIN_PASSWORD_LENGTH} characters). It locks the app when you open it. It does not encrypt your data.`
    : 'Enter your login to continue.';
  $('login-error').textContent = '';
}
async function onLoginSubmit(event) {
  event.preventDefault();
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  const errEl = $('login-error');
  const submit = $('login-submit');
  errEl.textContent = '';
  submit.disabled = true;
  try {
    if (username.length < 2) throw new Error('Username must be at least 2 characters.');
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

    if (loginMode === 'setup') {
      if (password !== $('login-pass2').value) throw new Error('Passwords do not match.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify({
        username, salt: toHex(salt), hash, iterations: PBKDF2_ITERATIONS, createdAt: new Date().toISOString(),
      }));
    } else {
      const account = readAccount();
      if (!account) {
        renderLoginMode();
        throw new Error('No login found. Create one below.');
      }
      const hash = await deriveHash(password, fromHex(account.salt), account.iterations || PBKDF2_ITERATIONS);
      if (username !== account.username || hash !== account.hash) throw new Error('Wrong username or password.');
    }
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    if (loginMode === 'login') $('login-pass').value = '';
  } finally {
    submit.disabled = false;
  }
}
function showApp() {
  sessionStorage.setItem(UNLOCK_KEY, '1');
  $('login-overlay').classList.add('hidden');
  $('app-container').classList.remove('hidden');
  updateUI();
  updateCharts();
}
function lockUI() {
  $('app-container').classList.add('hidden');
  $('login-overlay').classList.remove('hidden');
  if (isFloating()) toggleFloatingMode(false);
}
function handleLogout() {
  sessionStorage.removeItem(UNLOCK_KEY);
  lockUI();
  renderLoginMode();
}
function resetLogin() {
  if (!confirm('Reset the login on this device? You will create a new username and password. Your session data is kept.')) return;
  localStorage.removeItem(ACCOUNT_KEY);
  handleLogout();
  $('login-msg').textContent = 'Login reset. Create a new one below.';
}

/* ---------- Navigation & mobile menu ---------- */
function switchPage(pageId) {
  document.querySelectorAll('.app-page').forEach(p => p.classList.toggle('active', p.id === 'page-' + pageId));
  document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === pageId));
  $('nav-links-container').classList.remove('open');
  if (pageId === 'dashboard') updateCharts();
}
function toggleMobileMenu() {
  $('nav-links-container').classList.toggle('open');
}

/* ---------- Alerts ---------- */
let flashTimer = null;
let flashText = '';
let flashKind = 'warn';
let persistentAlerts = [];

function flashAlert(msg, kind = 'warn') {
  flashText = msg;
  flashKind = kind;
  renderAlertBar();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = ''; renderAlertBar(); }, 3500);
}
function renderAlertBar() {
  const bar = $('alert-bar');
  const text = flashText || persistentAlerts.join('  |  ');
  bar.classList.toggle('info', !!flashText && flashKind === 'info');
  if (text) {
    $('alert-text').textContent = flashText ? text : '⚠️ ' + text;
    bar.classList.add('active');
  } else {
    bar.classList.remove('active');
  }
}
function checkAlerts(p) {
  const a = [];
  if (S.tl > 0 && S.tl >= p.threshold) a.push(`TL (${S.tl.toFixed(2)}) exceeds threshold (${p.threshold})`);
  if (S.consecLosses >= 5) a.push(`${S.consecLosses} consecutive losses!`);
  const rs = recStake();
  if (S.tl > 0 && rs > S.balance) a.push(`Recovery stake (${fmtStake(rs)}) exceeds balance!`);
  if (Number.isFinite(rs) && rs > p.stake * 25) a.push(`Recovery stake extremely high: ${rs.toFixed(2)}`);
  if (S.balance < S.startCap * 0.2) a.push('Balance critically low!');
  persistentAlerts = a;
  renderAlertBar();
}

/* ---------- Table ---------- */
function makeRow(row) {
  const cls = { loss: 'row-loss', gap: 'row-gap', win: 'row-win', rwon: 'row-rwon', rloss: 'row-rloss' }[row.action] || '';
  const lbl = { loss: '❌ Loss', gap: '⭕ Gap', win: '✅ Win', rwon: '🏆 Rec. Win', rloss: '💀 Rec. Loss' }[row.action] || row.action;
  const pStr = row.profit === 0 ? '—' : (row.profit > 0 ? '+' : '') + row.profit.toFixed(2);
  const pC = row.profit > 0 ? 'var(--green)' : row.profit < 0 ? 'var(--red)' : 'var(--text3)';
  const tpC = row.tp >= 0 ? 'var(--green)' : 'var(--red)';
  const bC = row.balance >= S.startCap ? 'var(--green)' : 'var(--red)';
  const tr = document.createElement('tr');
  tr.className = cls;
  tr.innerHTML = `<td>${row.round}</td><td>${row.phase}</td><td>${lbl}</td>
    <td>${row.stake > 0 ? row.stake.toFixed(2) : '—'}</td>
    <td style="color:${pC}">${pStr}</td>
    <td style="color:${bC};font-weight:600">${fmt(row.balance)}</td>
    <td style="color:var(--red)">${row.tl.toFixed(2)}</td>
    <td style="color:${tpC};font-weight:600">${(row.tp >= 0 ? '+' : '') + row.tp.toFixed(2)}</td>`;
  return tr;
}
function refreshTableInfo() {
  const info = $('table-info');
  if (S.history.length > MAX_TABLE_ROWS) {
    info.textContent = `Showing last ${MAX_TABLE_ROWS} of ${S.history.length} rounds`;
    info.classList.add('visible');
  } else {
    info.classList.remove('visible');
  }
}
function scrollBottom() {
  const c = $('table-container');
  c.scrollTop = c.scrollHeight;
}
function renderRow(row) {
  const tbody = $('table-body');
  const nd = $('no-data');
  if (nd) nd.remove();
  tbody.appendChild(makeRow(row));
  while (tbody.children.length > MAX_TABLE_ROWS) tbody.removeChild(tbody.firstElementChild);
  refreshTableInfo();
  scrollBottom();
}
function rebuildTable() {
  const tbody = $('table-body');
  tbody.innerHTML = '';
  refreshTableInfo();
  if (!S.history.length) {
    tbody.innerHTML = '<tr id="no-data"><td colspan="8">No rounds yet — start by clicking Win, Loss, or Gap.</td></tr>';
    return;
  }
  const start = Math.max(0, S.history.length - MAX_TABLE_ROWS);
  const frag = document.createDocumentFragment();
  for (let i = start; i < S.history.length; i++) frag.appendChild(makeRow(S.history[i]));
  tbody.appendChild(frag);
  scrollBottom();
}

/* ---------- Core actions ---------- */
function enterRecovery() {
  if (S.phase !== 'seed') return;
  if (S.tl <= 0) { flashAlert('Nothing to recover — TL is 0.'); return; }
  const rs = recStake();
  if (!Number.isFinite(rs)) { flashAlert('Set a return rate above zero first.'); return; }
  S.phase = 'recovery';
  S.recAttempts++;
  S.recStakeData.push({ x: S.round + 1, y: round2(rs) });
  if (!S.simRunning) {
    updateUI();
    updateCharts();
    saveState();
  }
}

function doAction(action) {
  const p = P();
  if (S.mode === 'sim' && !S.simRunning) return;
  if (!(p.stake > 0) || !(p.rate > 0)) {
    flashAlert('Stake and return rate must both be greater than zero.');
    return;
  }
  const inSeed = S.phase === 'seed';
  if (inSeed && !['win', 'loss', 'gap'].includes(action)) return;
  if (!inSeed && !['rwon', 'rloss'].includes(action)) return;
  if (inSeed && action !== 'gap' && S.balance < p.stake) {
    flashAlert('Insufficient balance for the seed stake.');
    return;
  }
  if (!inSeed && recStake() > S.balance) {
    flashAlert('Recovery stake exceeds your available balance.');
    return;
  }

  let stake = 0, profit = 0;
  const phaseLabel = inSeed ? 'Seed' : 'Recovery';

  if (inSeed) {
    if (action === 'win') {
      stake = p.stake; profit = stake * p.rate;
      S.seedWins++; S.totalWins++; S.consecLosses = 0;
    } else if (action === 'loss') {
      stake = p.stake; profit = -stake;
      S.tl += stake; S.totalLosses++; S.consecLosses++;
    } else {
      S.gaps++; S.totalGaps++; S.consecLosses = 0;
    }
  } else {
    stake = recStake();
    S.phase = 'seed';
    if (action === 'rwon') {
      profit = stake * p.rate;
      S.tl = 0; S.gaps = 0;
      S.recWins++; S.totalWins++; S.consecLosses = 0;
    } else {
      profit = -stake;
      S.tl += stake; S.totalLosses++; S.consecLosses++;
    }
  }

  S.balance += profit;
  S.round++;
  S.peakBal = Math.max(S.peakBal, S.balance);
  S.maxDD = Math.max(S.maxDD, S.peakBal - S.balance);
  S.maxTL = Math.max(S.maxTL, S.tl);

  const tp = totalProfit();
  const row = { round: S.round, phase: phaseLabel, action, stake, profit, balance: S.balance, tl: S.tl, tp };
  S.history.push(row);
  S.balData.push({ x: S.round, y: round2(S.balance) });
  S.profitData.push({ x: S.round, y: round2(tp) });
  S.tlData.push({ x: S.round, y: round2(S.tl) });

  if (!S.simRunning) {
    renderRow(row);
    updateUI();
    checkAlerts(p);
    updateCharts();
    saveState();
  }
}

function resetSession() {
  if (S.simRunning) { flashAlert('Stop the simulation before resetting.'); return; }
  if (S.round > 0 && !confirm('Reset this session? All rounds will be cleared. Export your CSV first if you want to keep them.')) return;
  const cap = num('p-capital', 1000);
  if (cap < 10) { flashAlert('Starting capital must be at least 10.'); return; }
  Object.assign(S, freshState(cap), { mode: S.mode });
  rebuildTable();
  persistentAlerts = [];
  flashText = '';
  renderAlertBar();
  updateUI();
  updateCharts();
  saveState();
}

/* ---------- UI ---------- */
function updateUI() {
  const p = P();
  const isSeed = S.phase === 'seed';
  const rs = recStake();
  const tp = totalProfit();
  const manualOn = S.mode !== 'sim' && !S.simRunning;
  const seedOn = isSeed && manualOn;
  const recOn = !isSeed && manualOn;

  const phEl = $('top-phase');
  phEl.textContent = isSeed ? 'SEED' : 'RECOVERY';
  phEl.style.color = isSeed ? 'var(--blue)' : 'var(--purple)';
  $('top-balance').textContent = fmt(S.balance);
  $('balance-box').style.borderColor = S.balance >= S.startCap ? '#166534' : '#991b1b';
  setText('top-profit', signed(tp), tp >= 0 ? 'var(--green)' : 'var(--red)');
  $('profit-box').className = 'topstat ' + (tp >= 0 ? 'profit-box-pos' : 'profit-box-neg');
  setText('top-stake', fmtStake(isSeed ? p.stake : rs));
  setText('top-tl', S.tl.toFixed(2));
  setText('top-gaps', S.gaps);
  setText('top-round', S.round);

  $('recovery-banner').classList.toggle('active', !isSeed);
  if (!isSeed) {
    setText('rec-stake-big', fmtStake(rs));
    setText('rec-remind', fmtStake(rs));
    setText('rec-formula', `(TL ${S.tl.toFixed(2)} + DP ${(p.dp * S.gaps).toFixed(2)}) ÷ ${p.rate} = ${fmtStake(rs)}`);
  }
  $('rec-dot').style.display = isSeed ? 'none' : 'inline-block';
  $('rec-box').classList.toggle('active-glow', !isSeed);

  $('btn-win').disabled = !(seedOn && S.balance >= p.stake);
  $('btn-loss').disabled = !(seedOn && S.balance >= p.stake);
  $('btn-gap').disabled = !seedOn;
  $('btn-enter-rec').disabled = !(seedOn && S.tl > 0);
  $('btn-rwon').disabled = !recOn;
  $('btn-rloss').disabled = !recOn;

  $('bankrupt-overlay').classList.toggle('show', S.round > 0 && S.balance <= 0);

  const recSucc = S.recAttempts > 0 ? ((S.recWins / S.recAttempts) * 100).toFixed(1) + '%' : '—';
  const avg = S.round > 0 ? (tp / S.round).toFixed(4) : '0.00';
  const profitColor = tp >= 0 ? 'var(--green)' : 'var(--red)';
  const balColor = S.balance >= S.startCap ? 'var(--green)' : 'var(--red)';

  setText('s-rounds', S.round);
  setText('s-totalprofit', signed(tp), profitColor);
  setText('s-maxtl', S.maxTL.toFixed(2));
  setText('s-maxdd', S.maxDD.toFixed(2));
  setText('s-avg', avg);
  setText('s-recsucc', recSucc);
  setText('s-seedwins', S.seedWins);
  setText('s-recwins', S.recWins);

  setText('b-bal', fmt(S.balance), balColor);
  setText('b-profit', signed(tp), profitColor);
  setText('b-maxtl', S.maxTL.toFixed(2));
  setText('b-maxdd', S.maxDD.toFixed(2));
  setText('b-recsucc', recSucc);
  setText('b-rounds', S.round);
  setText('b-wins', S.totalWins);
  setText('b-losses', S.totalLosses);
  setText('b-consec', S.consecLosses);

  setText('an-gaps', S.totalGaps);
  setText('an-recattempts', S.recAttempts);
  setText('an-peak', fmt(S.peakBal));
}

function syncSliders() {
  for (const k of ['win', 'loss', 'gap', 'rectrig', 'recwin']) {
    $('sv-' + k).textContent = $('sl-' + k).value + '%';
  }
}

function setMode(mode, persist = true) {
  if (S.simRunning) return;
  S.mode = mode;
  for (const m of ['manual', 'sim', 'hybrid']) $('tab-' + m).classList.toggle('active', m === mode);
  $('manual-controls').style.display = mode === 'sim' ? 'none' : 'block';
  $('sim-config').classList.toggle('visible', mode !== 'manual');
  updateUI();
  if (persist) saveState();
}

/* ---------- Charts ---------- */
const charts = {};
function initCharts() {
  charts.balance = new MiniChart($('ch-balance'), { color: '#22c55e' });
  charts.profit = new MiniChart($('ch-profit'), { color: '#06b6d4', zeroLine: true });
  charts.tl = new MiniChart($('ch-tl'), { color: '#ef4444' });
  charts.recstake = new MiniChart($('ch-recstake'), { color: '#8b5cf6', points: true, fill: false });
}
function updateCharts() {
  if (!charts.balance) return;
  charts.balance.setData(downsample(S.balData, CHART_MAX_POINTS));
  charts.profit.setData(downsample(S.profitData, CHART_MAX_POINTS));
  charts.tl.setData(downsample(S.tlData, CHART_MAX_POINTS));
  charts.recstake.setData(S.recStakeData.filter(d => Number.isFinite(d.y)));
}

/* ---------- Simulation ---------- */
let simStopRequested = false;

function simOneRound(cfg) {
  const p = P();
  if (S.balance <= 0) return 'balance is depleted';
  if (S.phase === 'recovery') {
    if (recStake() > S.balance) return 'balance cannot cover the recovery stake';
    doAction(Math.random() * 100 < cfg.recWin ? 'rwon' : 'rloss');
    return true;
  }
  if (S.tl > 0 && Math.random() * 100 < cfg.recTrig) {
    const rs = recStake();
    if (Number.isFinite(rs) && rs <= S.balance) {
      enterRecovery();
      doAction(Math.random() * 100 < cfg.recWin ? 'rwon' : 'rloss');
      return true;
    }
  }
  const seedTotal = cfg.win + cfg.loss + cfg.gap;
  const roll = Math.random() * seedTotal;
  if (roll < cfg.win + cfg.loss && S.balance < p.stake) return 'balance is below the seed stake';
  if (roll < cfg.win) doAction('win');
  else if (roll < cfg.win + cfg.loss) doAction('loss');
  else doAction('gap');
  return true;
}

function setSimUI(running) {
  const btn = $('btn-run-sim');
  btn.textContent = running ? '■ Stop Simulation' : '▶ Run Simulation';
  btn.classList.toggle('btn-stop', running);
  btn.classList.toggle('btn-sim', !running);
  $('sim-prog').style.display = running ? 'block' : 'none';
  if (running) $('sim-prog-bar').style.width = '0%';
  for (const m of ['manual', 'sim', 'hybrid']) $('tab-' + m).disabled = running;
  updateUI();
}

function finishSimulation(message, kind = 'info') {
  S.simRunning = false;
  simStopRequested = false;
  setSimUI(false);
  rebuildTable();
  checkAlerts(P());
  updateCharts();
  saveState();
  flashAlert(message, kind);
}

function runSimulation() {
  if (S.simRunning) { simStopRequested = true; return; }
  const p = P();
  if (!(p.stake > 0) || !(p.rate > 0)) {
    flashAlert('Stake and return rate must both be greater than zero.');
    return;
  }
  const rounds = clamp(Math.floor(num('sim-rounds', 200)), 1, MAX_SIM_ROUNDS);
  const pct = id => clamp(Math.round(num(id, 0)), 0, 100);
  const cfg = {
    win: pct('sl-win'), loss: pct('sl-loss'), gap: pct('sl-gap'),
    recTrig: pct('sl-rectrig'), recWin: pct('sl-recwin'),
  };
  if (cfg.win + cfg.loss + cfg.gap <= 0) {
    flashAlert('Set at least one seed probability above 0%.');
    return;
  }

  S.simRunning = true;
  simStopRequested = false;
  setSimUI(true);

  let done = 0;
  const frame = () => {
    const end = Math.min(done + SIM_ROUNDS_PER_FRAME, rounds);
    let halted = '';
    while (done < end && !simStopRequested) {
      const result = simOneRound(cfg);
      if (result !== true) { halted = result; break; }
      done++;
    }
    $('sim-prog-bar').style.width = (done / rounds * 100) + '%';

    if (halted) finishSimulation(`Simulation halted after ${done} rounds: ${halted}.`, 'warn');
    else if (simStopRequested) finishSimulation(`Simulation stopped after ${done} rounds.`);
    else if (done >= rounds) finishSimulation(`Simulation complete: ${done} rounds.`);
    else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ---------- Parameter inputs ---------- */
function onParamChange(id) {
  if (S.simRunning) { flashAlert('Stop the simulation before changing settings.'); return; }
  if (id === 'p-capital' && S.round === 0) {
    const v = num('p-capital', 1000);
    if (v >= 10) { S.balance = v; S.startCap = v; S.peakBal = v; }
  }
  updateUI();
  updateCharts();
  saveState();
}

/* ---------- Export ---------- */
function exportCSV() {
  if (!S.history.length) { flashAlert('No rounds to export yet.'); return; }
  const header = ['Round', 'Phase', 'Action', 'Stake', 'P/L', 'Balance', 'TL', 'Total_Profit'];
  const lines = [header.join(',')].concat(S.history.map(r => [
    r.round, r.phase, r.action, r.stake.toFixed(2), r.profit.toFixed(2),
    r.balance.toFixed(2), r.tl.toFixed(2), r.tp.toFixed(2),
  ].join(',')));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `nakakgolo_session_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Floating window (in-app, movable and resizable) ---------- */
const floatBox = { x: 15, y: 15, w: 0, h: 0 };

function applyFloat() {
  const st = document.body.style;
  st.setProperty('--fx', floatBox.x + 'px');
  st.setProperty('--fy', floatBox.y + 'px');
  st.setProperty('--fw', floatBox.w + 'px');
  st.setProperty('--fh', floatBox.h + 'px');
}
function clampFloat() {
  if (!isFloating()) return;
  floatBox.w = clamp(floatBox.w, Math.min(320, innerWidth), innerWidth);
  floatBox.h = clamp(floatBox.h, Math.min(240, innerHeight), innerHeight);
  floatBox.x = clamp(floatBox.x, 0, Math.max(0, innerWidth - floatBox.w));
  floatBox.y = clamp(floatBox.y, 0, Math.max(0, innerHeight - floatBox.h));
  applyFloat();
}
function toggleFloatingMode(force) {
  // Inside the Android app, floating is a native window above other apps.
  if (window.NakaKgoloAndroid && !isFloating()) { NakaKgoloAndroid.startFloating(); return; }
  const on = typeof force === 'boolean' ? force : !isFloating();
  if (on && !floatBox.w) {
    floatBox.w = Math.min(900, innerWidth - 30);
    floatBox.h = Math.min(640, innerHeight - 30);
    floatBox.x = 15;
    floatBox.y = 15;
  }
  document.body.classList.toggle('is-floating', on);
  if (on) clampFloat();
  $('float-toggle-btn').textContent = on ? '🖥️ Exit Floating Window' : '📱 Enable Floating Window';
}
function bindFloating() {
  const bar = $('float-titlebar');
  const grip = $('float-grip');
  let drag = null;
  let resize = null;

  bar.addEventListener('pointerdown', e => {
    if (!isFloating() || e.target.closest('button')) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: floatBox.x, oy: floatBox.y };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    floatBox.x = drag.ox + e.clientX - drag.sx;
    floatBox.y = drag.oy + e.clientY - drag.sy;
    clampFloat();
  });
  const endDrag = () => { drag = null; };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  grip.addEventListener('pointerdown', e => {
    if (!isFloating()) return;
    resize = { sx: e.clientX, sy: e.clientY, ow: floatBox.w, oh: floatBox.h };
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', e => {
    if (!resize) return;
    floatBox.w = resize.ow + e.clientX - resize.sx;
    floatBox.h = resize.oh + e.clientY - resize.sy;
    clampFloat();
  });
  const endResize = () => { resize = null; };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);
}

/* ---------- Install & offline ---------- */
let deferredInstallPrompt = null;

function initInstall() {
  const status = $('install-status');
  const btn = $('install-btn');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isStandalone()) {
    status.textContent = 'You are using the installed app.';
    return;
  }
  if (ios) {
    status.textContent = 'On iPhone or iPad: tap the Share button in Safari, then "Add to Home Screen".';
    return;
  }
  status.textContent = 'Install NakaKgolo to open it like a native app from your home screen or app list.';
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.classList.remove('hidden');
    status.textContent = 'Install NakaKgolo to open it like a native app from your home screen or app list.';
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    btn.classList.add('hidden');
    status.textContent = 'Installed. Open NakaKgolo from your home screen or app list.';
  });
  setTimeout(() => {
    if (!deferredInstallPrompt && btn.classList.contains('hidden')) {
      status.textContent = "Use your browser's install option (address bar or menu) to add NakaKgolo to this device.";
    }
  }, 2000);
}
async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  if (choice.outcome === 'accepted') $('install-btn').classList.add('hidden');
}

function registerServiceWorker() {
  const note = $('offline-status');
  if (!('serviceWorker' in navigator)) {
    note.textContent = 'Offline mode is not supported in this browser.';
    return;
  }
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) location.reload();   // a new version took over; data is already saved
  });
  navigator.serviceWorker.register('sw.js')
    .then(() => { note.textContent = 'Offline ready: the app and its files are stored on this device.'; })
    .catch(() => { note.textContent = 'Offline mode needs HTTPS (or localhost). It is unavailable on this address.'; });
}

/* ---------- Event wiring ---------- */
function bindEvents() {
  $('login-card').addEventListener('submit', onLoginSubmit);
  $('login-reset').addEventListener('click', resetLogin);

  for (const id of ['p-capital', 'p-stake', 'p-rate', 'p-dp', 'p-threshold', 'sim-rounds']) {
    $(id).addEventListener('change', () => onParamChange(id));
  }
  for (const id of ['sl-win', 'sl-loss', 'sl-gap', 'sl-rectrig', 'sl-recwin']) {
    $(id).addEventListener('input', syncSliders);
    $(id).addEventListener('change', () => saveState());
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#navbar')) $('nav-links-container').classList.remove('open');
  });
  window.addEventListener('resize', () => { clampFloat(); updateCharts(); });
}

/* ---------- Init ---------- */
function init() {
  restoreState();
  setMode(S.mode, false);
  syncSliders();
  initCharts();
  rebuildTable();
  updateUI();
  bindEvents();
  bindFloating();
  renderLoginMode();
  initInstall();
  registerServiceWorker();

  if (readAccount() && sessionStorage.getItem(UNLOCK_KEY) === '1') showApp();
  else lockUI();
}
init();
