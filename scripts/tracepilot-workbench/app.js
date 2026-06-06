/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* global document, EventSource */

const state = {
  mode: 'controlled',
  liveReady: false,
  activeRun: null,
  events: [],
  source: null,
  runs: [],
};

const elements = {
  activity: document.querySelector('#activity-stream'),
  empty: document.querySelector('#empty-state'),
  form: document.querySelector('#task-form'),
  input: document.querySelector('#task-input'),
  runButton: document.querySelector('#run-button'),
  cancelButton: document.querySelector('#cancel-button'),
  modeButtons: [...document.querySelectorAll('.mode-button')],
  modeIndicator: document.querySelector('#mode-indicator'),
  scenario: document.querySelector('#scenario-select'),
  runsList: document.querySelector('#runs-list'),
  runTitle: document.querySelector('#run-title'),
  refreshButton: document.querySelector('#refresh-button'),
  newRunButton: document.querySelector('#new-run-button'),
  proofBadge: document.querySelector('#proof-badge'),
  factStatus: document.querySelector('#fact-status'),
  factMode: document.querySelector('#fact-mode'),
  factSession: document.querySelector('#fact-session'),
  factProof: document.querySelector('#fact-proof'),
  fileCount: document.querySelector('#file-count'),
  changedFiles: document.querySelector('#changed-files'),
  gateList: document.querySelector('#gate-list'),
  connection: document.querySelector('#connection-status'),
};

await initialize();

async function initialize() {
  try {
    const status = await api('/api/status');
    state.liveReady = status.liveReady === true;
    const liveButton = elements.modeButtons.find(
      (button) => button.dataset.mode === 'live',
    );
    liveButton.disabled = !state.liveReady;
    liveButton.title = state.liveReady
      ? 'Use live Gemini and Phoenix evidence'
      : 'Live mode requires Gemini and Phoenix environment configuration';
    elements.connection.lastChild.textContent = state.liveReady
      ? ' Live ready'
      : ' Local';
    await refreshRuns();
    if (state.runs[0]) {
      await loadRun(state.runs[0].id);
    }
  } catch {
    elements.connection.lastChild.textContent = ' Offline';
    elements.connection.querySelector('.connection-dot').style.background =
      'var(--red)';
  }
}

elements.modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled || isRunning()) {
      return;
    }
    state.mode = button.dataset.mode;
    elements.modeButtons.forEach((candidate) =>
      candidate.classList.toggle('active', candidate === button),
    );
    elements.modeIndicator.textContent =
      state.mode === 'live' ? 'Live Gemini + Phoenix' : 'Controlled proof';
    elements.factMode.textContent =
      state.mode === 'live' ? 'Live' : 'Controlled';
  });
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = elements.input.value.trim();
  if (prompt.length < 8 || isRunning()) {
    return;
  }
  setBusy(true);
  resetEvidence();
  state.events = [];
  renderActivity(prompt);
  try {
    const run = await api('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        mode: state.mode,
        scenario: elements.scenario.value,
      }),
    });
    state.activeRun = run;
    elements.runTitle.textContent = prompt;
    elements.factStatus.textContent = titleCase(run.status);
    elements.factMode.textContent = titleCase(run.mode);
    subscribe(run.id);
    await refreshRuns();
  } catch (error) {
    state.events.push({
      type: 'error',
      title: 'Could not start run',
      detail: error.message,
      status: 'fail',
      at: new Date().toISOString(),
    });
    renderActivity(prompt);
    setBusy(false);
  }
});

elements.cancelButton.addEventListener('click', async () => {
  if (!state.activeRun) {
    return;
  }
  await api(`/api/runs/${state.activeRun.id}/cancel`, { method: 'POST' });
  state.source?.close();
  setBusy(false);
  await loadRun(state.activeRun.id);
});

elements.refreshButton.addEventListener('click', refreshRuns);
elements.newRunButton.addEventListener('click', () => {
  state.source?.close();
  state.activeRun = null;
  state.events = [];
  elements.input.value = '';
  elements.runTitle.textContent = 'New repair';
  resetEvidence();
  renderActivity();
  setBusy(false);
});

function subscribe(runId) {
  state.source?.close();
  const source = new EventSource(`/api/runs/${runId}/events`);
  state.source = source;
  source.addEventListener('event', (message) => {
    state.events.push(JSON.parse(message.data));
    renderActivity(state.activeRun?.prompt);
    updateEvidenceFromEvents();
  });
  source.addEventListener('done', async (message) => {
    state.activeRun = JSON.parse(message.data);
    source.close();
    setBusy(false);
    await loadRun(runId);
    await refreshRuns();
  });
  source.onerror = () => {
    source.close();
    if (isRunning()) {
      setBusy(false);
    }
  };
}

async function refreshRuns() {
  state.runs = await api('/api/runs');
  elements.runsList.innerHTML = state.runs.length
    ? state.runs.map(renderRunListItem).join('')
    : '<p class="muted">No runs yet.</p>';
  elements.runsList.querySelectorAll('.run-list-item').forEach((button) => {
    button.addEventListener('click', () => loadRun(button.dataset.id));
  });
}

async function loadRun(runId) {
  state.source?.close();
  const run = await api(`/api/runs/${runId}`);
  state.activeRun = run;
  state.events = run.events ?? [];
  state.mode = run.mode;
  elements.modeButtons.forEach((button) =>
    button.classList.toggle('active', button.dataset.mode === run.mode),
  );
  elements.runTitle.textContent = run.prompt;
  elements.input.value = run.prompt;
  renderActivity(run.prompt);
  updateEvidence(run);
  setBusy(run.status === 'queued' || run.status === 'running');
  if (isRunning()) {
    subscribe(run.id);
  }
}

