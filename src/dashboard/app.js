/**
 * Vinyan Dashboard — vanilla JS SPA with SSE real-time updates.
 * Zero dependencies. Communicates exclusively with the Vinyan API server.
 */

// ── State ────────────────────────────────────────────────────────────

const state = {
  health: null,
  metrics: null,
  tasks: [],
  workers: [],
  sessions: [],
  events: [],
  connected: false,
};

const MAX_EVENTS = 500;

// ── SSE Connection ───────────────────────────────────────────────────

let eventSource = null;

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/v1/events');

  eventSource.onopen = () => {
    state.connected = true;
    updateConnectionStatus();
  };

  eventSource.onerror = () => {
    state.connected = false;
    updateConnectionStatus();
  };

  // Listen to all event types
  const eventTypes = [
    'task:start', 'task:complete', 'task:escalate', 'task:timeout', 'task:uncertain',
    'oracle:verdict', 'oracle:contradiction', 'oracle:deliberation_request',
    'worker:dispatch', 'worker:complete', 'worker:error', 'worker:selected',
    'worker:promoted', 'worker:demoted',
    'evolution:rulePromoted', 'evolution:ruleRetired',
    'sleep:cycleComplete',
    'peer:connected', 'peer:disconnected',
    'guardrail:violation',
  ];

  for (const type of eventTypes) {
    eventSource.addEventListener(type, (e) => {
      try {
        const data = JSON.parse(e.data);
        state.events.unshift({
          event: type,
          payload: data.payload,
          ts: data.ts || Date.now(),
        });
        if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
        render();
      } catch { /* ignore parse errors */ }
    });
  }
}

function updateConnectionStatus() {
  const dot = document.getElementById('connection-status');
  if (!dot) return;
  dot.className = 'status-dot ' + (state.connected ? 'connected' : 'disconnected');
  dot.title = state.connected ? 'SSE connected' : 'SSE disconnected';
}

// ── Polling ──────────────────────────────────────────────────────────

async function fetchHealth() {
  try {
    const r = await fetch('/api/v1/health');
    state.health = await r.json();
  } catch { state.health = null; }
}

async function fetchMetrics() {
  try {
    const r = await fetch('/api/v1/metrics?format=json');
    state.metrics = await r.json();
  } catch { state.metrics = null; }
}

async function fetchTasks() {
  try {
    const r = await fetch('/api/v1/tasks');
    const data = await r.json();
    state.tasks = data.tasks || [];
  } catch { /* keep existing */ }
}

async function fetchWorkers() {
  try {
    const r = await fetch('/api/v1/workers');
    const data = await r.json();
    state.workers = data.workers || [];
  } catch { /* keep existing */ }
}

async function refreshAll() {
  await Promise.all([fetchHealth(), fetchMetrics(), fetchTasks(), fetchWorkers()]);
  render();
}

// ── Router ───────────────────────────────────────────────────────────

function getTab() {
  const hash = location.hash.replace('#/', '') || 'overview';
  return hash;
}

function setActiveTab() {
  const tab = getTab();
  document.querySelectorAll('.nav-tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
}

// ── Render ───────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  setActiveTab();

  switch (getTab()) {
    case 'overview': app.innerHTML = renderOverview(); break;
    case 'tasks': app.innerHTML = renderTasks(); break;
    case 'peers': app.innerHTML = renderPeers(); break;
    case 'events': app.innerHTML = renderEvents(); break;
    default: app.innerHTML = renderOverview();
  }
}

// ── Overview View ────────────────────────────────────────────────────

