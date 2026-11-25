// U08 multi-connection stress: real isolated gateway HTTP + scripted loopback upstreams.
// No application-source edits, real credentials, external network, downloads, or port 8787.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startGateway, startScriptedUpstream, root } from './harness.mjs'

const REPORT_PATH = join(root, 'docs/evidence/v13.1-r2/connection-stress-report.json')
const SUITE_BUDGET_MS = 90_000
const REQUEST_BUDGET_MS = 10_000
const startedAt = new Date().toISOString()
const startedMs = Date.now()
const ports = new Set()
const report = {
  schemaVersion: 1,
  suite: 'U08 multi-connection stress',
  requirement: '并发与排队、限流、熔断半开、回切、连接异常；无惊群、无失控重试、恢复后安全回切；区分逻辑与尝试',
  status: 'RUNNING',
  startedAt,
  finishedAt: null,
  durationMs: null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    branch: '',
    commitSha: '',
    sourceSha256: {},
  },
  command: 'npm test -- v13-connection-stress',
  boundaries: {
    testType: 'REAL_HTTP_MOCK',
    gateway: 'isolated child process from existing harness',
    upstream: 'scripted loopback HTTP mock',
    keys: 'fictional per-connection environment keys',
    externalNetwork: false,
    downloads: 0,
    port8787Touched: false,
    appSourceEdits: false,
  },
  thresholds: {
    minimumConnections: 40,
    stressProviders: 8,
    stressConnectionsPerProvider: 5,
    stressConcurrentLogicalRequests: 40,
    independentSlotCapacities: [1, 2, 3],
    independentSlotLogicalRequests: 12,
    cooldownRetryAfterMs: 1000,
    overBudgetRetryAfterMs: 5000,
    overBudgetOverallMs: 700,
    circuitCooldownMs: 300,
    halfOpenConcurrentLogicalRequests: 20,
    maximumHalfOpenUpstreamProbes: 1,
    cancelledQueuedUpstreamAttempts: 0,
  },
  scenarios: [],
  totals: null,
  failures: [],
}

try {
  report.environment.branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
  report.environment.commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  for (const file of ['src/forward.js', 'src/resources/connections.js', 'src/resources/request-ledger.js', 'scripts/test/offline/harness.mjs', 'scripts/test/offline/v13-connection-stress.test.mjs', 'scripts/test/run.mjs']) {
    report.environment.sourceSha256[file] = createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
  }
} catch (error) {
  report.environment.evidenceError = String(error && error.message || error)
}

const watchdog = setTimeout(() => {
  report.status = 'TIMEOUT'
  report.finishedAt = new Date().toISOString()
  report.durationMs = Date.now() - startedMs
  report.failures.push({ scenario: 'suite', check: 'bounded_runtime', message: 'suite exceeded ' + SUITE_BUDGET_MS + 'ms' })
  try { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n') } catch {}
  process.exit(124)
}, SUITE_BUDGET_MS)
watchdog.unref()

after(() => {
  clearTimeout(watchdog)
  report.finishedAt = new Date().toISOString()
  report.durationMs = Date.now() - startedMs
  report.boundaries.port8787Touched = ports.has(8787)
  const scenarios = report.scenarios
  const checks = scenarios.flatMap((scenario) => scenario.checks)
  report.totals = {
    scenarios: scenarios.length,
    passedScenarios: scenarios.filter((scenario) => scenario.status === 'PASS').length,
    failedScenarios: scenarios.filter((scenario) => scenario.status === 'FAIL').length,
    checks: checks.length,
    passedChecks: checks.filter((check) => check.passed).length,
    failedChecks: checks.filter((check) => !check.passed).length,
    logicalRequests: scenarios.reduce((sum, scenario) => sum + (scenario.observations.accounting?.logicalRequests || 0), 0),
    upstreamAttempts: scenarios.reduce((sum, scenario) => sum + (scenario.observations.accounting?.upstreamAttempts || 0), 0),
  }
  report.failures = scenarios.flatMap((scenario) => [
    ...scenario.checks.filter((check) => !check.passed).map((check) => ({ scenario: scenario.id, check: check.name, expected: check.expected, actual: check.actual, threshold: check.threshold })),
    ...(scenario.error ? [{ scenario: scenario.id, check: 'scenario_exception', message: scenario.error }] : []),
  ])
  report.status = report.totals.failedScenarios === 0 && report.totals.scenarios === 7 && !report.boundaries.port8787Touched ? 'PASS' : 'FAIL'
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n')
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pad2 = (value) => String(value).padStart(2, '0')
const chatOk = (content = 'pong') => JSON.stringify({
  id: 'u08-mock',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

function makeGate() {
  let release
  const promise = new Promise((resolve) => { release = resolve })
  return { promise, release: () => release() }
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(message + ' (bounded wait ' + timeoutMs + 'ms)')
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function responseSummary(response, body) {
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    errorCode: body?.error?.code ?? null,
    errorType: body?.error?.type ?? null,
    attempts: body?.error?.attempts ?? null,
    retryAfterMs: body?.error?.retry_after_ms ?? null,
  }
}

async function postChat(gw, model, marker, options = {}) {
  const controller = options.controller || new AbortController()
  const timeout = options.timeoutMs || REQUEST_BUDGET_MS
  const timer = setTimeout(() => controller.abort(new Error('u08 client timeout')), timeout)
  try {
    const response = await fetch(gw.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'u08-' + marker },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: marker }] }),
      signal: controller.signal,
    })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    return { response, body, summary: responseSummary(response, body) }
  } finally {
    clearTimeout(timer)
  }
}

