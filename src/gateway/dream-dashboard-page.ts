/**
 * Dream Engine Dashboard — self-contained HTML page served at GET /dreams.
 * Communicates with the gateway via WebSocket RPC.
 */

export function renderDreamDashboardPage(gatewayWsUrl: string, gatewayToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Dream Engine — Bitterbot</title>
<style>
:root {
  --bg: #0f0f1a; --card: #1a1a2e; --card-hover: #1f1f35;
  --border: #2a2a4a; --text: #e2e8f0; --muted: #94a3b8;
  --primary: #8b5cf6; --primary-dim: rgba(139,92,246,.15);
  --blue: #3b82f6; --purple: #8b5cf6; --green: #22c55e;
  --orange: #f97316; --pink: #ec4899; --indigo: #6366f1; --teal: #14b8a6;
  --red: #ef4444; --yellow: #eab308;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.header h1 { font-size: 1.5rem; display: flex; align-items: center; gap: 10px; }
.header h1 span { font-size: 1.8rem; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 8px; }
.conn-dot.ok { background: var(--green); } .conn-dot.err { background: var(--red); }
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 0; }
.tab { padding: 10px 18px; cursor: pointer; border: none; background: transparent; color: var(--muted); font-size: .9rem; border-bottom: 2px solid transparent; transition: all .2s; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--primary); border-bottom-color: var(--primary); }
.panel { display: none; } .panel.active { display: block; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 14px; }
.card:hover { border-color: var(--primary-dim); }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.stat-card .label { font-size: .8rem; color: var(--muted); margin-bottom: 4px; }
.stat-card .value { font-size: 1.8rem; font-weight: 700; }
.stat-card .sub { font-size: .75rem; color: var(--muted); margin-top: 2px; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: .75rem; font-weight: 600; }
.badge-replay { background: rgba(59,130,246,.15); color: var(--blue); }
.badge-mutation { background: rgba(139,92,246,.15); color: var(--purple); }
.badge-extrapolation { background: rgba(34,197,94,.15); color: var(--green); }
.badge-compression { background: rgba(249,115,22,.15); color: var(--orange); }
.badge-simulation { background: rgba(236,72,153,.15); color: var(--pink); }
.badge-exploration { background: rgba(99,102,241,.15); color: var(--indigo); }
.badge-research { background: rgba(20,184,166,.15); color: var(--teal); }
.badge-state { padding: 4px 14px; border-radius: 16px; font-size: .85rem; }
.badge-dreaming { background: rgba(139,92,246,.2); color: var(--primary); animation: pulse 2s infinite; }
.badge-dormant { background: rgba(148,163,184,.1); color: var(--muted); }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
.btn { padding: 8px 20px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: .85rem; transition: all .2s; }
.btn:hover { background: var(--card-hover); border-color: var(--primary); }
.btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn-primary:hover { opacity: .85; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 8px; }
.bar-chart .bar { flex: 1; min-width: 2px; background: var(--primary); border-radius: 3px 3px 0 0; transition: height .3s; position: relative; }
.bar-chart .bar:hover { opacity: .8; }
.mode-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.mode-bar .fill { height: 8px; border-radius: 4px; transition: width .5s; }
.mode-bar .name { font-size: .8rem; min-width: 100px; }
.mode-bar .pct { font-size: .75rem; color: var(--muted); min-width: 40px; text-align: right; }
.insight-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
.insight-item:last-child { border-bottom: none; }
.insight-item .meta { font-size: .75rem; color: var(--muted); margin-top: 4px; }
.cycle-card { cursor: pointer; transition: all .2s; }
.cycle-card .expand { max-height: 0; overflow: hidden; transition: max-height .3s ease; }
.cycle-card.open .expand { max-height: 600px; }
.cycle-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
.cycle-modes { display: flex; gap: 4px; flex-wrap: wrap; }
.cycle-stats { display: flex; gap: 16px; font-size: .8rem; color: var(--muted); margin-top: 8px; }
.hormone-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.hormone-bar .icon { font-size: 1.1rem; min-width: 24px; text-align: center; }
.hormone-bar .track { flex: 1; height: 8px; background: rgba(255,255,255,.06); border-radius: 4px; overflow: hidden; }
.hormone-bar .fill { height: 100%; border-radius: 4px; transition: width .5s; }
.hormone-bar .val { font-size: .85rem; min-width: 40px; text-align: right; }
.floating-bar { position: fixed; bottom: 0; left: 0; right: 0; background: var(--card); border-top: 1px solid var(--border); padding: 10px 24px; display: flex; align-items: center; justify-content: center; gap: 24px; font-size: .8rem; z-index: 100; }
.floating-bar .item { display: flex; align-items: center; gap: 6px; }
canvas { display: block; margin: 0 auto; }
.fragment-feed { max-height: 350px; overflow-y: auto; }
.fragment { padding: 10px; margin-bottom: 6px; background: rgba(255,255,255,.03); border-radius: 8px; border-left: 3px solid var(--primary); animation: fadeIn .3s; }
.fragment.high { border-left-color: var(--yellow); box-shadow: 0 0 8px rgba(234,179,8,.15); }
@keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
.empty { text-align: center; color: var(--muted); padding: 40px 0; }
.pagination { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
.sound-toggle { cursor: pointer; font-size: 1.2rem; background: none; border: none; padding: 4px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span>&#129504;</span> Dream Engine <span class="conn-dot err" id="conn"></span></h1>
    <button class="btn btn-primary" id="triggerBtn" onclick="triggerDream()">Trigger Dream</button>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="status">Status</button>
    <button class="tab" data-tab="history">History</button>
    <button class="tab" data-tab="analytics">Analytics</button>
    <button class="tab" data-tab="emotional">Emotional</button>
    <button class="tab" data-tab="curiosity">Curiosity</button>
    <button class="tab" data-tab="earnings">Earnings</button>
    <button class="tab" data-tab="live">Live</button>
  </div>

  <!-- STATUS TAB -->
  <div class="panel active" id="panel-status">
    <div class="stats-grid" id="status-stats"></div>
    <div class="card" id="status-last"></div>
    <div class="card"><h3 style="margin-bottom:12px">Hormonal State</h3><div id="hormone-display"></div></div>
  </div>

  <!-- HISTORY TAB -->
  <div class="panel" id="panel-history">
    <div id="history-list"></div>
    <div class="pagination" id="history-pag"></div>
  </div>

  <!-- ANALYTICS TAB -->
  <div class="panel" id="panel-analytics">
    <div class="stats-grid" id="analytics-stats"></div>
    <div class="card"><h3 style="margin-bottom:12px">Mode Distribution</h3><div id="mode-dist"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Time of Day Pattern</h3><div class="bar-chart" id="hour-chart"></div>
      <div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);margin-top:4px"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
    </div>
  </div>

  <!-- EMOTIONAL TAB -->
  <div class="panel" id="panel-emotional">
    <div class="stats-grid" id="emo-cards"></div>
    <div class="card"><h3 style="margin-bottom:12px">Emotional Timeline</h3><canvas id="emo-canvas" width="700" height="220"></canvas></div>
    <div class="card" id="emo-briefing"></div>
  </div>

  <!-- CURIOSITY TAB (GCCRF) -->
  <div class="panel" id="panel-curiosity">
    <div class="stats-grid" id="curiosity-stats"></div>
    <div class="card"><h3 style="margin-bottom:12px">Alpha Schedule (Developmental Annealing)</h3>
      <div id="alpha-bar" style="margin-bottom:8px"></div>
      <div style="font-size:.75rem;color:var(--muted)">Young agent (α&lt;-1): curious about common things &nbsp;→&nbsp; Mature agent (α→0): curious about frontiers</div>
    </div>
    <div class="card"><h3 style="margin-bottom:12px">GCCRF Components</h3><div id="gccrf-components"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Region Learning Progress</h3><div id="region-progress"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Reward History</h3><div class="bar-chart" id="reward-chart" style="height:100px"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Top Exploration Targets</h3><div id="exploration-targets"></div></div>
  </div>

  <!-- EARNINGS TAB -->
  <div class="panel" id="panel-earnings">
    <div class="stats-grid" id="earnings-stats"></div>
    <div class="card"><h3 style="margin-bottom:12px">Earnings Trend (7 days)</h3><div class="bar-chart" id="earnings-chart" style="height:100px"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Top Earning Skills</h3><div id="top-earners"></div></div>
    <div class="card"><h3 style="margin-bottom:12px">Marketplace Listings</h3><div id="listings-table"></div></div>
  </div>

  <!-- LIVE TAB -->
  <div class="panel" id="panel-live">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3>Live Dream Fragments</h3>
      <button class="sound-toggle" id="soundBtn" onclick="toggleSound()" title="Toggle sound">&#128264;</button>
    </div>
    <div class="card fragment-feed" id="frag-feed"><div class="empty">Waiting for dream activity...</div></div>
    <div class="card" style="margin-top:14px"><h3 style="margin-bottom:12px">Emotional Radar</h3><canvas id="radar-canvas" width="300" height="200"></canvas></div>
  </div>
</div>

<div class="floating-bar">
  <div class="item" id="float-state">State: --</div>
  <div class="item" id="float-last">Last: --</div>
  <div class="item" id="float-insights">Insights: --</div>
  <div class="item" id="float-hormones"></div>
</div>

<script>
const WS_URL = ${JSON.stringify(gatewayWsUrl)};
const GW_TOKEN = ${JSON.stringify(gatewayToken ?? "")};
let ws, rpcId = 0, soundEnabled = false, audioCtx = null;
const pending = new Map();
const MODE_COLORS = {replay:'var(--blue)',mutation:'var(--purple)',extrapolation:'var(--green)',compression:'var(--orange)',simulation:'var(--pink)',exploration:'var(--indigo)',research:'var(--teal)'};
const MODE_CSS = {replay:'badge-replay',mutation:'badge-mutation',extrapolation:'badge-extrapolation',compression:'badge-compression',simulation:'badge-simulation',exploration:'badge-exploration',research:'badge-research'};
let historyPage = 0, lastInsights = [], lastHormones = null;

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++rpcId);
    pending.set(id, { resolve, reject });
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'req', id, method, params }));
    else reject(new Error('not connected'));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 30000);
  });
}

