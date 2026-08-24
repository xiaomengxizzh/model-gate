import http from 'node:http'
import { GW, check, snapshot, save, streamDeltaText, chat } from './utils.mjs'
const PARTS = ['Hello', ' world', ' this is ', 'a', ' full sentence to test resume.']
let hits = 0
const up = http.createServer((req, res) => {
  hits++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (hits === 1) { for (const p of PARTS) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n'); res.end() }
  else { res.write('data: [DONE]\n\n'); res.end() }
})
await new Promise(r => up.listen(0, () => r()))
const base = await snapshot()
base.providers['t-sse'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' }
base.models['t-sse-m'] = { provider: 't-sse', alias: [], fallbacks: [], maxConcurrent: 0 }
await save(base.providers, base.models, base.defaults)
const text = await (await chat('t-sse-m', true)).text()
check('sse 断流续传·重连后内容完整且无重复', streamDeltaText(text) === PARTS.join(''))
const after = await snapshot(); delete after.providers['t-sse']; delete after.models['t-sse-m']; await save(after.providers, after.models, after.defaults)
await new Promise(r => up.close(r))