async function counters(gw) {
  return (await (await gw.get('/api/status')).json()).counters
}

function deltaCounters(before, after, upstreamAttempts) {
  return {
    logicalRequests: after.logicalRequests - before.logicalRequests,
    upstreamAttempts,
    gatewayRequestCounter: after.requests - before.requests,
    completedRequests: after.completedRequests - before.completedRequests,
    errors: after.errors - before.errors,
    retries: after.retries - before.retries,
  }
}

function check(scenario, name, condition, expected, actual, threshold) {
  scenario.checks.push({ name, passed: !!condition, expected, actual, threshold })
}

function exact(scenario, name, actual, expected, threshold) {
  check(scenario, name, JSON.stringify(actual) === JSON.stringify(expected), expected, actual, threshold)
}

function finishScenario(scenario) {
  const failed = scenario.checks.filter((item) => !item.passed)
  if (failed.length) {
    throw new Error('U08 failed checks: ' + failed.map((item) => item.name + ' expected=' + JSON.stringify(item.expected) + ' actual=' + JSON.stringify(item.actual)).join(' | '))
  }
}

async function runScenario(t, id, name, fn) {
  const scenario = { id, name, status: 'RUNNING', checks: [], observations: {}, error: null }
  report.scenarios.push(scenario)
  let assertionFailure = false
  try {
    await fn(scenario)
    scenario.status = scenario.checks.some((item) => !item.passed) ? 'FAIL' : 'PASS'
    assertionFailure = scenario.status === 'FAIL'
    finishScenario(scenario)
  } catch (error) {
    scenario.status = 'FAIL'
    if (!assertionFailure) scenario.error = String(error && error.message || error)
    throw error
  }
}

function connection(providerId, index, overrides = {}) {
  const suffix = providerId.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + pad2(index)
  const connectionId = 'conn_u08_' + suffix + '_' + 'a'.repeat(16)
  return {
    connectionId,
    credentialKeyId: connectionId,
    displayName: 'U08 ' + providerId + ' #' + (index + 1),
    enabled: true,
    priority: 0,
    maxConcurrent: 1,
    quotaScopeId: '',
    authDomain: '',
    modelIds: [],
    apiKeyEnv: 'MG_U08_KEY_' + suffix,
    ...overrides,
  }
}