let wsConnected = false;
function connectWs() {
  wsConnected = false;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {};
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // Handle connect.challenge → send connect with token from URL query or cookie
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const connId = String(++rpcId);
      pending.set(connId, {
        resolve: () => { wsConnected = true; document.getElementById('conn').className = 'conn-dot ok'; loadActiveTab(); },
        reject: () => { wsConnected = true; document.getElementById('conn').className = 'conn-dot ok'; loadActiveTab(); }
      });
      ws.send(JSON.stringify({
        type: 'req', id: connId, method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'bitterbot-control-ui', version: '1.0.0', platform: 'browser', mode: 'ui' },
          auth: GW_TOKEN ? { token: GW_TOKEN } : undefined,
          scopes: ['operator.admin', 'operator.read', 'operator.write']
        }
      }));
      return;
    }
    if (msg.type === 'res' && msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok === false ? reject(new Error(msg.error?.message||'RPC error')) : resolve(msg.payload ?? {});
    }
  };
  ws.onclose = () => { document.getElementById('conn').className = 'conn-dot err'; wsConnected = false; setTimeout(connectWs, 3000); };
  ws.onerror = () => {};
}

// Tabs
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.getElementById('panel-' + t.dataset.tab).classList.add('active');
  loadActiveTab();
}));

