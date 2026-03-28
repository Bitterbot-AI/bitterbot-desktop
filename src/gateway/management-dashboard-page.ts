/**
 * Management Node Dashboard — self-contained HTML page served at GET /management.
 * Communicates with the gateway via WebSocket RPC.
 * Displays network census, anomaly alerts, economic overview, and peer topology.
 */

export function renderManagementDashboardPage(gatewayWsUrl: string, gatewayToken?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Management Node — Bitterbot Network</title>
<style>
:root {
  --bg: #0a0a14; --card: #12122a; --card-hover: #1a1a3a;
  --border: #2a2a5a; --text: #e2e8f0; --muted: #94a3b8;
  --primary: #6366f1; --primary-dim: rgba(99,102,241,.15);
  --green: #22c55e; --red: #ef4444; --yellow: #eab308;
  --orange: #f97316; --blue: #3b82f6; --purple: #8b5cf6;
  --teal: #14b8a6; --pink: #ec4899;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
.container { max-width: 1200px; margin: 0 auto; padding: 20px 16px; }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.header h1 { font-size: 1.4rem; display: flex; align-items: center; gap: 10px; }
.header h1 span { font-size: 1.6rem; }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 8px; }
.conn-dot.ok { background: var(--green); } .conn-dot.err { background: var(--red); }
.tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
.tab { padding: 8px 16px; cursor: pointer; border: none; background: none; color: var(--muted); font-size: 0.85rem; border-bottom: 2px solid transparent; transition: all .15s; }
.tab:hover { color: var(--text); } .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.card:hover { border-color: var(--primary); background: var(--card-hover); }
.card h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 8px; }
.card .value { font-size: 1.8rem; font-weight: 700; }
.card .sub { font-size: 0.75rem; color: var(--muted); margin-top: 4px; }
.health-bar { height: 6px; border-radius: 3px; background: var(--border); margin-top: 8px; overflow: hidden; }
.health-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
.alert-list { display: flex; flex-direction: column; gap: 8px; }
.alert { padding: 12px; border-radius: 8px; border-left: 3px solid; }
.alert.low { border-color: var(--blue); background: rgba(59,130,246,.08); }
.alert.medium { border-color: var(--yellow); background: rgba(234,179,8,.08); }
.alert.high { border-color: var(--orange); background: rgba(249,115,22,.08); }
.alert.critical { border-color: var(--red); background: rgba(239,68,68,.08); }
.alert-header { display: flex; justify-content: space-between; align-items: center; }
.alert-type { font-weight: 600; font-size: 0.85rem; }
.alert-severity { font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; }
.alert-desc { font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
.peer-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
.peer-table th { text-align: left; padding: 8px; color: var(--muted); font-size: 0.7rem; text-transform: uppercase; border-bottom: 1px solid var(--border); }
.peer-table td { padding: 8px; border-bottom: 1px solid rgba(42,42,90,.3); }
.peer-table tr:hover td { background: var(--card-hover); }
.badge { font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; }
.badge.management { background: rgba(99,102,241,.2); color: var(--primary); }
.badge.edge { background: rgba(20,184,166,.2); color: var(--teal); }
.badge.verified { background: rgba(34,197,94,.2); color: var(--green); }
.chart-area { height: 120px; display: flex; align-items: flex-end; gap: 2px; padding: 8px 0; }
.chart-bar { flex: 1; background: var(--primary); border-radius: 2px 2px 0 0; min-height: 2px; transition: height 0.3s; opacity: 0.7; }
.chart-bar:hover { opacity: 1; }
section { display: none; }
section.active { display: block; }
.empty { text-align: center; color: var(--muted); padding: 40px; font-size: 0.9rem; }
.btn { padding: 6px 14px; border: 1px solid var(--border); background: var(--card); color: var(--text); border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
.btn:hover { border-color: var(--primary); background: var(--primary-dim); }
.btn.danger { border-color: var(--red); color: var(--red); }
.btn.danger:hover { background: rgba(239,68,68,.15); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span>🛡️</span> Management Node <span class="conn-dot" id="conn-dot"></span></h1>
    <div style="font-size:0.8rem;color:var(--muted)" id="status-text">Connecting...</div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="peers">Peers</button>
    <button class="tab" data-tab="anomalies">Anomalies</button>
    <button class="tab" data-tab="economics">Economics</button>
  </div>

  <!-- OVERVIEW TAB -->
  <section id="tab-overview" class="active">
    <div class="grid">
      <div class="card">
        <h3>Connected Peers</h3>
        <div class="value" id="peer-count">—</div>
        <div class="sub" id="peer-tier-breakdown"></div>
      </div>
      <div class="card">
        <h3>Network Health</h3>
        <div class="value" id="health-score">—</div>
        <div class="health-bar"><div class="health-fill" id="health-fill" style="width:0%;background:var(--green)"></div></div>
      </div>
      <div class="card">
        <h3>Skills Published</h3>
        <div class="value" id="skills-count">—</div>
        <div class="sub">network-wide total</div>
      </div>
      <div class="card">
        <h3>Anomaly Alerts</h3>
        <div class="value" id="anomaly-count">—</div>
        <div class="sub" id="anomaly-severity"></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Peer Count History (last 100 census points)</h3>
      <div class="chart-area" id="peer-chart"></div>
    </div>
    <div class="card">
      <h3>Telemetry By Type</h3>
      <div id="telemetry-breakdown" style="font-size:0.85rem;color:var(--muted)">—</div>
    </div>
  </section>

  <!-- PEERS TAB -->
  <section id="tab-peers">
    <div class="card">
      <h3>Connected Peers</h3>
      <table class="peer-table">
        <thead><tr><th>Peer ID</th><th>Tier</th><th>Skills</th><th>Reputation</th><th>Connected</th></tr></thead>
        <tbody id="peer-table-body"><tr><td colspan="5" class="empty">Loading...</td></tr></tbody>
      </table>
    </div>
  </section>

  <!-- ANOMALIES TAB -->
  <section id="tab-anomalies">
    <div class="alert-list" id="alert-list">
      <div class="empty">No anomaly alerts</div>
    </div>
  </section>

  <!-- ECONOMICS TAB -->
  <section id="tab-economics">
    <div class="grid">
      <div class="card">
        <h3>Total Skills Listed</h3>
        <div class="value" id="econ-listings">—</div>
      </div>
      <div class="card">
        <h3>Average Price</h3>
        <div class="value" id="econ-avg-price">—</div>
        <div class="sub">USDC per skill</div>
      </div>
      <div class="card">
        <h3>Transaction Volume</h3>
        <div class="value" id="econ-volume">—</div>
        <div class="sub">total USDC</div>
      </div>
    </div>
  </section>
</div>

<script>
const WS_URL = ${JSON.stringify(gatewayWsUrl)};
const GW_TOKEN = ${JSON.stringify(gatewayToken ?? "")};
let ws = null;
let reqId = 0;
const pending = {};

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    document.getElementById('conn-dot').className = 'conn-dot err';
    document.getElementById('status-text').textContent = 'Handshaking...';
  };
  ws.onclose = () => {
    document.getElementById('conn-dot').className = 'conn-dot err';
    document.getElementById('status-text').textContent = 'Disconnected';
    setTimeout(connect, 3000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // Gateway v3 protocol: challenge arrives as an event frame
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      ws.send(JSON.stringify({
        type: 'req', id: 'mgmt-connect', method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'bitterbot-control-ui', version: '1.0.0', platform: 'browser', mode: 'ui' },
          auth: GW_TOKEN ? { token: GW_TOKEN } : undefined,
          scopes: ['operator.admin', 'operator.read', 'operator.write'],
          role: 'operator',
        }
      }));
      return;
    }
    if (msg.type === 'res') {
      if (msg.id === 'mgmt-connect' && msg.ok) {
        document.getElementById('conn-dot').className = 'conn-dot ok';
        document.getElementById('status-text').textContent = 'Connected';
        poll();
      }
      if (pending[msg.id]) {
        pending[msg.id](msg);
        delete pending[msg.id];
      }
    }
  };
}