async function fixture(t, name, providerSpecs, models, handler, options = {}) {
  const credentialToConnection = new Map()
  const upstream = await startScriptedUpstream(async (req, res, rec) => {
    rec.connectionId = credentialToConnection.get(req.headers.authorization) || null
    rec.providerId = providerFromUrl(req.url)
    await handler(req, res, rec)
  })
  let gw = null
  try {
    const env = { MG_TEST_NOW: '' }
    const providers = {}
    for (const [providerId, spec] of Object.entries(providerSpecs)) {
      providers[providerId] = {
        baseUrl: upstream.base,
        pathPrefix: '/providers/' + providerId,
        api: 'openai',
        proxy: 'direct',
        circuit: { maxFailures: 100, openDurationMs: 300 },
        ...(spec.provider || {}),
        connections: spec.connections,
      }
      for (const item of spec.connections) {
        const key = 'fictional-u08-' + providerId + '-' + item.connectionId.slice(-20)
        env[item.apiKeyEnv] = key
        credentialToConnection.set('Bearer ' + key, item.connectionId)
      }
    }
    const defaults = {
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      timeout: { connectMs: 1000, firstByteMs: 3000, idleMs: 3000, loopMs: 1000, overallMs: options.overallMs || 5000 },
      requestBudget: { maxTotalAttempts: 80, maxFailovers: 80, maxAttemptsPerCandidate: 80, maxWaitMs: options.maxWaitMs || 1000 },
      concurrency: { maxPerProvider: 100 },
      affinityTtlMs: 0,
      failbackProbe: { enabled: false },
      preheat: [],
      directory: [],
      proxyMode: 'direct',
      ...(options.defaults || {}),
    }
    gw = await startGateway({ name: 'u08-' + name, config: { defaults, providers, models, virtualModels: [] }, env })
    ports.add(gw.port)
    ports.add(upstream.port)
    assert.notEqual(gw.port, 8787, 'gateway must not use production port 8787')
    assert.notEqual(upstream.port, 8787, 'mock upstream must not use production port 8787')
    t.after(async () => {
      if (gw) await gw.stop()
      await upstream.stop()
    })
    return { gw, upstream }
  } catch (error) {
    if (gw) await gw.stop()
    await upstream.stop()
    throw error
  }
}

function providerFromUrl(url) {
  return String(url || '').split('/')[2] || ''
}

function countBy(values) {
  const out = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return out
}

// 1. Forty real configured connections across eight providers, all concurrently in flight.
test('U08-01 40 connections across providers sustain independent concurrent HTTP requests', { timeout: 25_000 }, async (t) => {
  await runScenario(t, 'U08-01', '40-connection concurrent stress', async (scenario) => {
    const gate = makeGate()
    const providerSpecs = {}
    const models = {}
    for (let p = 0; p < 8; p++) {
      const providerId = 'stress-p' + p
      providerSpecs[providerId] = { connections: Array.from({ length: 5 }, (_, i) => connection(providerId, i, { maxConcurrent: 1 })) }
      models['stress-m' + p] = { provider: providerId, fallbacks: [], maxConcurrent: 0 }
    }
    const { gw, upstream } = await fixture(t, 'forty', providerSpecs, models, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      await gate.promise
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk()) }
    })
    const listed = await (await gw.get('/api/connections')).json()
    exact(scenario, 'api_exposes_40_connections', listed.items.length, 40, 'exactly 40 configured connections')
    exact(scenario, 'all_connection_credentials_configured', listed.items.filter((item) => item.credentialConfigured).length, 40, 'all 40 use isolated fictional keys')
    exact(scenario, 'connections_span_8_providers', new Set(listed.items.map((item) => item.providerId)).size, 8, '8 providers')

    const before = await counters(gw)
    const requests = []
    for (let p = 0; p < 8; p++) {
      const providerId = 'stress-p' + p
      for (let i = 0; i < 5; i++) {
        const conn = providerSpecs[providerId].connections[i]
        requests.push(postChat(gw, 'stress-m' + p, conn.connectionId))
      }
    }
    await waitFor(() => upstream.hits.filter((hit) => hit.body).length === 40, 8000, '40 upstream requests did not reach the gate')
    const active = upstream.hits.filter((hit) => hit.body)
    const byConnection = countBy(active.map((hit) => hit.connectionId))
    const byProvider = countBy(active.map((hit) => hit.providerId))
    scenario.observations.gatedInFlight = {
      upstreamAttempts: active.length,
      uniqueConnections: Object.keys(byConnection).length,
      maxInFlightPerConnection: Math.max(...Object.values(byConnection)),
      connectionsPerProvider: byProvider,
    }
    exact(scenario, 'all_40_connections_concurrently_in_flight', active.length, 40, '40 gated upstream attempts')
    exact(scenario, 'all_40_connection_ids_unique', Object.keys(byConnection).length, 40, 'no connection reuse while its single slot is occupied')
    exact(scenario, 'no_connection_exceeds_maxConcurrent_1', Math.max(...Object.values(byConnection)), 1, 'per-connection maxConcurrent=1')
    exact(scenario, 'each_provider_has_5_independent_slots', Object.fromEntries(Object.entries(byProvider).map(([key, value]) => [key, value])), Object.fromEntries(Array.from({ length: 8 }, (_, p) => ['stress-p' + p, 5])), '5 simultaneous slots per provider')

    gate.release()
    const results = await Promise.all(requests)
    exact(scenario, 'all_40_logical_requests_succeed', results.filter((result) => result.response.status === 200).length, 40, '40 HTTP 200 responses')
    const after = await counters(gw)
    scenario.observations.accounting = deltaCounters(before, after, upstream.hits.length)
    exact(scenario, 'logical_equals_upstream_40', scenario.observations.accounting, { logicalRequests: 40, upstreamAttempts: 40, gatewayRequestCounter: 40, completedRequests: 40, errors: 0, retries: 0 }, 'exact logical/upstream/completed counts')
  })
})

