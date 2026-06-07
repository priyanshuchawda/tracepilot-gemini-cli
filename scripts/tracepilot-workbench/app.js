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
  timer: null,
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
  scenarioLabel: document.querySelector('#scenario-label'),
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
  comparison: document.querySelector('#comparison-view'),
  blindStream: document.querySelector('#blind-stream'),
  traceStream: document.querySelector('#trace-stream'),
  blindStatus: document.querySelector('#blind-status'),
  traceStatus: document.querySelector('#trace-status'),
  blindTimer: document.querySelector('#blind-timer'),
  traceTimer: document.querySelector('#trace-timer'),
  fairnessModel: document.querySelector('#fairness-model'),
  fairnessPrompt: document.querySelector('#fairness-prompt'),
  fairnessWorkspace: document.querySelector('#fairness-workspace'),
  fairnessBudget: document.querySelector('#fairness-budget'),
  comparisonVerdict: document.querySelector('#comparison-verdict'),
  comparisonSummaryVerdict: document.querySelector(
    '#comparison-summary-verdict',
  ),
  rubricGrid: document.querySelector('#rubric-grid'),
  bugMatrix: document.querySelector('#bug-matrix'),
  bugCheckCount: document.querySelector('#bug-check-count'),
  arizeSpanCount: document.querySelector('#arize-span-count'),
  arizeFinding: document.querySelector('#arize-finding'),
  arizeDetail: document.querySelector('#arize-detail'),
  arizeMisses: document.querySelector('#arize-misses'),
  arizeAttempts: document.querySelector('#arize-attempts'),
  arizeBoundary: document.querySelector('#arize-boundary'),
  runButtonLabel: document.querySelector('#run-button-label'),
  metrics: {
    blind: {
      accuracy: document.querySelector('#blind-accuracy'),
      hits: document.querySelector('#blind-hits'),
      speed: document.querySelector('#blind-speed'),
      score: document.querySelector('#blind-score'),
      result: document.querySelector('#result-blind-score'),
      summaryScore: document.querySelector('#summary-blind-score'),
      summaryAccuracy: document.querySelector('#summary-blind-accuracy'),
      summaryHits: document.querySelector('#summary-blind-hits'),
      summaryTime: document.querySelector('#summary-blind-time'),
    },
    tracepilot: {
      accuracy: document.querySelector('#trace-accuracy'),
      hits: document.querySelector('#trace-hits'),
      speed: document.querySelector('#trace-speed'),
      score: document.querySelector('#trace-score'),
      result: document.querySelector('#result-trace-score'),
      summaryScore: document.querySelector('#summary-trace-score'),
      summaryAccuracy: document.querySelector('#summary-trace-accuracy'),
      summaryHits: document.querySelector('#summary-trace-hits'),
      summaryTime: document.querySelector('#summary-trace-time'),
    },
  },
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
    } else {
      updateLayout();
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

elements.scenario.addEventListener('change', () => {
  updateScenarioLabel();
  updateLayout();
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
    startTimer(run.createdAt);
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
  resetComparison();
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
  elements.scenario.value = run.scenario;
  updateScenarioLabel();
  updateLayout();
  renderActivity(run.prompt);
  updateEvidence(run);
  setBusy(run.status === 'queued' || run.status === 'running');
  if (isRunning()) {
    startTimer(run.createdAt);
    subscribe(run.id);
  } else {
    stopTimer();
  }
}

function renderActivity(prompt = '') {
  if (isComparison()) {
    renderComparison();
    return;
  }
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

function renderComparison() {
  const blindEvents = state.events.filter(
    (event) => event.data?.arm === 'blind',
  );
  const traceEvents = state.events.filter(
    (event) =>
      event.data?.arm === 'tracepilot' || event.data?.arm === 'trace_assisted',
  );
  elements.blindStream.innerHTML = blindEvents.length
    ? blindEvents.map(renderEvent).join('')
    : '<p class="muted">Waiting for Gemini.</p>';
  elements.traceStream.innerHTML = traceEvents.length
    ? traceEvents.map(renderEvent).join('')
    : '<p class="muted">Waiting for TracePilot.</p>';
  elements.blindStream.scrollTop = elements.blindStream.scrollHeight;
  elements.traceStream.scrollTop = elements.traceStream.scrollHeight;
  updateArmStatus('blind', blindEvents);
  updateArmStatus('tracepilot', traceEvents);
  updateComparisonResult(state.activeRun?.result);
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
  const assistedArm = Array.isArray(result.arms)
    ? result.arms.find((arm) => arm.arm === 'trace_assisted')
    : undefined;
  const changedFiles = Array.isArray(repair.changedFiles)
    ? repair.changedFiles
    : Array.isArray(assistedArm?.changedFiles)
      ? assistedArm.changedFiles
      : [];
  const proofLevel =
    result.proofLevel ??
    result.outcome ??
    findEventDetail('Proof level') ??
    '—';
  const session =
    result.sessionId ??
    result.promptSha256 ??
    findEventDetail('Trace session') ??
    '—';
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
  if (isComparison()) {
    updateComparisonResult(result);
  }
}

function updateEvidenceFromEvents() {
  const gates = [
    ['Safety', 'Safety gate'],
    ['Retry', 'Verification retry'],
    ['Stress', 'Repeated stress verification'],
    ['Blind', 'Blind arm'],
    ['Trace', 'Trace-assisted arm'],
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
  if (!busy) {
    stopTimer();
  }
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

function updateScenarioLabel() {
  const labels = {
    'checkout-service': 'Checkout webhook repair',
    'idempotency-race': 'Duplicate settlement race',
    'trace-ablation': 'Measured blind vs trace comparison',
  };
  elements.scenarioLabel.textContent =
    labels[elements.scenario.value] ?? 'TracePilot repair';
}

function updateLayout() {
  const comparison = isComparison();
  document.body.classList.toggle('comparison-mode', comparison);
  elements.activity.classList.toggle('hidden', comparison);
  elements.comparison.classList.toggle('hidden', !comparison);
  elements.runButtonLabel.textContent = comparison
    ? 'Run comparison'
    : 'Run repair';
  elements.input.placeholder = comparison
    ? 'Describe the production incident to both agents...'
    : 'Describe the bug or repair outcome...';
  if (comparison) {
    renderComparison();
  }
}

function isComparison() {
  return elements.scenario.value === 'trace-ablation';
}

function updateArmStatus(arm, events) {
  const element = arm === 'blind' ? elements.blindStatus : elements.traceStatus;
  const latest = [...events].reverse().find((event) => event.status);
  const active = isRunning();
  const value = latest?.status ?? (active ? 'running' : 'waiting');
  element.className = `activity-status ${escapeHtml(value)}`;
  element.textContent = titleCase(value);
}

function updateComparisonResult(result) {
  const arms = Array.isArray(result?.arms) ? result.arms : [];
  const blind = arms.find((arm) => arm.arm === 'blind');
  const tracepilot = arms.find(
    (arm) => arm.arm === 'tracepilot' || arm.arm === 'trace_assisted',
  );
  updateArmMetrics('blind', blind);
  updateArmMetrics('tracepilot', tracepilot);
  if (!result) {
    renderRubric();
    renderBugMatrix();
    renderArizeEvidence(findTraceEvidenceFromEvents());
    return;
  }
  elements.fairnessModel.textContent = `Model · ${result.model ?? 'same'}`;
  elements.fairnessPrompt.textContent = `Prompt · ${shortHash(result.promptSha256)}`;
  elements.fairnessWorkspace.textContent = `Source · ${shortHash(result.fixtureSha256)}`;
  elements.fairnessBudget.textContent = `${Math.round((result.budgetMs ?? 0) / 1000)}s shared deadline`;
  const winner = result.winner ?? inferWinner(blind, tracepilot);
  const verdict =
    winner === 'tracepilot'
      ? 'TracePilot solves more production invariants'
      : winner === 'blind'
        ? 'Gemini CLI wins this measured run'
        : 'Measured run ends in a tie';
  elements.comparisonVerdict.textContent = verdict;
  elements.comparisonSummaryVerdict.textContent = verdict;
  renderRubric(result.rubric, blind?.hiddenAfter?.total);
  renderBugMatrix(blind, tracepilot);
  renderArizeEvidence(result.traceEvidence ?? findTraceEvidenceFromEvents());
}

function updateArmMetrics(name, arm) {
  const metricElements = elements.metrics[name];
  const metrics = arm?.metrics;
  metricElements.accuracy.textContent = metrics
    ? `${metrics.accuracyPercent}%`
    : '—';
  metricElements.hits.textContent = metrics
    ? `${metrics.bugHits} / ${metrics.bugMisses}`
    : '—';
  metricElements.speed.textContent = metrics ? `${metrics.speed}/15` : '—';
  metricElements.score.textContent = metrics ? `${metrics.total}/100` : '—';
  metricElements.result.textContent = metrics ? `${metrics.total}` : '—';
  metricElements.summaryScore.textContent = metrics
    ? `${metrics.total}/100`
    : '—';
  metricElements.summaryAccuracy.textContent = metrics
    ? `${metrics.accuracyPercent}%`
    : '—';
  metricElements.summaryHits.textContent = metrics
    ? `${metrics.bugHits}/${metrics.bugMisses}`
    : '—';
  if (arm?.agent?.durationMs !== undefined) {
    const timer = name === 'blind' ? elements.blindTimer : elements.traceTimer;
    const duration = formatDuration(arm.agent.durationMs);
    timer.textContent = duration;
    metricElements.summaryTime.textContent = duration;
  } else {
    metricElements.summaryTime.textContent = '—';
  }
}

function renderRubric(rubric, hiddenTotal = 3) {
  const correctness = Number(rubric?.correctness ?? 60);
  const regressionSafety = Number(rubric?.regressionSafety ?? 15);
  const patchDiscipline = Number(rubric?.patchDiscipline ?? 10);
  const speed = Number(rubric?.speed ?? 15);
  const perCheck = Math.round(correctness / Math.max(1, hiddenTotal));
  const rows = [
    [`${correctness}`, `${hiddenTotal} hidden invariants, ${perCheck} each`],
    [`${regressionSafety}`, 'Public tests must keep passing'],
    [`${patchDiscipline}`, 'Source/test changes only, focused patch'],
    [`${speed}`, 'Only awarded after full correctness'],
  ];
  elements.rubricGrid.innerHTML = rows
    .map(
      ([points, label]) =>
        `<div><b>${escapeHtml(points)}</b><span>${escapeHtml(label)}</span></div>`,
    )
    .join('');
}

function renderBugMatrix(blind, tracepilot) {
  const blindChecks = blind?.hiddenAfter?.checks ?? [];
  const traceChecks = tracepilot?.hiddenAfter?.checks ?? [];
  const ids = [
    ...new Set([...blindChecks, ...traceChecks].map((check) => check.id)),
  ];
  elements.bugCheckCount.textContent = ids.length
    ? `${ids.length} hidden production bugs`
    : 'Awaiting evaluator';
  elements.bugMatrix.innerHTML = ids.length
    ? ids
        .map((id) => {
          const blindCheck = blindChecks.find((check) => check.id === id);
          const traceCheck = traceChecks.find((check) => check.id === id);
          return `<div class="bug-row">
            <span>${escapeHtml(hiddenCheckLabel(id))}</span>
            ${renderCheckBadge('Gemini', blindCheck)}
            ${renderCheckBadge('TracePilot', traceCheck)}
          </div>`;
        })
        .join('')
    : '<p class="muted">No hidden results yet.</p>';
}

function renderArizeEvidence(traceEvidence) {
  if (!traceEvidence) {
    elements.arizeSpanCount.textContent = 'Awaiting trace';
    elements.arizeFinding.textContent = 'No trace evidence yet';
    elements.arizeDetail.textContent =
      'TracePilot waits for production evidence before ranking likely fixes.';
    elements.arizeMisses.textContent = '—';
    elements.arizeAttempts.textContent = '—';
    elements.arizeBoundary.textContent = '—';
    return;
  }
  elements.arizeSpanCount.textContent = `${traceEvidence.spanCount ?? 0} spans`;
  elements.arizeFinding.textContent = titleCase(
    String(traceEvidence.finding ?? 'production trace'),
  );
  elements.arizeDetail.textContent =
    traceEvidence.detail ??
    traceEvidence.invariant ??
    'Production trace narrowed the repair boundary.';
  elements.arizeMisses.textContent = String(traceEvidence.repeatedMisses ?? 0);
  elements.arizeAttempts.textContent = String(
    traceEvidence.providerAttempts ?? 0,
  );
  elements.arizeBoundary.textContent =
    traceEvidence.requiredBoundary ?? 'Shared repair boundary';
}

function findTraceEvidenceFromEvents() {
  return [...state.events].reverse().find((event) => event.data?.traceEvidence)
    ?.data.traceEvidence;
}

function renderCheckBadge(label, check) {
  const status = check?.status ?? 'waiting';
  const title = check?.reason ? ` title="${escapeHtml(check.reason)}"` : '';
  return `<b class="${escapeHtml(status)}"${title}>${escapeHtml(label)} ${escapeHtml(titleCase(status))}</b>`;
}

function hiddenCheckLabel(id) {
  const labels = {
    cross_worker_atomicity: 'Cross-worker duplicate charge',
    failed_reservation_released: 'Failed reservation retry recovery',
    payload_conflict_rejected: 'Payload conflict rejection',
  };
  return labels[id] ?? titleCase(String(id).replaceAll('_', ' '));
}

function resetComparison() {
  stopTimer();
  elements.blindStream.innerHTML =
    '<p class="muted">Waiting for comparison.</p>';
  elements.traceStream.innerHTML =
    '<p class="muted">Waiting for comparison.</p>';
  elements.comparisonVerdict.textContent = 'Awaiting both agents';
  elements.comparisonSummaryVerdict.textContent = 'Awaiting both agents';
  renderRubric();
  renderBugMatrix();
  renderArizeEvidence();
  elements.blindStatus.className = 'activity-status';
  elements.traceStatus.className = 'activity-status';
  elements.blindStatus.textContent = 'Waiting';
  elements.traceStatus.textContent = 'Waiting';
  for (const arm of ['blind', 'tracepilot']) {
    updateArmMetrics(arm);
  }
  elements.blindTimer.textContent = '00:00';
  elements.traceTimer.textContent = '00:00';
}

function startTimer(createdAt) {
  stopTimer();
  const started = new Date(createdAt).getTime();
  const tick = () => {
    const value = formatDuration(Date.now() - started);
    if (!state.activeRun?.result?.arms) {
      elements.blindTimer.textContent = value;
      elements.traceTimer.textContent = value;
    }
  };
  tick();
  state.timer = setInterval(tick, 500);
}

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function shortHash(value) {
  return value ? String(value).slice(0, 8) : 'pending';
}

function inferWinner(blind, tracepilot) {
  const blindScore = blind?.metrics?.total ?? 0;
  const traceScore = tracepilot?.metrics?.total ?? 0;
  if (blindScore === traceScore) return 'tie';
  return blindScore > traceScore ? 'blind' : 'tracepilot';
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