function rpc(method, params = {}) {
  return new Promise((resolve) => {
    const id = 'mgmt-' + (++reqId);
    pending[id] = (msg) => resolve(msg.ok ? (msg.payload ?? msg.result) : null);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => { if (pending[id]) { delete pending[id]; resolve(null); } }, 10000);
  });
}

async function pollCensus() {
  const census = await rpc('management.census');
  if (!census) return;

  document.getElementById('peer-count').textContent = census.connectedPeers ?? '—';
  const tiers = census.peersByTier ?? {};
  document.getElementById('peer-tier-breakdown').textContent =
    Object.entries(tiers).map(([k,v]) => k + ': ' + v).join(' · ') || 'no peers';

  const health = census.networkHealthScore ?? 0;
  const pct = Math.round(health * 100);
  document.getElementById('health-score').textContent = pct + '%';
  const fill = document.getElementById('health-fill');
  fill.style.width = pct + '%';
  fill.style.background = health > 0.7 ? 'var(--green)' : health > 0.4 ? 'var(--yellow)' : 'var(--red)';

  document.getElementById('skills-count').textContent = census.skillsPublishedNetworkWide ?? '—';

  // Telemetry breakdown
  const telemetry = census.telemetryCountsByType ?? {};
  document.getElementById('telemetry-breakdown').innerHTML =
    Object.entries(telemetry).map(([k,v]) => '<span style="margin-right:16px">' + k + ': <strong>' + v + '</strong></span>').join('') || '—';

  // Peer count chart
  const history = census.peerCountHistory ?? [];
  const chart = document.getElementById('peer-chart');
  if (history.length > 0) {
    const max = Math.max(...history.map(h => h[1]), 1);
    chart.innerHTML = history.slice(-100).map(([ts, count]) =>
      '<div class="chart-bar" style="height:' + Math.max(2, (count / max) * 100) + '%" title="' + count + ' peers"></div>'
    ).join('');
  }
}