// 2. Disabled, model-ineligible, and lower-priority connections never win; equal priority round-robins.
test('U08-02 priority and round-robin select only eligible connections', { timeout: 20_000 }, async (t) => {
  await runScenario(t, 'U08-02', 'priority/round-robin eligibility', async (scenario) => {
    const specs = {
      eligible: { connections: [
        connection('eligible', 0, { priority: 0 }),
        connection('eligible', 1, { priority: 0 }),
        connection('eligible', 2, { priority: 1 }),
        connection('eligible', 3, { priority: 0, enabled: false }),
        connection('eligible', 4, { priority: 0, modelIds: ['other-model'] }),
      ] },
    }
    const { gw, upstream } = await fixture(t, 'eligibility', specs, { target: { provider: 'eligible', fallbacks: [] } }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk())
    })
    const before = await counters(gw)
    const results = []
    for (let i = 0; i < 8; i++) results.push(await postChat(gw, 'target', 'eligibility-' + i))
    const sequence = upstream.hits.map((hit) => hit.connectionId)
    const expected = Array.from({ length: 8 }, (_, i) => specs.eligible.connections[i % 2].connectionId)
    scenario.observations.selection = { sequence, counts: countBy(sequence), statuses: results.map((result) => result.response.status) }
    exact(scenario, 'eight_requests_succeed', results.filter((result) => result.response.status === 200).length, 8, '8 HTTP 200')
    exact(scenario, 'equal_priority_round_robin_exact', sequence, expected, 'c0,c1 repeated; priority 1/disabled/model-ineligible excluded')
    exact(scenario, 'ineligible_connections_zero_attempts', countBy(sequence), { [specs.eligible.connections[0].connectionId]: 4, [specs.eligible.connections[1].connectionId]: 4 }, 'only two priority-0 eligible connections')
    const after = await counters(gw)
    scenario.observations.accounting = deltaCounters(before, after, upstream.hits.length)
    exact(scenario, 'eligibility_accounting_exact', scenario.observations.accounting, { logicalRequests: 8, upstreamAttempts: 8, gatewayRequestCounter: 8, completedRequests: 8, errors: 0, retries: 0 }, '8 logical = 8 upstream')
  })
})

// 3. Different maxConcurrent values are independent semaphores, not one provider-wide bucket.
test('U08-03 independent maxConcurrent slots queue without cross-connection leakage', { timeout: 25_000 }, async (t) => {
  await runScenario(t, 'U08-03', 'independent maxConcurrent slots', async (scenario) => {
    const gate = makeGate()
    const caps = [1, 2, 3]
    const specs = { slots: { connections: caps.map((cap, i) => connection('slots', i, { maxConcurrent: cap })) } }
    const active = {}
    const maxObserved = {}
    const { gw, upstream } = await fixture(t, 'slots', specs, { target: { provider: 'slots', fallbacks: [] } }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      active[rec.connectionId] = (active[rec.connectionId] || 0) + 1
      maxObserved[rec.connectionId] = Math.max(maxObserved[rec.connectionId] || 0, active[rec.connectionId])
      try {
        await gate.promise
        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk()) }
      } finally {
        active[rec.connectionId] = Math.max(0, active[rec.connectionId] - 1)
      }
    })
    const before = await counters(gw)
    const requests = Array.from({ length: 12 }, (_, i) => postChat(gw, 'target', 'slots-' + i))
    await waitFor(() => upstream.hits.filter((hit) => hit.body).length >= 6, 8000, 'six independent slots did not open')
    await sleep(100)
    const gated = upstream.hits.filter((hit) => hit.body)
    const counts = countBy(gated.map((hit) => hit.connectionId))
    scenario.observations.gatedInFlight = { upstreamAttempts: gated.length, perConnection: counts, maxObserved, queuedLogicalRequests: 12 - gated.length }
    exact(scenario, 'only_sum_of_connection_caps_in_flight', gated.length, 6, '1+2+3 independent slots')
    exact(scenario, 'each_connection_uses_own_cap', counts, Object.fromEntries(specs.slots.connections.map((item) => [item.connectionId, item.maxConcurrent])), 'caps [1,2,3]')
    check(scenario, 'no_connection_exceeds_its_cap', specs.slots.connections.every((item) => (maxObserved[item.connectionId] || 0) <= item.maxConcurrent), true, maxObserved, 'observed max <= configured max for every connection')
    gate.release()
    const results = await Promise.all(requests)
    exact(scenario, 'all_queued_requests_complete', results.filter((result) => result.response.status === 200).length, 12, '12 HTTP 200 after gate release')
    const after = await counters(gw)
    scenario.observations.accounting = deltaCounters(before, after, upstream.hits.length)
    exact(scenario, 'slot_accounting_exact', scenario.observations.accounting, { logicalRequests: 12, upstreamAttempts: 12, gatewayRequestCounter: 12, completedRequests: 12, errors: 0, retries: 0 }, 'queueing does not duplicate attempts')
  })
})

