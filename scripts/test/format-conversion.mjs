import http from 'node:http'
import { check, snapshot, save, streamDeltaText, chat } from './utils.mjs'

// Anthropic：请求转换 + 非流式/流式响应转换
{
  let reqBody = null
  const up = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { reqBody = JSON.parse(b); res.writeHead(200, { 'content-type': reqBody.stream ? 'text/event-stream' : 'application/json' }); if (reqBody.stream) { res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Cl"}}\n\n'); res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"aude over"}}\n\n'); res.end() } else res.end(JSON.stringify({ content: [{ type: 'text', text: 'Hello Claude NS' }] })) }) })
  await new Promise(r => up.listen(0, () => r()))
  const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
  base.providers['t-cl'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'anthropic' }
  base.models['t-cl-m'] = { provider: 't-cl', alias: [], fallbacks: [], maxConcurrent: 0 }
  await save(base.providers, base.models, base.defaults)
  const j1 = await (await chat('t-cl-m', false, { messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: 'hi' }] })).json()
  check('Anthropic·请求转换(system/messages)', j1.choices && j1.choices[0].message.content === 'Hello Claude NS', { sys: reqBody.system, maxTokens: reqBody.max_tokens })
  const dt = streamDeltaText(await (await chat('t-cl-m', true)).text())
  check('Anthropic·流式重建 OpenAI delta', dt === 'Hello from Claude over', { got: dt })
  const after = await snapshot(); delete after.providers['t-cl']; delete after.models['t-cl-m']; await save(after.providers, after.models, orig)
  await new Promise(r => up.close(r))
}

// Gemini：请求转换(contents/system/path) + 非流式/流式
{
  let reqPath = ''
  const up = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { reqPath = req.url; const jb = JSON.parse(b); const s = reqPath.includes('streamGenerateContent'); res.writeHead(200, { 'content-type': s ? 'text/event-stream' : 'application/json' }); if (s) { res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello Gem' }] } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ini ok' }] } }] }) + '\n\n'); res.end() } else res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello Gemini NS' }] } }] })) }) })
  await new Promise(r => up.listen(0, () => r()))
  const base = await snapshot(); const orig = JSON.parse(JSON.stringify(base.defaults))
  base.providers['t-gm'] = { baseUrl: `http://127.0.0.1:${up.address().port}`, apiKeyEnv: '', pathPrefix: '', extraHeaders: {}, api: 'gemini' }
  base.models['t-gm-m'] = { provider: 't-gm', alias: [], fallbacks: [], maxConcurrent: 0 }
  await save(base.providers, base.models, base.defaults)
  const j1 = await (await chat('t-gm-m', false, { messages: [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'hi' }] })).json()
  check('Gemini·请求转换(contents/system/path)', j1.choices && j1.choices[0].message.content === 'Hello Gemini NS' && reqPath.includes('generateContent') && !reqPath.includes('stream'), { path: reqPath })
  const dt = streamDeltaText(await (await chat('t-gm-m', true)).text())
  check('Gemini·流式重建 OpenAI delta', dt === 'Hello Gemini ok' && reqPath.includes('streamGenerateContent'), { path2: reqPath })
  const after = await snapshot(); delete after.providers['t-gm']; delete after.models['t-gm-m']; await save(after.providers, after.models, orig)
  await new Promise(r => up.close(r))
}