function renderOverview() {
  const h = state.health;
  const m = state.metrics;

  const uptimeSec = h ? Math.floor((h.uptime_ms || 0) / 1000) : 0;
  const uptimeStr = uptimeSec > 3600
    ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
    : uptimeSec > 60
      ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
      : `${uptimeSec}s`;

  const tasksInFlight = m?.tasks_in_flight ?? 0;
  const workerCount = state.workers.length;

  // Metrics cards
  let metricsHtml = '';
  if (m && m.traces) {
    const tr = m.traces;
    const successRate = tr.total > 0 ? ((tr.succeeded / tr.total) * 100).toFixed(1) : '0';
    const gaugeClass = parseFloat(successRate) >= 80 ? 'gauge-green' : parseFloat(successRate) >= 50 ? 'gauge-yellow' : 'gauge-red';

    metricsHtml = `
      <div class="card">
        <div class="card-title">Success Rate</div>
        <div class="card-value">${successRate}%</div>
        <div class="gauge ${gaugeClass}"><div class="gauge-fill" style="width:${successRate}%"></div></div>
        <div class="card-sub">${tr.succeeded} / ${tr.total} tasks</div>
      </div>
      <div class="card">
        <div class="card-title">Routing Distribution</div>
        ${renderRoutingDist(tr.routingLevelDistribution || {})}
      </div>
    `;
  }

  // Workers summary
  let workersHtml = '';
  if (state.workers.length > 0) {
    const active = state.workers.filter((w) => w.status === 'active').length;
    const probation = state.workers.filter((w) => w.status === 'probation').length;
    workersHtml = `
      <div class="card">
        <div class="card-title">Workers</div>
        <div class="card-value">${workerCount}</div>
        <div class="card-sub">
          <span class="badge badge-ok">${active} active</span>
          ${probation > 0 ? `<span class="badge badge-warn">${probation} probation</span>` : ''}
        </div>
      </div>
    `;
  } else {
    workersHtml = `
      <div class="card">
        <div class="card-title">Workers</div>
        <div class="card-value">${workerCount}</div>
      </div>
    `;
  }

  // Recent events
  const recentEvents = state.events.slice(0, 10);
  const eventListHtml = recentEvents.length > 0
    ? recentEvents.map(renderEventEntry).join('')
    : '<div class="empty-state">No events yet</div>';

  return `
    <div class="grid grid-4" style="margin-bottom:${cssVar('gap')}">
      <div class="card">
        <div class="card-title">Status</div>
        <div class="card-value">${h ? '<span class="badge badge-ok">OK</span>' : '<span class="badge badge-err">Down</span>'}</div>
        <div class="card-sub">Uptime: ${uptimeStr}</div>
      </div>
      <div class="card">
        <div class="card-title">Tasks In Flight</div>
        <div class="card-value">${tasksInFlight}</div>
      </div>
      ${workersHtml}
      <div class="card">
        <div class="card-title">Events</div>
        <div class="card-value">${state.events.length}</div>
        <div class="card-sub">
          <span class="badge ${state.connected ? 'badge-ok' : 'badge-err'}">${state.connected ? 'Live' : 'Disconnected'}</span>
        </div>
      </div>
    </div>
    <div class="grid grid-2">
      ${metricsHtml}
    </div>
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Recent Events</div>
      <div class="event-log">${eventListHtml}</div>
    </div>
  `;
}

function renderRoutingDist(dist) {
  const levels = ['L0', 'L1', 'L2', 'L3'];
  const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;
  return levels.map((l) => {
    const count = dist[l] || 0;
    const pct = ((count / total) * 100).toFixed(0);
    return `<div class="metric-row"><span class="metric-label">${l}</span><span class="metric-value">${count} (${pct}%)</span></div>`;
  }).join('');
}

// ── Tasks View ───────────────────────────────────────────────────────

function renderTasks() {
  if (state.tasks.length === 0) {
    return '<div class="card"><div class="empty-state">No tasks</div></div>';
  }

  const rows = state.tasks.map((t) => {
    const badge = t.status === 'completed'
      ? '<span class="badge badge-ok">completed</span>'
      : t.status === 'running'
        ? '<span class="badge badge-running">running</span>'
        : `<span class="badge badge-info">${esc(t.status)}</span>`;

    return `<tr>
      <td><code>${esc(t.taskId)}</code></td>
      <td>${badge}</td>
      <td>${t.result?.goal ? esc(String(t.result.goal).slice(0, 60)) : '-'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Tasks (${state.tasks.length})</div>
      <table class="data-table">
        <thead><tr><th>ID</th><th>Status</th><th>Goal</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Peers View ───────────────────────────────────────────────────────

function renderPeers() {
  const peerEvents = state.events.filter((e) => e.event.startsWith('peer:'));
  if (peerEvents.length === 0) {
    return '<div class="card"><div class="empty-state">No peer activity</div></div>';
  }

  const rows = peerEvents.slice(0, 20).map((e) => {
    const p = e.payload || {};
    return `<tr>
      <td>${esc(e.event)}</td>
      <td>${esc(String(p.peerId || '-'))}</td>
      <td>${formatTs(e.ts)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Peer Activity</div>
      <table class="data-table">
        <thead><tr><th>Event</th><th>Peer</th><th>Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Events View ──────────────────────────────────────────────────────

function renderEvents() {
  if (state.events.length === 0) {
    return '<div class="card"><div class="empty-state">No events yet. Events appear when the orchestrator processes tasks.</div></div>';
  }

  return `
    <div class="card">
      <div class="card-title">Event Log (${state.events.length})</div>
      <div class="event-log">${state.events.map(renderEventEntry).join('')}</div>
    </div>
  `;
}

function renderEventEntry(e) {
  const cat = e.event.split(':')[0];
  const catClass = 'cat-' + cat;
  const payload = e.payload ? JSON.stringify(e.payload).slice(0, 120) : '';

  return `<div class="event-entry">
    <span class="event-ts">${formatTs(e.ts)}</span>
    <span class="event-name ${catClass}">${esc(e.event)}</span>
    <span class="event-payload">${esc(payload)}</span>
  </div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function formatTs(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
}

// ── Init ─────────────────────────────────────────────────────────────

window.addEventListener('hashchange', render);

connectSSE();
refreshAll();
setInterval(refreshAll, 5000);