// 4. A 429 cools down only its connection; Retry-After beyond request budget is never shortened/retried.
test('U08-04 per-connection 429 cooldown and Retry-After budget safety', { timeout: 20_000 }, async (t) => {
  await runScenario(t, 'U08-04', '429 cooldown / Retry-After safety', async (scenario) => {
    const specs = {
      limited: { connections: [connection('limited', 0), connection('limited', 1)] },
      retry: { connections: [connection('retry', 0)] },
    }
    const { gw, upstream } = await fixture(t, 'cooldown', specs, {
      limited: { provider: 'limited', fallbacks: [] },
      retry: { provider: 'retry', fallbacks: [] },
    }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      if (rec.providerId === 'retry') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' })
        res.end('{"error":{"message":"Rate limit exceeded"}}')
        return
      }
      if (rec.connectionId === specs.limited.connections[0].connectionId) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' })
        res.end('{"error":{"message":"Rate limit exceeded"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk())
    }, { overallMs: 700, maxWaitMs: 1000 })
    const a = specs.limited.connections[0].connectionId
    const b = specs.limited.connections[1].connectionId
    const before = await counters(gw)
    const first = await postChat(gw, 'limited', 'cooldown-1')
    const limitedAfterFirst = upstream.hits.filter((hit) => hit.providerId === 'limited').length
    const secondAt = Date.now()
    const second = await postChat(gw, 'limited', 'cooldown-2')
    const secondElapsed = Date.now() - secondAt
    const limitedAfterSecond = upstream.hits.filter((hit) => hit.providerId === 'limited').length
    const aAfterSecond = upstream.hits.filter((hit) => hit.connectionId === a).length
    const third = await postChat(gw, 'limited', 'cooldown-3')
    const limitedAfterThird = upstream.hits.filter((hit) => hit.providerId === 'limited').length
    const bAfterThird = upstream.hits.filter((hit) => hit.connectionId === b).length
    await sleep(1100)
    const fourth = await postChat(gw, 'limited', 'cooldown-4')
    const fifth = await postChat(gw, 'limited', 'cooldown-5')
    const retryAt = Date.now()
    const retry = await postChat(gw, 'retry', 'retry-after-5s')
    const retryElapsed = Date.now() - retryAt
    const retryHits = upstream.hits.filter((hit) => hit.providerId === 'retry').length
    const limitedHits = upstream.hits.filter((hit) => hit.providerId === 'limited')
    const after = await counters(gw)
    scenario.observations = {
      responses: { first: first.summary, second: second.summary, third: third.summary, fourth: fourth.summary, fifth: fifth.summary, retry: retry.summary },
      limitedAttempts: { afterFirst: limitedAfterFirst, afterSecond: limitedAfterSecond, afterThird: limitedAfterThird, final: limitedHits.length },
      limitedSequence: limitedHits.map((hit) => hit.connectionId),
      aHitsFinal: limitedHits.filter((hit) => hit.connectionId === a).length,
      bHitsFinal: limitedHits.filter((hit) => hit.connectionId === b).length,
      secondElapsedMs: secondElapsed,
      retryElapsedMs: retryElapsed,
      retryHits,
      accounting: deltaCounters(before, after, limitedHits.length + retryHits),
    }
    exact(scenario, 'first_logical_request_fails_over_to_other_connection', { status: first.response.status, attempts: limitedAfterFirst, sequence: limitedHits.slice(0, 2).map((hit) => hit.connectionId) }, { status: 200, attempts: 2, sequence: [a, b] }, 'A 429 then B success within one logical request')
    exact(scenario, 'cooling_connection_skipped_without_upstream_attempt', { status: second.response.status, attempts: limitedAfterSecond, aHits: aAfterSecond }, { status: 429, attempts: 2, aHits: 1 }, 'A receives no second hit during cooldown')
    exact(scenario, 'cooldown_response_preserves_retry_after', { header: second.summary.retryAfter, ms: second.summary.retryAfterMs, attempts: second.summary.attempts }, { header: '1', ms: second.summary.retryAfterMs, attempts: 0 }, 'remaining cooldown is returned without shortening; zero upstream attempts for this logical request')
    check(scenario, 'cooldown_retry_after_is_positive_and_bounded', second.summary.retryAfterMs > 0 && second.summary.retryAfterMs <= 1000, true, second.summary.retryAfterMs, '0 < remaining Retry-After <= 1000ms')
    check(scenario, 'cooldown_skip_is_bounded', secondElapsed < 500, true, secondElapsed, 'no 1s wait inside 700ms request budget')
    exact(scenario, 'other_connection_serves_after_skip', { status: third.response.status, attempts: limitedAfterThird, bHits: bAfterThird }, { status: 200, attempts: 3, bHits: 2 }, 'B serves without another A attempt')
    exact(scenario, 'cooldown_expiry_restores_eligibility', { fourth: fourth.response.status, fifth: fifth.response.status, aFinal: limitedHits.filter((hit) => hit.connectionId === a).length, bFinal: limitedHits.filter((hit) => hit.connectionId === b).length }, { fourth: 200, fifth: 429, aFinal: 2, bFinal: 3 }, 'after 1.1s A is selected again, then B completes the logical request')
    exact(scenario, 'over_budget_retry_after_not_shortened', { status: retry.response.status, header: retry.summary.retryAfter, ms: retry.summary.retryAfterMs, hits: retryHits }, { status: 429, header: '5', ms: 5000, hits: 1 }, '5s Retry-After returned unchanged; exactly one upstream attempt')
    check(scenario, 'over_budget_retry_after_returns_promptly', retryElapsed < 500, true, retryElapsed, 'no 5s sleep under 700ms overall budget')
    exact(scenario, 'cooldown_accounting_exact', scenario.observations.accounting, { logicalRequests: 6, upstreamAttempts: 6, gatewayRequestCounter: 6, completedRequests: 3, errors: 3, retries: 0 }, '6 logical requests; 6 actual upstream attempts; gateway counter must not count pre-send cooldown skips')
  })
})

