/**
 * Vinyan Dashboard — vanilla JS SPA with SSE real-time updates.
 * Zero dependencies. Communicates exclusively with the Vinyan API server.
 */

// ── State ────────────────────────────────────────────────────────────

const state = {
  health: null,
  metrics: null,
  prometheusMetrics: null,
  tasks: [],
  workers: [],
  sessions: [],
  events: [],
  connected: false,
  sseRetryCount: 0,
  sseRetryTimer: null,
  traceFilters: {
    taskType: '',
    worker: '',
    outcome: '',
    routingLevel: '',
  },
};

const MAX_EVENTS = 500;

// ── SSE Connection with Exponential Backoff ──────────────────────────

let eventSource = null;
const SSE_MAX_RETRY_DELAY = 30_000;
const SSE_MAX_CONSECUTIVE_FAILURES = 5;

function connectSSE() {
  if (eventSource) eventSource.close();

  state.sseRetryCount = 0;
  _establishSSE();
}

function _establishSSE() {
  eventSource = new EventSource('/api/v1/events');

  eventSource.onopen = () => {
    state.connected = true;
    state.sseRetryCount = 0;
    updateConnectionStatus();
  };

  eventSource.onerror = () => {
    state.connected = false;
    if (eventSource) eventSource.close();
    eventSource = null;
    state.sseRetryCount++;
    updateConnectionStatus();

    if (state.sseRetryCount >= SSE_MAX_CONSECUTIVE_FAILURES) {
      // Show permanent failure state — user must click retry
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, state.sseRetryCount - 1), SSE_MAX_RETRY_DELAY);
    state.sseRetryTimer = setTimeout(() => _establishSSE(), delay);
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

  if (state.connected) {
    dot.className = 'status-dot connected';
    dot.title = 'SSE connected';
    dot.onclick = null;
  } else if (state.sseRetryCount >= SSE_MAX_CONSECUTIVE_FAILURES) {
    dot.className = 'status-dot failed';
    dot.title = 'Connection failed — click to retry';
    dot.style.cursor = 'pointer';
    dot.onclick = () => connectSSE();
  } else if (state.sseRetryCount > 0) {
    const delay = Math.min(1000 * Math.pow(2, state.sseRetryCount - 1), SSE_MAX_RETRY_DELAY);
    dot.className = 'status-dot reconnecting';
    dot.title = `Reconnecting in ${(delay / 1000).toFixed(0)}s... (attempt ${state.sseRetryCount})`;
    dot.onclick = null;
  } else {
    dot.className = 'status-dot disconnected';
    dot.title = 'SSE disconnected';
    dot.onclick = null;
  }
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

async function fetchPrometheusMetrics() {
  try {
    const r = await fetch('/api/v1/metrics');
    const text = await r.text();
    state.prometheusMetrics = parsePrometheusText(text);
  } catch { state.prometheusMetrics = null; }
}

function parsePrometheusText(text) {
  const metrics = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    // Match: metric_name{labels} value  OR  metric_name value
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+([\d.eE+-]+|NaN|Inf|-Inf)/);
    if (!match) {
      const simple = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+([\d.eE+-]+|NaN|Inf|-Inf)/);
      if (simple) {
        metrics[simple[1]] = parseFloat(simple[2]);
      }
      continue;
    }
    const name = match[1];
    const labels = match[2];
    const value = parseFloat(match[3]);
    if (!metrics[name]) metrics[name] = {};
    if (labels) {
      metrics[name][labels] = value;
    } else {
      metrics[name] = value;
    }
  }
  return metrics;
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

async function fetchSessions() {
  try {
    const r = await fetch('/api/v1/sessions');
    const data = await r.json();
    state.sessions = Array.isArray(data) ? data : (data.sessions || []);
  } catch { /* keep existing */ }
}

async function refreshAll() {
  await Promise.all([fetchHealth(), fetchMetrics(), fetchPrometheusMetrics(), fetchTasks(), fetchWorkers(), fetchSessions()]);
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

  // Prometheus metrics section
  const promHtml = renderPrometheusSection();

  // Fleet visualization
  const fleetHtml = renderFleetSection();

  // Session history
  const sessionHtml = renderSessionSection();

  // SSE status banner
  const sseBanner = renderSSEBanner();

  return `
    ${sseBanner}
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
    ${promHtml}
    ${fleetHtml}
    ${sessionHtml}
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Recent Events</div>
      <div class="event-log">${eventListHtml}</div>
    </div>
  `;
}

// ── SSE Status Banner ────────────────────────────────────────────────

