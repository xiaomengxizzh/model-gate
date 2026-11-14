// SSE 断流续传（MG-004：自建隔离实例，不再读写目标网关配置）。
import { startGateway, startMockServer } from './isolate.mjs'
import { check, finish, streamDeltaText } from './utils.mjs'

const PARTS = ['Hello', ' world', ' this is ', 'a', ' full sentence to test resume.']
let hits = 0
const up = await startMockServer((req, res) => {
  hits++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (hits === 1) { for (const p of PARTS) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n'); res.end() }
  else { res.write('data: [DONE]\n\n'); res.end() }
})
const fx = await startGateway({
  name: 'sse-resume',
  config: {
    providers: { 't-sse': { baseUrl: up.base, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'openai' } },
    models: { 't-sse-m': { provider: 't-sse', alias: [], fallbacks: [], maxConcurrent: 0 } },
  },
})
try {
  const text = await (await fx.chat('t-sse-m', true)).text()
  check('sse 断流续传·重连后内容完整且无重复', streamDeltaText(text) === PARTS.join(''))
} finally {
  await fx.stop(); await up.stop()
}
finish('sse-resume')