function renderActivity(prompt = '') {
  if (!prompt && state.events.length === 0) {
    elements.activity.innerHTML = elements.empty.outerHTML;
    return;
  }
  const user = prompt
    ? `<article class="user-message">${escapeHtml(prompt)}</article>`
    : '';
  elements.activity.innerHTML = user + state.events.map(renderEvent).join('');
  elements.activity.scrollTop = elements.activity.scrollHeight;
}

function renderEvent(event) {
  const icons = {
    status: 'S',
    reasoning: 'P',
    tool: 'T',
    evidence: 'E',
    result: '✓',
    error: '!',
  };
  const status = event.status
    ? `<span class="activity-status ${escapeHtml(event.status)}">${escapeHtml(event.status)}</span>`
    : '';
  return `<article class="activity-item ${escapeHtml(event.type)}">
    <div class="activity-icon">${icons[event.type] ?? '·'}</div>
    <div class="activity-copy">
      <h3>${escapeHtml(event.title)}</h3>
      ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ''}
    </div>
    <div>
      ${status}
      <div class="activity-time">${formatTime(event.at)}</div>
    </div>
  </article>`;
}

function renderRunListItem(run) {
  return `<button class="run-list-item ${state.activeRun?.id === run.id ? 'active' : ''}" data-id="${escapeHtml(run.id)}">
    <strong>${escapeHtml(run.prompt)}</strong>
    <span class="run-list-meta">
      <span><i class="status-dot ${escapeHtml(run.status)}"></i>${escapeHtml(titleCase(run.status))}</span>
      <small>${formatTime(run.createdAt)}</small>
    </span>
  </button>`;
}

function updateEvidence(run = state.activeRun) {
  if (!run) {
    resetEvidence();
    return;
  }
  elements.factStatus.textContent = titleCase(run.status);
  elements.factMode.textContent = titleCase(run.mode);
  const result = run.result ?? {};
  const repair = result.repair ?? {};
  const changedFiles = Array.isArray(repair.changedFiles)
    ? repair.changedFiles
    : [];
  const proofLevel = result.proofLevel ?? findEventDetail('Proof level') ?? '—';
  const session = result.sessionId ?? findEventDetail('Trace session') ?? '—';
  elements.factProof.textContent = proofLevel;
  elements.factSession.textContent = session;
  elements.fileCount.textContent = String(changedFiles.length);
  elements.changedFiles.innerHTML = changedFiles.length
    ? changedFiles
        .map((file) => `<div class="file-row">${escapeHtml(file)}</div>`)
        .join('')
    : '<p class="muted">No patch yet.</p>';
  const proofClass =
    result.strictLiveProof === true
      ? 'pass'
      : run.status === 'failed'
        ? 'fail'
        : proofLevel !== '—'
          ? 'warn'
          : 'neutral';
  elements.proofBadge.className = `proof-badge ${proofClass}`;
  elements.proofBadge.textContent =
    proofLevel === '—' ? 'Waiting' : proofLevel.replaceAll('_', ' ');
  updateEvidenceFromEvents();
}

function updateEvidenceFromEvents() {
  const gates = [
    ['Safety', 'Safety gate'],
    ['Retry', 'Verification retry'],
    ['Evals', 'Deterministic evals'],
    ['Phoenix', 'Phoenix MCP introspection'],
  ];
  elements.gateList.innerHTML = gates
    .map(([label, eventTitle]) => {
      const event = [...state.events]
        .reverse()
        .find((item) => item.title === eventTitle);
      const value = event?.status ?? 'waiting';
      return `<div class="gate-row"><span>${label}</span><b class="${escapeHtml(value)}">${escapeHtml(value)}</b></div>`;
    })
    .join('');
  const session = findEventDetail('Trace session');
  const proof = findEventDetail('Proof level');
  if (session) {
    elements.factSession.textContent = session;
  }
  if (proof) {
    elements.factProof.textContent = proof;
  }
}

function resetEvidence() {
  elements.factStatus.textContent = 'Idle';
  elements.factMode.textContent = titleCase(state.mode);
  elements.factSession.textContent = '—';
  elements.factProof.textContent = '—';
  elements.fileCount.textContent = '0';
  elements.changedFiles.innerHTML = '<p class="muted">No patch yet.</p>';
  elements.proofBadge.className = 'proof-badge neutral';
  elements.proofBadge.textContent = 'Waiting';
  updateEvidenceFromEvents();
}

function setBusy(busy) {
  elements.runButton.disabled = busy;
  elements.input.disabled = busy;
  elements.scenario.disabled = busy;
  elements.modeButtons.forEach((button) => {
    button.disabled =
      busy || (button.dataset.mode === 'live' && !state.liveReady);
  });
  elements.cancelButton.classList.toggle('hidden', !busy);
}

function isRunning() {
  return (
    state.activeRun?.status === 'queued' ||
    state.activeRun?.status === 'running' ||
    elements.runButton.disabled
  );
}

function findEventDetail(title) {
  return [...state.events].reverse().find((event) => event.title === title)
    ?.detail;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? 'Request failed.');
  }
  return payload;
}

function titleCase(value) {
  return String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTime(value) {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