// 5. Explicit shared quota exhaustion skips the whole domain and proceeds to an independent domain.
test('U08-05 shared quota-domain exhaustion skips all sibling connections', { timeout: 20_000 }, async (t) => {
  await runScenario(t, 'U08-05', 'shared quota-domain exhaustion', async (scenario) => {
    const specs = {
      sharedA: { connections: [connection('sharedA', 0, { quotaScopeId: 'account-family' }), connection('sharedA', 1, { quotaScopeId: 'account-family' })] },
      sharedB: { connections: [connection('sharedB', 0, { quotaScopeId: 'account-family' })] },
      independent: { connections: [connection('independent', 0, { quotaScopeId: 'other-account' })] },
    }
    const { gw, upstream } = await fixture(t, 'quota', specs, {
      quota: { provider: 'sharedA', fallbacks: ['sharedB', 'independent'] },
    }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      if (rec.providerId === 'sharedA') {
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"insufficient_quota: shared account quota exhausted"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk('independent-ok'))
    })
    const before = await counters(gw)
    const result = await postChat(gw, 'quota', 'shared-quota')
    const after = await counters(gw)
    const attempts = upstream.hits.map((hit) => ({ providerId: hit.providerId, connectionId: hit.connectionId }))
    scenario.observations = { response: result.summary, attempts, accounting: deltaCounters(before, after, attempts.length) }
    exact(scenario, 'independent_domain_recovers_logical_request', result.response.status, 200, 'one 402 must fail over only outside the exhausted shared domain')
    exact(scenario, 'shared_domain_siblings_zero_attempts', attempts.filter((hit) => hit.providerId === 'sharedA' && hit.connectionId === specs.sharedA.connections[1].connectionId).length, 0, 'second connection in exhausted domain is not sent')
    exact(scenario, 'same_domain_other_provider_zero_attempts', attempts.filter((hit) => hit.providerId === 'sharedB').length, 0, 'all providers sharing account-family are skipped')
    exact(scenario, 'independent_provider_exactly_one_attempt', attempts.filter((hit) => hit.providerId === 'independent').length, 1, 'independent domain receives exactly one attempt')
    exact(scenario, 'quota_accounting_exact', scenario.observations.accounting, { logicalRequests: 1, upstreamAttempts: 2, gatewayRequestCounter: 2, completedRequests: 1, errors: 1, retries: 0 }, '1 logical request = 1 rejected shared-domain attempt + 1 independent success')
  })
})