function renderSSEBanner() {
  if (state.connected) return '';
  if (state.sseRetryCount >= SSE_MAX_CONSECUTIVE_FAILURES) {
    return `<div class="sse-banner sse-failed">
      Connection failed after ${SSE_MAX_CONSECUTIVE_FAILURES} attempts.
      <button onclick="connectSSE()" class="btn-retry">Retry</button>
    </div>`;
  }
  if (state.sseRetryCount > 0) {
    const delay = Math.min(1000 * Math.pow(2, state.sseRetryCount - 1), SSE_MAX_RETRY_DELAY);
    return `<div class="sse-banner sse-reconnecting">
      Reconnecting... attempt ${state.sseRetryCount} (next in ${(delay / 1000).toFixed(0)}s)
    </div>`;
  }
  return '';
}

// ── Prometheus Metrics Section ────────────────────────────────────────

function renderPrometheusSection() {
  const pm = state.prometheusMetrics;
  if (!pm) return '';

  const metricDefs = [
    { key: 'vinyan_tasks_total', label: 'Total Tasks', type: 'counter' },
    { key: 'vinyan_oracle_latency_seconds', label: 'Oracle Latency (avg)', type: 'gauge' },
    { key: 'vinyan_rules_active', label: 'Active Rules', type: 'counter' },
    { key: 'vinyan_skills_active', label: 'Active Skills', type: 'counter' },
    { key: 'vinyan_self_model_calibration', label: 'Self-Model Calibration', type: 'percent' },
  ];

  let rows = '';
  for (const def of metricDefs) {
    const val = typeof pm[def.key] === 'number' ? pm[def.key] : (typeof pm[def.key] === 'object' ? Object.values(pm[def.key])[0] : null);
    if (val === null && val === undefined) continue;
    const display = def.type === 'percent'
      ? `<div class="gauge ${val >= 0.8 ? 'gauge-green' : val >= 0.5 ? 'gauge-yellow' : 'gauge-red'}"><div class="gauge-fill" style="width:${(val * 100).toFixed(0)}%"></div></div><span class="metric-value">${(val * 100).toFixed(1)}%</span>`
      : def.type === 'gauge'
        ? `<span class="metric-value">${(val * 1000).toFixed(1)}ms</span>`
        : `<span class="metric-value">${val}</span>`;
    rows += `<div class="metric-row"><span class="metric-label">${def.label}</span>${display}</div>`;
  }

  // Histogram: task duration
  const durSum = pm['vinyan_task_duration_seconds_sum'];
  const durCount = pm['vinyan_task_duration_seconds_count'];
  if (typeof durSum === 'number' && typeof durCount === 'number' && durCount > 0) {
    const avg = ((durSum / durCount) * 1000).toFixed(0);
    rows += `<div class="metric-row"><span class="metric-label">Avg Task Duration</span><span class="metric-value">${avg}ms</span></div>`;
  }

  if (!rows) return '';

  return `
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Prometheus Metrics</div>
      ${rows}
    </div>
  `;
}

// ── Fleet Visualization ──────────────────────────────────────────────

function renderFleetSection() {
  if (state.workers.length === 0) return '';

  // Worker profiles table
  const tableRows = state.workers.map((w) => {
    const statusClass = w.status === 'active' ? 'badge-ok' : w.status === 'probation' ? 'badge-warn' : 'badge-err';
    const successRate = typeof w.successRate === 'number' ? w.successRate : 0;
    const avgQuality = typeof w.avgQuality === 'number' ? w.avgQuality : 0;
    const taskCount = w.taskCount ?? 0;

    return `<tr>
      <td><code>${esc(String(w.id || w.workerId || '-'))}</code></td>
      <td>${esc(String(w.modelId || '-'))}</td>
      <td><span class="badge ${statusClass}">${esc(String(w.status))}</span></td>
      <td>
        <div class="inline-gauge"><div class="gauge-fill" style="width:${(successRate * 100).toFixed(0)}%;background:${successRate >= 0.8 ? 'var(--green)' : successRate >= 0.5 ? 'var(--yellow)' : 'var(--red)'}"></div></div>
        ${(successRate * 100).toFixed(0)}%
      </td>
      <td>
        <div class="inline-gauge"><div class="gauge-fill" style="width:${(avgQuality * 100).toFixed(0)}%;background:var(--blue)"></div></div>
        ${(avgQuality * 100).toFixed(0)}%
      </td>
      <td>${taskCount}</td>
    </tr>`;
  }).join('');

  // Capability heatmap
  const heatmapHtml = renderCapabilityHeatmap();

  // Gini diversity gauge
  const giniHtml = renderGiniGauge();

  return `
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Fleet — Worker Profiles</div>
      <table class="data-table">
        <thead><tr><th>ID</th><th>Model</th><th>Status</th><th>Success Rate</th><th>Avg Quality</th><th>Tasks</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    ${heatmapHtml}
    ${giniHtml}
  `;
}