function activeTab() { return document.querySelector('.tab.active')?.dataset?.tab || 'status'; }

function loadActiveTab() {
  const tab = activeTab();
  if (tab === 'status') loadStatus();
  else if (tab === 'history') loadHistory();
  else if (tab === 'analytics') loadAnalytics();
  else if (tab === 'emotional') loadEmotional();
  else if (tab === 'curiosity') loadCuriosity();
  else if (tab === 'earnings') loadEarnings();
  else if (tab === 'live') loadLive();
}

function ago(ts) {
  if (!ts) return '--';
  const d = Date.now() - ts, m = Math.floor(d/60000), h = Math.floor(d/3600000);
  if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago';
  return Math.floor(h/24) + 'd ago';
}
function timeUntil(ts) {
  if (!ts) return '--';
  const d = ts - Date.now();
  if (d <= 0) return 'now';
  const m = Math.floor(d/60000), h = Math.floor(d/3600000);
  if (m < 60) return 'in ' + m + 'm';
  return 'in ' + h + 'h ' + (m%60) + 'm';
}
function dur(ms) { if (!ms) return '--'; if (ms < 1000) return ms+'ms'; return (ms/1000).toFixed(1)+'s'; }
function modeBadges(modes) { return (modes||[]).map(m => '<span class="badge '+( MODE_CSS[m]||'')+'">'+ m+'</span>').join(' '); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// STATUS
async function loadStatus() {
  try {
    const s = await rpc('dream.status');
    const isDreaming = s?.state && s.state !== 'DORMANT';
    document.getElementById('status-stats').innerHTML =
      '<div class="stat-card"><div class="label">State</div><div class="value"><span class="badge badge-state '+(isDreaming?'badge-dreaming':'badge-dormant')+'">'+(s?.state||'UNKNOWN')+'</span></div></div>' +
      '<div class="stat-card"><div class="label">Total Cycles</div><div class="value">'+(s?.cycleCount??0)+'</div></div>' +
      '<div class="stat-card"><div class="label">Total Insights</div><div class="value">'+(s?.insightCount??0)+'</div></div>' +
      '<div class="stat-card"><div class="label">Next Dream</div><div class="value" style="font-size:1.2rem">'+(s?.nextDreamEta ? timeUntil(s.nextDreamEta) : '--')+'</div><div class="sub">'+(s?.nextDreamEta?new Date(s.nextDreamEta).toLocaleTimeString():'')+'</div></div>';

    const lc = s?.lastCycle;
    document.getElementById('status-last').innerHTML = lc ?
      '<h3 style="margin-bottom:8px">Last Dream Cycle</h3>' +
      '<div class="cycle-modes" style="margin-bottom:8px">' + modeBadges(lc.modesUsed) + '</div>' +
      '<div class="cycle-stats"><span>Duration: '+dur(lc.durationMs)+'</span><span>Chunks: '+(lc.chunksAnalyzed??0)+'</span><span>LLM calls: '+(lc.llmCallsUsed??0)+'</span><span>Insights: '+(lc.insightsGenerated??0)+'</span></div>' +
      '<div style="font-size:.75rem;color:var(--muted);margin-top:6px">'+ago(lc.completedAt)+'</div>'
      : '<div class="empty">No dream cycles yet</div>';

    if (s?.hormones) { lastHormones = s.hormones; renderHormones(s.hormones); }
    updateFloating(s);
  } catch(e) { console.warn('status error', e); }
}

function renderHormones(h) {
  if (!h) return;
  const items = [
    {icon:'&#9889;',label:'Energy (Dopamine)',val:h.dopamine,color:'var(--blue)'},
    {icon:'&#127919;',label:'Focus (Cortisol)',val:h.cortisol,color:'var(--red)'},
    {icon:'&#128151;',label:'Warmth (Oxytocin)',val:h.oxytocin,color:'var(--pink)'},
  ];
  document.getElementById('hormone-display').innerHTML = items.map(i =>
    '<div class="hormone-bar"><span class="icon">'+i.icon+'</span><span style="font-size:.8rem;min-width:130px">'+i.label+'</span><div class="track"><div class="fill" style="width:'+Math.round(i.val*100)+'%;background:'+i.color+'"></div></div><span class="val">'+i.val.toFixed(2)+'</span></div>'
  ).join('');
}

function updateFloating(s) {
  document.getElementById('float-state').textContent = 'State: '+(s?.state||'--');
  document.getElementById('float-last').textContent = 'Last: '+ago(s?.lastCycle?.completedAt);
  document.getElementById('float-insights').textContent = 'Insights: '+(s?.insightCount??'--');
  if (s?.hormones) {
    const h = s.hormones;
    document.getElementById('float-hormones').innerHTML = '&#9889; '+h.dopamine.toFixed(2)+' &nbsp; &#127919; '+h.cortisol.toFixed(2)+' &nbsp; &#128151; '+h.oxytocin.toFixed(2);
  }
}

// TRIGGER
async function triggerDream() {
  const btn = document.getElementById('triggerBtn');
  btn.disabled = true; btn.textContent = 'Dreaming...';
  try {
    const res = await rpc('dream.trigger');
    btn.textContent = res?.success ? 'Done! ('+( res.insightsGenerated??0)+' insights)' : 'Failed';
    setTimeout(() => { btn.textContent = 'Trigger Dream'; btn.disabled = false; loadActiveTab(); }, 3000);
  } catch(e) { btn.textContent = 'Error'; setTimeout(() => { btn.textContent = 'Trigger Dream'; btn.disabled = false; }, 2000); }
}

// HISTORY
async function loadHistory() {
  try {
    const res = await rpc('dream.history', { limit: 5, offset: historyPage * 5 });
    const list = document.getElementById('history-list');
    if (!res.cycles?.length) { list.innerHTML = '<div class="empty">No dream cycles recorded yet</div>'; return; }
    list.innerHTML = res.cycles.map((c,i) =>
      '<div class="card cycle-card" onclick="this.classList.toggle(\\'open\\')">' +
      '<div class="cycle-header"><div class="cycle-modes">'+modeBadges(c.modesUsed)+'</div>' +
      '<span style="font-size:.8rem;color:var(--muted)">'+ago(c.startedAt)+' &middot; '+dur(c.durationMs)+'</span></div>' +
      '<div class="cycle-stats"><span>Chunks: '+c.chunksAnalyzed+'</span><span>LLM: '+c.llmCallsUsed+'</span><span>Insights: '+c.insightsGenerated+'</span>' +
      (c.insightsGenerated > 0 ? '<span style="color:var(--yellow)">&#11088;</span>' : '') + '</div>' +
      '<div class="expand" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">' +
      (c.insights?.length ? c.insights.map(ins =>
        '<div class="insight-item"><div>'+esc(ins.content?.slice(0,200))+'</div><div class="meta"><span class="badge '+(MODE_CSS[ins.mode]||'')+'">'+ins.mode+'</span> confidence: '+(ins.confidence?.toFixed(2)??'--')+'</div></div>'
      ).join('') : '<div class="empty" style="padding:10px 0">No insights this cycle</div>') +
      '</div></div>'
    ).join('');
    const totalPages = Math.ceil(res.total / 5);
    document.getElementById('history-pag').innerHTML = totalPages > 1 ?
      '<button class="btn" onclick="historyPage=Math.max(0,historyPage-1);loadHistory()" '+(historyPage===0?'disabled':'')+'>Prev</button>' +
      '<span style="color:var(--muted);padding:8px">'+(historyPage+1)+'/'+totalPages+'</span>' +
      '<button class="btn" onclick="historyPage=Math.min('+(totalPages-1)+',historyPage+1);loadHistory()" '+(historyPage>=totalPages-1?'disabled':'')+'>Next</button>' : '';
  } catch(e) { console.warn('history error', e); }
}

// ANALYTICS
async function loadAnalytics() {
  try {
    const a = await rpc('dream.analytics', { days: 30 });
    document.getElementById('analytics-stats').innerHTML =
      '<div class="stat-card"><div class="label">Total Cycles</div><div class="value">'+(a.totalCycles??0)+'</div></div>' +
      '<div class="stat-card"><div class="label">Total Insights</div><div class="value">'+(a.totalInsights??0)+'</div></div>' +
      '<div class="stat-card"><div class="label">Avg Duration</div><div class="value">'+dur(a.avgDurationMs)+'</div></div>' +
      '<div class="stat-card"><div class="label">Chunks Analyzed</div><div class="value">'+(a.totalChunksAnalyzed??0)+'</div></div>';

    // Mode distribution
    const modes = a.modeFrequency || {};
    const modeTotal = Object.values(modes).reduce((s,v) => s+v, 0) || 1;
    document.getElementById('mode-dist').innerHTML = Object.entries(modes).sort((a,b)=>b[1]-a[1]).map(([m,c]) =>
      '<div class="mode-bar"><span class="name">'+m+'</span><div style="flex:1"><div class="fill" style="width:'+Math.round(c/modeTotal*100)+'%;background:'+(MODE_COLORS[m]||'var(--primary)')+'"></div></div><span class="pct">'+Math.round(c/modeTotal*100)+'%</span></div>'
    ).join('') || '<div class="empty">No data</div>';

    // Hour chart
    const hours = a.hourBuckets || new Array(24).fill(0);
    const maxH = Math.max(...hours, 1);
    document.getElementById('hour-chart').innerHTML = hours.map((v,i) =>
      '<div class="bar" style="height:'+Math.max(2, v/maxH*100)+'%" title="'+String(i).padStart(2,'0')+':00 — '+v+' cycles"></div>'
    ).join('');
  } catch(e) { console.warn('analytics error', e); }
}

// EMOTIONAL
async function loadEmotional() {
  try {
    const e = await rpc('dream.emotional');
    const quad = getQuadrant(e.dopamine, e.cortisol, e.oxytocin);
    document.getElementById('emo-cards').innerHTML =
      '<div class="stat-card"><div class="label">&#9889; Energy</div><div class="value">'+(e.dopamine?.toFixed(2)??'--')+'</div></div>' +
      '<div class="stat-card"><div class="label">&#127919; Focus</div><div class="value">'+(e.cortisol?.toFixed(2)??'--')+'</div></div>' +
      '<div class="stat-card"><div class="label">&#128151; Warmth</div><div class="value">'+(e.oxytocin?.toFixed(2)??'--')+'</div></div>' +
      '<div class="stat-card"><div class="label">Mood</div><div class="value" style="font-size:1rem">'+(e.mood??'--')+'</div><div class="sub">'+quad+'</div></div>';
    document.getElementById('emo-briefing').innerHTML = '<h3 style="margin-bottom:8px">Emotional Briefing</h3><p style="color:var(--muted);font-size:.9rem">'+(e.emotionalBriefing||'No briefing available.')+'</p>' +
      (e.trajectory ? '<p style="margin-top:8px;font-size:.85rem">Trend: <strong>'+e.trajectory.trend+'</strong>'+(e.trajectory.recentShift?' — '+e.trajectory.recentShift:'')+'</p>' : '');
    drawEmotionalCanvas(e);
    drawRadar(e);
  } catch(e) { console.warn('emotional error', e); }
}

function getQuadrant(d,c,o) {
  if (d > .6 && c < .4) return 'Energized & Focused';
  if (d > .6 && c > .6) return 'Driven & Urgent';
  if (o > .6 && c < .4) return 'Warm & Relaxed';
  if (c > .6 && o < .4) return 'Stressed & Isolated';
  return 'Balanced';
}

function drawEmotionalCanvas(e) {
  const canvas = document.getElementById('emo-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 40;
  ctx.clearRect(0,0,W,H);
  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
  for (let i=0;i<=4;i++) { const y=pad+(H-2*pad)*i/4; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke(); }
  // Labels
  ctx.fillStyle = 'var(--muted)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  ['1.0','0.75','0.5','0.25','0'].forEach((l,i) => { ctx.fillText(l, pad-6, pad+(H-2*pad)*i/4+4); });
  // Draw metric lines (use current values as a simple representation)
  const metrics = [{val:e.dopamine,color:'var(--blue)',label:'Energy'},{val:e.cortisol,color:'var(--red)',label:'Focus'},{val:e.oxytocin,color:'var(--pink)',label:'Warmth'}];
  const cW = W-2*pad;
  metrics.forEach((m,mi) => {
    const y = pad + (H-2*pad) * (1 - (m.val??0));
    ctx.strokeStyle = m.color; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(pad+cW, y); ctx.stroke();
    ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(pad+cW/2, y, 5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = m.color; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(m.label+': '+(m.val?.toFixed(2)??'--'), pad+cW+8, y+4);
  });
}

function drawRadar(e) {
  const canvas = document.getElementById('radar-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2+5, r = 70;
  ctx.clearRect(0,0,W,H);
  // Grid circles
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1;
  for (let i=1;i<=4;i++) { ctx.beginPath(); ctx.arc(cx,cy,r*i/4,0,Math.PI*2); ctx.stroke(); }
  // Axes (120 degrees apart)
  const axes = [{label:'Energy',angle:-Math.PI/2,val:e?.dopamine??0},{label:'Focus',angle:-Math.PI/2+2*Math.PI/3,val:e?.cortisol??0},{label:'Warmth',angle:-Math.PI/2+4*Math.PI/3,val:e?.oxytocin??0}];
  ctx.strokeStyle = 'rgba(255,255,255,.15)';
  axes.forEach(a => { ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+Math.cos(a.angle)*r, cy+Math.sin(a.angle)*r); ctx.stroke(); });
  // Labels
  ctx.fillStyle = 'var(--muted)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  axes.forEach(a => { const lx=cx+Math.cos(a.angle)*(r+18), ly=cy+Math.sin(a.angle)*(r+18); ctx.fillText(a.label, lx, ly+4); });
  // Data polygon
  ctx.beginPath();
  axes.forEach((a,i) => {
    const px = cx + Math.cos(a.angle)*r*a.val, py = cy + Math.sin(a.angle)*r*a.val;
    i===0 ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(139,92,246,0.25)'; ctx.fill();
  ctx.strokeStyle = 'var(--primary)'; ctx.lineWidth = 2; ctx.stroke();
  // Data points
  ctx.fillStyle = 'var(--primary)';
  axes.forEach(a => { const px=cx+Math.cos(a.angle)*r*a.val, py=cy+Math.sin(a.angle)*r*a.val; ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2); ctx.fill(); });
}

// CURIOSITY (GCCRF)
async function loadCuriosity() {
  try {
    const c = await rpc('dream.curiosityReward');
    if (!c?.enabled) {
      document.getElementById('curiosity-stats').innerHTML = '<div class="empty">GCCRF not initialized yet</div>';
      return;
    }

    // Stats cards: alpha, maturity, avg reward, scored chunks
    const alphaLabel = c.alpha < -1 ? 'Infant (commonality)' : c.alpha < -0.3 ? 'Adolescent (transition)' : 'Mature (frontier)';
    document.getElementById('curiosity-stats').innerHTML =
      '<div class="stat-card"><div class="label">Alpha (\\u03B1)</div><div class="value">'+(c.alpha?.toFixed(2)??'--')+'</div><div class="sub">'+alphaLabel+'</div></div>' +
      '<div class="stat-card"><div class="label">Maturity</div><div class="value">'+Math.round((c.maturity??0)*100)+'%</div><div class="sub">'+(c.config?.expectedMatureCycles??100)+' dream cycles to mature</div></div>' +
      '<div class="stat-card"><div class="label">Avg Reward</div><div class="value">'+(c.rewardStats?.avg?.toFixed(3)??'--')+'</div><div class="sub">'+c.rewardStats?.count+' chunks scored</div></div>' +
      '<div class="stat-card"><div class="label">Reward Range</div><div class="value">'+(c.rewardStats?.min?.toFixed(3)??'0')+' - '+(c.rewardStats?.max?.toFixed(3)??'0')+'</div></div>';

    // Alpha progress bar
    const alphaPct = Math.round(((c.alpha - (c.config?.alphaStart??-3)) / ((c.config?.alphaEnd??0) - (c.config?.alphaStart??-3))) * 100);
    document.getElementById('alpha-bar').innerHTML =
      '<div style="display:flex;align-items:center;gap:12px">' +
      '<span style="font-size:.8rem;color:var(--muted)">\\u03B1='+((c.config?.alphaStart)??-3).toFixed(1)+'</span>' +
      '<div style="flex:1;height:12px;background:rgba(255,255,255,.06);border-radius:6px;overflow:hidden;position:relative">' +
      '<div style="width:'+alphaPct+'%;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--blue),var(--purple),var(--orange));transition:width .5s"></div>' +
      '<div style="position:absolute;left:33%;top:0;bottom:0;width:1px;background:rgba(255,255,255,.2)" title="\\u03B1=-1 transition"></div>' +
      '</div>' +
      '<span style="font-size:.8rem;color:var(--muted)">\\u03B1='+((c.config?.alphaEnd)??0).toFixed(1)+'</span></div>';

    // GCCRF Components (from normalizer means)
    const comps = c.components || {};
    const compNames = [
      {key:'eta',label:'Prediction Error (\\u03B7)',color:'var(--blue)',desc:'How surprising is this?'},
      {key:'deltaEta',label:'Learning Progress (\\u0394\\u03B7)',color:'var(--green)',desc:'Am I getting better?'},
      {key:'iAlpha',label:'Info Novelty (I\\u03B1)',color:'var(--purple)',desc:'How rare in knowledge space?'},
      {key:'empowerment',label:'Empowerment (E\\u00B7\\u03BC)',color:'var(--orange)',desc:'Does this give me agency?'},
      {key:'strategic',label:'Strategic Alignment (S)',color:'var(--teal)',desc:'Does this match my goals?'},
    ];
    document.getElementById('gccrf-components').innerHTML = compNames.map((comp,i) => {
      const norm = comps[comp.key];
      const mean = norm?.mean ?? 0.5;
      const w = c.config?.weights?.[i] ?? 0;
      return '<div class="mode-bar"><span class="name" title="'+comp.desc+'">'+comp.label+' <span style="color:var(--muted)">(w='+w.toFixed(2)+')</span></span><div style="flex:1"><div class="fill" style="width:'+Math.round(mean*100)+'%;background:'+comp.color+'"></div></div><span class="pct">'+mean.toFixed(2)+'</span></div>';
    }).join('');

    // Region Learning Progress
    const rp = c.regionProgress || [];
    if (rp.length > 0) {
      document.getElementById('region-progress').innerHTML = rp.slice(0,10).map(function(r) {
        const barW = Math.round(Math.min(1, r.deltaEta * 5) * 100);
        const etaW = Math.round(r.eta * 100);
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:.8rem"><span>'+esc(r.label)+'</span><span style="color:var(--muted)">\\u0394\\u03B7='+r.deltaEta.toFixed(3)+' \\u03B7='+r.eta.toFixed(2)+'</span></div><div style="display:flex;gap:4px;height:6px;margin-top:3px"><div style="flex:1;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden"><div style="width:'+barW+'%;height:100%;background:var(--green);border-radius:3px" title="Learning progress"></div></div><div style="flex:1;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden"><div style="width:'+etaW+'%;height:100%;background:var(--blue);border-radius:3px" title="Prediction error"></div></div></div></div>';
      }).join('');
    } else {
      document.getElementById('region-progress').innerHTML = '<div class="empty">No region data yet</div>';
    }

    // Reward History Chart
    const rh = c.rewardHistory || [];
    if (rh.length > 0) {
      const maxR = Math.max(...rh.map(function(r){return r.reward}), 0.01);
      document.getElementById('reward-chart').innerHTML = rh.map(function(r) {
        return '<div class="bar" style="height:'+Math.max(2, r.reward/maxR*100)+'%;background:'+(r.reward > 0.7 ? 'var(--yellow)' : r.reward > 0.4 ? 'var(--primary)' : 'var(--muted)')+'" title="Reward: '+r.reward.toFixed(3)+'"></div>';
      }).join('');
    } else {
      document.getElementById('reward-chart').innerHTML = '<div class="empty" style="height:100px;display:flex;align-items:center;justify-content:center">No reward data yet</div>';
    }

    // Exploration Targets
    const targets = c.topTargets || [];
    if (targets.length > 0) {
      document.getElementById('exploration-targets').innerHTML = targets.map(function(t) {
        return '<div class="insight-item"><div style="display:flex;gap:8px;align-items:center"><span class="badge badge-exploration">'+t.type+'</span><span style="font-size:.75rem;color:var(--muted)">priority: '+t.priority.toFixed(2)+'</span></div><div style="margin-top:4px;font-size:.85rem">'+esc(t.description.slice(0,200))+'</div></div>';
      }).join('');
    } else {
      document.getElementById('exploration-targets').innerHTML = '<div class="empty">No active exploration targets</div>';
    }
  } catch(e) { console.warn('curiosity error', e); }
}

// EARNINGS
async function loadEarnings() {
  const data = await rpc('dream.marketplaceStatus');
  if (!data || !data.enabled) {
    q('#earnings-stats').innerHTML = '<div class="stat-card"><div class="stat-label">Marketplace</div><div class="stat-value">Not enabled</div></div>';
    return;
  }
  const s = data.summary;
  q('#earnings-stats').innerHTML = [
    statCard('Total Earned', '$' + (s.totalEarningsUsdc || 0).toFixed(4) + ' USDC'),
    statCard('Total Spent', '$' + (s.totalSpentUsdc || 0).toFixed(4) + ' USDC'),
    statCard('Net', '$' + (s.netEarningsUsdc || 0).toFixed(4) + ' USDC'),
    statCard('Listed Skills', s.listedSkillCount || 0),
    statCard('Unique Buyers', s.uniqueBuyers || 0),
    statCard('Skills Purchased', s.skillsPurchased || 0),
  ].join('');

  // Earnings trend chart
  const trend = s.earningsTrend || [];
  if (trend.length > 0) {
    const maxAmt = Math.max(...trend.map(d => d.amountUsdc), 0.001);
    q('#earnings-chart').innerHTML = trend.map(d => {
      const pct = Math.round((d.amountUsdc / maxAmt) * 100);
      return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<span style="width:80px;font-size:.75rem;color:var(--muted)">' + d.date + '</span>' +
        '<div style="flex:1;background:var(--bg);border-radius:4px;height:18px">' +
        '<div style="width:' + pct + '%;background:var(--accent);border-radius:4px;height:100%"></div></div>' +
        '<span style="width:80px;text-align:right;font-size:.75rem">$' + d.amountUsdc.toFixed(4) + '</span></div>';
    }).join('');
  } else {
    q('#earnings-chart').innerHTML = '<div style="color:var(--muted);font-size:.85rem">No earnings yet</div>';
  }

  // Top earners
  const earners = s.topEarners || [];
  q('#top-earners').innerHTML = earners.length > 0
    ? earners.map(e => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span>' + esc(e.name) + '</span><span style="color:var(--accent)">$' + e.earningsUsdc.toFixed(4) + ' (' + e.purchases + ' sales)</span></div>').join('')
    : '<div style="color:var(--muted);font-size:.85rem">No sales yet</div>';

  // Listings
  const listings = data.listings || [];
  q('#listings-table').innerHTML = listings.length > 0
    ? listings.map(l => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span>' + esc(l.name) + '</span><span>$' + l.priceUsdc.toFixed(4) + ' USDC</span></div>').join('')
    : '<div style="color:var(--muted);font-size:.85rem">No skills listed yet. Skills are listed automatically after meeting quality gates.</div>';
}

// LIVE
let liveTimer = null;
async function loadLive() {
  clearInterval(liveTimer);
  await pollLive();
  liveTimer = setInterval(pollLive, 5000);
}
async function pollLive() {
  if (document.hidden || activeTab() !== 'live') return;
  try {
    const [status, insights] = await Promise.all([rpc('dream.status'), rpc('dream.insights', {limit:10})]);
    updateFloating(status);
    if (status?.hormones) drawRadar({dopamine:status.hormones.dopamine, cortisol:status.hormones.cortisol, oxytocin:status.hormones.oxytocin});
    const feed = document.getElementById('frag-feed');
    const newInsights = insights?.insights || [];
    const newIds = new Set(newInsights.map(i=>i.id));
    const prevIds = new Set(lastInsights.map(i=>i.id));
    const fresh = newInsights.filter(i => !prevIds.has(i.id));
    if (fresh.length > 0 && soundEnabled) playInsightSound();
    lastInsights = newInsights;
    if (newInsights.length === 0) { feed.innerHTML = '<div class="empty">Waiting for dream activity...</div>'; return; }
    feed.innerHTML = newInsights.map(i =>
      '<div class="fragment'+(i.importanceScore>=.8?' high':'')+'"><div style="display:flex;gap:8px;align-items:center"><span class="badge '+(MODE_CSS[i.mode]||'')+'">'+i.mode+'</span><span style="font-size:.75rem;color:var(--muted)">confidence: '+(i.confidence?.toFixed(2)??'')+'</span></div><div style="margin-top:6px;font-size:.9rem">'+esc(i.content?.slice(0,300))+'</div></div>'
    ).join('');
  } catch(e) { console.warn('live poll error', e); }
}

// Sound
function toggleSound() {
  soundEnabled = !soundEnabled;
  document.getElementById('soundBtn').innerHTML = soundEnabled ? '&#128266;' : '&#128264;';
  if (soundEnabled && !audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function playSound(freq, duration, type='sine') {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.05);
  gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + duration);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + duration);
}
function playInsightSound() {
  playSound(523.25, 0.3); setTimeout(()=>playSound(659.25, 0.3), 150); setTimeout(()=>playSound(783.99, 0.4), 300);
}

// Polling
let statusTimer = null;
function startPolling() {
  statusTimer = setInterval(() => { if (!document.hidden) { const t=activeTab(); if(t==='status') loadStatus(); } }, 10000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadActiveTab(); });

connectWs();
startPolling();
</script>
</body>
</html>`;
}
