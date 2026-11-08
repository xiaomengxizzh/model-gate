import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { probeModel } from '../../../src/request.js'

async function withMock(run) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const provider = {
    id: 'offline-probe',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    api: 'openai',
    apiKey: 'probe-test-key',
    extraHeaders: { 'x-probe-extra': 'present' },
  }
  try {
    await run(provider, seen)
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

test('OpenAI probe uses OpenAI path, model name, and bearer auth', async () => {
  await withMock(async (provider, seen) => {
    const result = await probeModel(provider, 'public-model', 'openai')
    assert.equal(result.ok, true)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, '/v1/chat/completions')
    assert.equal(seen[0].body.model, 'public-model')
    assert.equal(seen[0].headers.authorization, 'Bearer probe-test-key')
    assert.equal(seen[0].headers['x-probe-extra'], 'present')
  })
})

test('Anthropic probe uses Messages API and protocol headers', async () => {
  await withMock(async (provider, seen) => {
    const result = await probeModel(provider, 'public-model', 'anthropic')
    assert.equal(result.ok, true)
    assert.equal(seen[0].path, '/v1/messages')
    assert.equal(seen[0].body.model, 'public-model')
    assert.equal(seen[0].body.messages[0].role, 'user')
    assert.equal(seen[0].headers['x-api-key'], 'probe-test-key')
    assert.equal(seen[0].headers['anthropic-version'], '2023-06-01')
  })
})

test('Gemini probe uses generateContent path and API-key header', async () => {
  await withMock(async (provider, seen) => {
    const result = await probeModel(provider, 'public-model', 'gemini')
    assert.equal(result.ok, true)
    assert.equal(seen[0].path, '/v1beta/models/public-model:generateContent')
    assert.deepEqual(seen[0].body.contents, [{ role: 'user', parts: [{ text: 'ping' }] }])
    assert.equal(seen[0].headers['x-goog-api-key'], 'probe-test-key')
  })
})

test('probe can use a provider-specific model name', async () => {
  await withMock(async (provider, seen) => {
    const result = await probeModel(provider, 'public-model', 'anthropic', 'vendor/model-alias')
    assert.equal(result.ok, true)
    assert.equal(seen[0].path, '/v1/messages')
    assert.equal(seen[0].body.model, 'vendor/model-alias')
  })
})