// 6. Circuit opens, skips traffic without extending cooldown, then admits exactly one half-open probe.
test('U08-06 circuit half-open is single-flight and recovers without a thundering herd', { timeout: 25_000 }, async (t) => {
  await runScenario(t, 'U08-06', 'circuit half-open / recovery / no herd', async (scenario) => {
    const gate = makeGate()
    let mode = 'fail'
    let firstProbeResolve
    const firstProbe = new Promise((resolve) => { firstProbeResolve = resolve })
    const specs = { circuit: { connections: [connection('circuit', 0, { maxConcurrent: 20, circuit: { maxFailures: 1, openDurationMs: 300 } })] } }
    const { gw, upstream } = await fixture(t, 'circuit', specs, { target: { provider: 'circuit', fallbacks: [] } }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      if (mode === 'fail') {
        res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"overloaded"}}')
        return
      }
      if (mode === 'probe') {
        firstProbeResolve()
        await gate.promise
      }
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk('recovered')) }
    })
    const before = await counters(gw)
    const failed = await postChat(gw, 'target', 'circuit-fail')
    const opened = await (await gw.get('/api/status')).json()
    const healthAtOpen = opened.providers.find((item) => item.id === 'circuit')?.st
    const hitsAtOpen = upstream.hits.length
    const during = []
    for (let i = 0; i < 5; i++) during.push(await postChat(gw, 'target', 'circuit-open-' + i))
    const openWindowAdditionalUpstreamAttempts = upstream.hits.length - hitsAtOpen
    await waitFor(async () => {
      const status = await (await gw.get('/api/status')).json()
      const health = status.providers.find((item) => item.id === 'circuit')?.st
      return health && (health.state === 'half' || health.openUntil <= Date.now())
    }, 3000, 'circuit did not reach half-open after cooldown')
    mode = 'probe'
    const herd = Array.from({ length: 20 }, (_, i) => postChat(gw, 'target', 'circuit-probe-' + i))
    await waitFor(() => upstream.hits.length > hitsAtOpen, 3000, 'no half-open probe reached upstream')
    await firstProbe
    await sleep(150)
    const probesWhileGateHeld = upstream.hits.length - hitsAtOpen
    gate.release()
    const recovered = await Promise.all(herd)
    const finalStatus = await (await gw.get('/api/status')).json()
    const finalHealth = finalStatus.providers.find((item) => item.id === 'circuit')?.st
    const after = await counters(gw)
    scenario.observations = {
      failedResponse: failed.summary,
      healthAtOpen,
      openWindowResponses: during.map((item) => item.response.status),
      openWindowAdditionalUpstreamAttempts,
      probesWhileGateHeld,
      recoveredResponses: recovered.map((item) => item.response.status),
      finalHealth,
      accounting: deltaCounters(before, after, upstream.hits.length),
    }
    exact(scenario, 'failure_opens_circuit', { status: failed.response.status, state: healthAtOpen?.state, open: healthAtOpen?.openUntilMs > 0 }, { status: 502, state: 'open', open: true }, 'one 503 opens maxFailures=1 circuit')
    exact(scenario, 'open_window_zero_upstream_attempts', during.map((item) => item.response.status), [502, 502, 502, 502, 502], 'open circuit skips all five logical requests')
    exact(scenario, 'no_thundering_herd', probesWhileGateHeld, 1, 'exactly one upstream half-open probe while the probe gate is held')
    exact(scenario, 'recovery_releases_all_waiters', recovered.filter((item) => item.response.status === 200).length, 20, '20 logical requests complete after one successful probe')
    exact(scenario, 'successful_probe_closes_circuit', { state: finalHealth?.state, openUntilMs: finalHealth?.openUntilMs }, { state: 'ok', openUntilMs: 0 }, 'health reset after recovery')
    exact(scenario, 'circuit_accounting_exact', scenario.observations.accounting, { logicalRequests: 26, upstreamAttempts: 21, gatewayRequestCounter: 21, completedRequests: 20, errors: 1, retries: 0 }, '26 logical = 1 failing + 5 skipped + 20 recovered; 21 upstream attempts')
  })
})