async function pollAnomalies() {
  const result = await rpc('management.anomalies');
  const alerts = result?.alerts ?? [];
  document.getElementById('anomaly-count').textContent = alerts.length;
  const high = alerts.filter(a => a.severity === 'high' || a.severity === 'critical').length;
  document.getElementById('anomaly-severity').textContent = high > 0 ? high + ' high severity' : 'all clear';

  const list = document.getElementById('alert-list');
  if (alerts.length === 0) {
    list.innerHTML = '<div class="empty">No anomaly alerts — network is healthy</div>';
  } else {
    list.innerHTML = alerts.map(a => '<div class="alert ' + a.severity + '">' +
      '<div class="alert-header"><span class="alert-type">' + a.alertType.replace(/_/g, ' ') + '</span>' +
      '<span class="alert-severity" style="background:rgba(255,255,255,.1)">' + a.severity + '</span></div>' +
      '<div class="alert-desc">' + a.description + '</div>' +
      (a.peerIds?.length ? '<div class="alert-desc">Peers: ' + a.peerIds.join(', ').slice(0, 60) + '</div>' : '') +
    '</div>').join('');
  }
}

async function pollPeers() {
  // Use the existing get_stats to get peer details
  const stats = await rpc('status');
  // Also get census for tier info
  const census = await rpc('management.census');
  const tiers = census?.peersByTier ?? {};

  const tbody = document.getElementById('peer-table-body');
  // For now, show tier summary since we don't have per-peer details via RPC
  tbody.innerHTML = Object.entries(tiers).map(([tier, count]) =>
    '<tr><td colspan="2"><span class="badge ' + tier + '">' + tier + '</span></td>' +
    '<td>' + count + ' peers</td><td>—</td><td>—</td></tr>'
  ).join('') || '<tr><td colspan="5" class="empty">No peers connected</td></tr>';
}

async function pollEconomics() {
  const econ = await rpc('management.economics');
  if (!econ) return;
  document.getElementById('econ-listings').textContent = econ.totalSkillsListed ?? '—';
  document.getElementById('econ-avg-price').textContent = econ.averagePrice ? '$' + econ.averagePrice.toFixed(4) : '—';
  document.getElementById('econ-volume').textContent = econ.transactionVolume ? '$' + econ.transactionVolume.toFixed(2) : '$0.00';
}

async function poll() {
  try {
    await Promise.all([pollCensus(), pollAnomalies(), pollPeers(), pollEconomics()]);
  } catch(e) { console.debug('poll error', e); }
}

connect();
setInterval(poll, 5000);
setTimeout(poll, 1500);
</script>
</body>
</html>`;
}