function renderCapabilityHeatmap() {
  // Collect task types across workers
  const taskTypes = new Set();
  for (const w of state.workers) {
    if (w.capabilities) {
      for (const cap of Object.keys(w.capabilities)) {
        taskTypes.add(cap);
      }
    }
  }
  if (taskTypes.size === 0) return '';

  const types = Array.from(taskTypes);
  const headerCells = state.workers.map((w) => `<th>${esc(String(w.id || w.workerId || '?').slice(0, 8))}</th>`).join('');
  const bodyRows = types.map((type) => {
    const cells = state.workers.map((w) => {
      const rate = w.capabilities?.[type]?.successRate ?? null;
      if (rate === null) return '<td class="heatmap-cell heatmap-na">—</td>';
      const color = rate >= 0.8 ? 'var(--green)' : rate >= 0.5 ? 'var(--yellow)' : 'var(--red)';
      return `<td class="heatmap-cell" style="background:${color}22;color:${color}">${(rate * 100).toFixed(0)}%</td>`;
    }).join('');
    return `<tr><td class="heatmap-label">${esc(String(type))}</td>${cells}</tr>`;
  }).join('');

  return `
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Capability Heatmap</div>
      <table class="data-table heatmap-table">
        <thead><tr><th>Task Type</th>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function renderGiniGauge() {
  // Calculate Gini coefficient from worker task counts
  const counts = state.workers.map((w) => w.taskCount ?? 0).sort((a, b) => a - b);
  if (counts.length < 2) return '';

  const n = counts.length;
  const totalTasks = counts.reduce((a, b) => a + b, 0);
  if (totalTasks === 0) return '';

  let sumOfDiffs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      sumOfDiffs += Math.abs(counts[i] - counts[j]);
    }
  }
  const gini = sumOfDiffs / (2 * n * totalTasks);
  const giniClass = gini < 0.5 ? 'gauge-green' : gini < 0.7 ? 'gauge-yellow' : 'gauge-red';

  return `
    <div class="card" style="margin-top:var(--gap);max-width:300px">
      <div class="card-title">Fleet Diversity (Gini)</div>
      <div class="card-value">${gini.toFixed(3)}</div>
      <div class="gauge ${giniClass}"><div class="gauge-fill" style="width:${(gini * 100).toFixed(0)}%"></div></div>
      <div class="card-sub">${gini < 0.5 ? 'Good diversity' : gini < 0.7 ? 'Moderate imbalance' : 'High imbalance'}</div>
    </div>
  `;
}

// ── Session History ──────────────────────────────────────────────────

function renderSessionSection() {
  if (state.sessions.length === 0) return '';

  const rows = state.sessions.slice(0, 20).map((s) => {
    const statusBadge = s.status === 'active'
      ? '<span class="badge badge-ok">active</span>'
      : s.status === 'compacted'
        ? '<span class="badge badge-info">compacted</span>'
        : `<span class="badge badge-info">${esc(String(s.status || 'unknown'))}</span>`;
    const taskCount = s.taskCount ?? s.task_count ?? '—';
    const created = s.createdAt || s.created_at;
    const timeStr = created ? formatTs(created) : '—';
    const summaryRow = s.status === 'compacted' && s.summary
      ? `<div class="session-summary">${esc(String(s.summary).slice(0, 200))}</div>`
      : '';

    return `<div class="session-card">
      <div class="session-header">
        <code>${esc(String(s.id || s.sessionId || '-'))}</code>
        ${statusBadge}
        <span class="text-dim">${taskCount} tasks</span>
        <span class="text-dim">${timeStr}</span>
      </div>
      ${summaryRow}
    </div>`;
  }).join('');

  return `
    <div class="card" style="margin-top:var(--gap)">
      <div class="card-title">Sessions (${state.sessions.length})</div>
      ${rows}
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
  const traceExplorer = renderTraceExplorer();

  if (state.events.length === 0) {
    return `${traceExplorer}<div class="card"><div class="empty-state">No events yet. Events appear when the orchestrator processes tasks.</div></div>`;
  }

  return `
    ${traceExplorer}
    <div class="card">
      <div class="card-title">Event Log (${state.events.length})</div>
      <div class="event-log">${state.events.map(renderEventEntry).join('')}</div>
    </div>
  `;
}

// ── Trace Explorer ───────────────────────────────────────────────────