// 7. Cancellation removes queued work, aborts active upstream sockets, and never replays either request.
test('U08-07 cancel safety for active and queued requests has exact attempt accounting', { timeout: 25_000 }, async (t) => {
  await runScenario(t, 'U08-07', 'active/queued cancellation safety', async (scenario) => {
    const gate = makeGate()
    const specs = { cancel: { connections: [connection('cancel', 0), connection('cancel', 1)] } }
    const { gw, upstream } = await fixture(t, 'cancel', specs, { target: { provider: 'cancel', fallbacks: [] } }, async (req, res, rec) => {
      rec.body = await readJsonBody(req)
      rec.marker = rec.body.marker
      await gate.promise
      if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(chatOk()) }
    })
    const before = await counters(gw)
    const activeControllers = [new AbortController(), new AbortController()]
    const activeRequests = activeControllers.map((controller, i) => postChat(gw, 'target', 'active-' + i, { controller }).catch((error) => ({ aborted: controller.signal.aborted, errorName: error.name })))
    await waitFor(() => upstream.hits.filter((hit) => hit.body).length === 2, 5000, 'two active requests did not reach upstream')
    const activeMarkers = upstream.hits.filter((hit) => hit.body).map((hit) => hit.body.marker)
    const queuedController = new AbortController()
    const survivorController = new AbortController()
    const cancelledQueued = postChat(gw, 'target', 'cancelled-queued', { controller: queuedController }).catch((error) => ({ aborted: queuedController.signal.aborted, errorName: error.name }))
    const survivor = postChat(gw, 'target', 'survivor', { controller: survivorController })
    await sleep(80)
    const attemptsBeforeCancel = upstream.hits.filter((hit) => hit.body).length
    queuedController.abort(new Error('cancel queued request'))
    const activeIndex = activeMarkers.indexOf('active-0')
    activeControllers[activeIndex >= 0 ? activeIndex : 0].abort(new Error('cancel active request'))
    await sleep(1000)
    const cancelledActiveRec = upstream.hits.find((hit) => hit.body?.marker === 'active-0')
    const cancelledActiveSocketClosedBeforeGateRelease = cancelledActiveRec?.closedAt !== null
    gate.release()
    const activeResults = await Promise.all(activeRequests)
    const cancelledResult = await cancelledQueued
    const survivorResult = await survivor
    const markers = upstream.hits.filter((hit) => hit.body).map((hit) => hit.body.marker)
    const after = await counters(gw)
    scenario.observations = {
      attemptsBeforeCancel,
      upstreamMarkers: markers,
      cancelledQueuedAttempts: markers.filter((marker) => marker === 'cancelled-queued').length,
      cancelledActiveSocketClosedBeforeGateRelease,
      cancelledActiveSocketClosed: cancelledActiveRec?.closedAt !== null,
      cancelledActiveSocketAborted: cancelledActiveRec?.aborted === true,
      activeAbortedResponses: activeResults.filter((result) => result.aborted).length,
      queuedAbortedResponse: cancelledResult.aborted === true,
      survivorStatus: survivorResult.response?.status ?? null,
      accounting: deltaCounters(before, after, markers.length),
    }
    exact(scenario, 'queued_requests_not_sent_before_cancel', attemptsBeforeCancel, 2, 'both maxConcurrent=1 slots occupied')
    exact(scenario, 'cancelled_queued_zero_upstream_attempts', scenario.observations.cancelledQueuedAttempts, 0, 'cancellation removes waiter before send')
    exact(scenario, 'cancelled_active_socket_destroyed', scenario.observations.cancelledActiveSocketClosedBeforeGateRelease, true, 'gateway closes the active upstream response socket within 1s of client cancellation')
    exact(scenario, 'cancelled_requests_stop_without_replay', { activeAborted: scenario.observations.activeAbortedResponses, queuedAborted: scenario.observations.queuedAbortedResponse }, { activeAborted: 1, queuedAborted: true }, 'one active + one queued client cancellation')
    exact(scenario, 'survivor_acquires_released_slot', scenario.observations.survivorStatus, 200, 'uncancelled queued request succeeds')
    exact(scenario, 'cancel_accounting_exact', scenario.observations.accounting, { logicalRequests: 4, upstreamAttempts: 3, gatewayRequestCounter: 3, completedRequests: 2, errors: 0, retries: 0 }, '4 logical requests; cancelled-queued has zero attempt; no retry/error inflation')
  })
})