function renderTraceExplorer() {
  // Collect trace-relevant events (task completions + oracle verdicts)
  const traces = state.events.filter((e) =>
    e.event === 'task:complete' || e.event === 'task:start' || e.event === 'task:escalate'
  );
  if (traces.length === 0) return '';

  // Build filter options from data
  const taskTypes = [...new Set(traces.map((t) => t.payload?.taskType || t.payload?.type || '').filter(Boolean))];
  const workers = [...new Set(traces.map((t) => t.payload?.workerId || t.payload?.worker || '').filter(Boolean))];
  const f = state.traceFilters;

  const filterBar = `
    <div class="filter-bar">
      <select onchange="state.traceFilters.taskType=this.value;render()">
        <option value="">All task types</option>
        ${taskTypes.map((t) => `<option value="${esc(t)}" ${f.taskType === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <select onchange="state.traceFilters.worker=this.value;render()">
        <option value="">All workers</option>
        ${workers.map((w) => `<option value="${esc(w)}" ${f.worker === w ? 'selected' : ''}>${esc(w)}</option>`).join('')}
      </select>
      <select onchange="state.traceFilters.outcome=this.value;render()">
        <option value="">All outcomes</option>
        <option value="pass" ${f.outcome === 'pass' ? 'selected' : ''}>Pass</option>
        <option value="fail" ${f.outcome === 'fail' ? 'selected' : ''}>Fail</option>
      </select>
      <select onchange="state.traceFilters.routingLevel=this.value;render()">
        <option value="">All levels</option>
        <option value="L0" ${f.routingLevel === 'L0' ? 'selected' : ''}>L0</option>
        <option value="L1" ${f.routingLevel === 'L1' ? 'selected' : ''}>L1</option>
        <option value="L2" ${f.routingLevel === 'L2' ? 'selected' : ''}>L2</option>
        <option value="L3" ${f.routingLevel === 'L3' ? 'selected' : ''}>L3</option>
      </select>
    </div>
  `;

  // Apply filters
  let filtered = traces;
  if (f.taskType) filtered = filtered.filter((t) => (t.payload?.taskType || t.payload?.type) === f.taskType);
  if (f.worker) filtered = filtered.filter((t) => (t.payload?.workerId || t.payload?.worker) === f.worker);
  if (f.outcome === 'pass') filtered = filtered.filter((t) => t.payload?.status === 'completed' || t.payload?.verified);
  if (f.outcome === 'fail') filtered = filtered.filter((t) => t.payload?.status === 'failed' || t.payload?.status === 'escalated');
  if (f.routingLevel) filtered = filtered.filter((t) => t.payload?.routingLevel === f.routingLevel || t.payload?.level === f.routingLevel);

  const traceRows = filtered.slice(0, 50).map((t) => {
    const p = t.payload || {};
    const taskId = String(p.taskId || p.id || '-').slice(0, 12);
    const goal = String(p.goal || '-').slice(0, 60);
    const worker = String(p.workerId || p.worker || '-');
    const outcome = p.status === 'completed' ? '<span class="badge badge-ok">pass</span>' :
      p.status === 'failed' ? '<span class="badge badge-err">fail</span>' :
        p.status === 'escalated' ? '<span class="badge badge-warn">escalated</span>' :
          `<span class="badge badge-info">${esc(String(p.status || t.event.split(':')[1] || '-'))}</span>`;
    const quality = typeof p.qualityScore === 'number' ? p.qualityScore.toFixed(2) :
      typeof p.qualityScore?.composite === 'number' ? p.qualityScore.composite.toFixed(2) : '—';
    const duration = p.durationMs ?? p.duration_ms ?? '—';
    const details = JSON.stringify(p).slice(0, 200);

    return `<tr class="trace-row" onclick="this.nextElementSibling.classList.toggle('hidden')">
      <td><code>${esc(taskId)}</code></td>
      <td title="${esc(String(p.goal || ''))}">${esc(goal)}</td>
      <td>${esc(worker)}</td>
      <td>${outcome}</td>
      <td>${esc(String(quality))}</td>
      <td>${esc(String(duration))}${typeof duration === 'number' ? 'ms' : ''}</td>
    </tr>
    <tr class="trace-detail hidden"><td colspan="6"><pre class="trace-pre">${esc(details)}</pre></td></tr>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title">Trace Explorer (${filtered.length} traces)</div>
      ${filterBar}
      <table class="data-table">
        <thead><tr><th>Task ID</th><th>Goal</th><th>Worker</th><th>Outcome</th><th>Quality</th><th>Duration</th></tr></thead>
        <tbody>${traceRows}</tbody>
      </table>
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
