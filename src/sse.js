const STREAM_CT = /(text|application)\/event-stream/i
export function isStreamResponse(res) {
  const ct = (res.headers && res.headers['content-type']) || ''
  return STREAM_CT.test(ct)
}

export function writeUpstreamHeaders(client, upstream, extra) {
  const h = {}
  for (const [k, v] of Object.entries(upstream.headers)) {
    const lk = k.toLowerCase()
    if (lk === 'transfer-encoding' || lk === 'content-length' || lk === 'connection' || lk === 'keep-alive') continue
    h[k] = v
  }
  h['transfer-encoding'] = 'chunked'
  return client.writeHead(upstream.statusCode || 200, Object.assign(h, extra || {}))
}

function extractData(ev) {
  let out = []
  for (const line of ev.split('\n')) if (line.startsWith('data:')) out.push(line.slice(5).trim())
  return out.join('\n')
}
function extractOpenAIContent(dataStr) {
  try { const obj = JSON.parse(dataStr); const c = obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content; return typeof c === 'string' ? c : '' } catch { return '' }
}
function parseDataLine(s) { try { return JSON.parse(s) } catch { return null } }
// 取 SSE 事件内的 usage（流末缓存命中统计），无则返回 null
function maybeExtractUsage(s) { const o = parseDataLine(s); return (o && o.usage) || null }
// 「名字没对上」加固（流式）：事件里的 model 与客户端请求名不一致时改回并重建事件，否则返回 null 保持原样透传
function maybeRewriteModel(s, desired) {
  if (!desired) return null
  const o = parseDataLine(s)
  if (o && typeof o.model === 'string' && o.model !== desired) { o.model = desired; return JSON.stringify(o) }
  return null
}

/**
 * OpenAI SSE 透传 + 断流自动续传；支持多协议（anthropic/gemini）流式重建为 OpenAI delta 事件。
 * opts: { idleMs, reconnect, maxReconnects, log, onTokens, protocol, extract }
 */
export async function relayStream(client, firstUpstream, opts) {
  const idleMs = opts.idleMs || 30000
  const maxReconnects = opts.maxReconnects != null ? opts.maxReconnects : 2
  const reconnect = opts.reconnect
  const log = opts.log
  const protocol = opts.protocol || 'openai'
  const extract = opts.extract || extractOpenAIContent
  let sent = ''
  let done = false
  let retries = 0
  let resolved = true
  let contentChars = 0
  let usageReported = false
  let lastUsage = null
  const clientGoneAt = { t: null }   // 下游客户端断线标记（何时检测到，null 表示仍在线）
  let curStream = firstUpstream      // 当前正读取的上游流（首次或续传之后）
  function destroyUpstream() { try { if (curStream && typeof curStream.destroy === 'function') curStream.destroy() } catch {} }

  function sendRaw(txt) { if (!client.destroyed) client.write(txt) }
  function sendDataJson(payload) { sendRaw('data: ' + JSON.stringify(payload) + '\n\n') }
  function sendDelta(t) { if (typeof t === 'string' && t !== '') sendDataJson({ choices: [{ delta: { content: t } }] }) }
  function sendDone() { sendRaw('data: [DONE]\n\n') }
  function keepalive() { if (!client.destroyed) client.write(': mg-keepalive\n') }
  function finalize(note) {
    if (client.destroyed) return
    try {
      // 中断时先给客户端明确交代（OpenAI 兼容错误事件），再 [DONE] 正常结束——
      // 否则纯 [DONE] 会被客户端当「正常结束但无输出」处理（zcode 等直接静默结束对话，用户无感知）
      sendDataJson({ error: { message: '上游流式响应中断：' + note + '，已重连 ' + retries + ' 次仍失败', type: 'stream_interrupted', code: 'STREAM_INTERRUPTED' } })
      sendRaw('\n: [gateway] ' + note + '\n')
      sendDone()
    } catch { client.destroy() }
    try { client.end() } catch { }
  }

  async function handleEvent(ev, dataStr) {
    if (protocol === 'openai' && dataStr === '[DONE]') { sendRaw(ev + '\n\n'); done = true; return }
    const ct = extract(dataStr)
    if (phaseAsync === 'resume' && !resolved && ct !== '') {
      acc += ct
      if (sent.startsWith(acc)) return
      if (acc.length > sent.length && sent === acc.slice(0, sent.length)) { const extra = acc.slice(sent.length); sendDelta(extra); sent = acc; resolved = true; log && log.warn('sse 续传：跳过重放 ' + sent.length + ' 字符，续发 ' + extra.length); return }
      sendDataJson({ choices: [{ delta: { content: acc } }] }); sent = acc; resolved = true; log && log.warn('sse 续传：上游重放内容偏移，可能存在少量重复'); return
    }
    if (protocol === 'openai') {
      // 流末 usage（缓存命中）解析，仅首次上报，续传重播不重复计入
      if (opts.onUsage && !usageReported) { const u = maybeExtractUsage(dataStr); if (u) { usageReported = true; lastUsage = u; opts.onUsage(u) } }
      // 「名字没对上」加固：回写响应 model 为客户端请求名（含首个空 content 事件）
      const reb = maybeRewriteModel(dataStr, opts.rewriteModel)
      sendRaw((reb != null ? 'data: ' + reb : ev) + '\n\n')
      sent += ct; contentChars += ct.length
      return
    }
    if (ct === '') return // 非 openai 空内容事件丢弃（不产生 delta）
    sendDelta(ct)
    sent += ct; contentChars += ct.length
  }

  let phaseAsync = 'first'
  let acc = ''
  // —— 下游客户端断线处理：一旦 ''close'' 就标记 + 销毁上游流 + 停 idle 定时器，杜绝死等上游/连接泄漏/续传浪费 ——
  let idleT = null
  const clearIdle = () => { if (idleT) { clearTimeout(idleT); idleT = null } }
  const markGone = () => {
    if (clientGoneAt.t != null) return
    clientGoneAt.t = Date.now()
    clearIdle()
    destroyUpstream()
    log && log.warn('sse 下游客户端已断开，中止中继并销毁上游连接')
  }
  if (typeof client.on === 'function') { try { client.on('close', markGone); client.on('error', markGone) } catch {} }

  async function pump(stream) {
    let buf = ''
    const arm = () => { clearIdle(); if (idleMs) idleT = setTimeout(() => { if (!done && clientGoneAt.t == null) resume('idle-timeout') }, idleMs) }
    arm()
    try {
      let pendingError = null
      stream.on && stream.on('error', (e) => { pendingError = e })
      for await (const chunk of stream) {
        if (done || clientGoneAt.t != null || client.destroyed) { stream.destroy && stream.destroy(); break }
        clearIdle(); arm()
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        let sep
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const ev = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          if (ev.trim() === '') continue
          await handleEvent(ev, extractData(ev))
          if (done) break
        }
        if (done) break
        keepalive()
      }
      clearIdle()
      if (done || clientGoneAt.t != null) return
      if (protocol === 'openai') return resume(pendingError ? ('error:' + (pendingError.code || pendingError.message)) : 'end') // 必须 await/return 续传链：否则 main 在续传完成前就继续并 end() 掐断
      else { sendDone(); done = true } // 非 openai 协议无 [DONE] 结束标记：上游流自然结束即正常完成
    } catch (e) {
      clearIdle()
      if (done || clientGoneAt.t != null) return
      return resume('error:' + (e.code || e.message))
    }
  }

  async function resume(reason) {
    if (done || clientGoneAt.t != null || client.destroyed || retries >= maxReconnects) { if (!done) finalize('断流续传' + (maxReconnects ? '用尽' : '失败') + '，结束'); return }
    retries++
    phaseAsync = 'resume'; resolved = false; acc = ''
    log && log.warn('sse 断流(' + reason + ')，第 ' + retries + '/' + maxReconnects + ' 次续传重连')
    keepalive()
    let st
    try { st = await reconnect() } catch (e) { return resume('reconnect:' + (e.message || 'fail')) }
    if (!st || (st.statusCode !== undefined && st.statusCode >= 400)) return resume('reconnect-status:' + (st && st.statusCode))
    curStream = st
    await pump(st)
  }

  await pump(firstUpstream)
  if (opts.onTokens) { try { opts.onTokens(contentChars, lastUsage) } catch {} }
  if (opts.onEnd) { try { opts.onEnd({ interrupted: !done, reconnects: retries }) } catch {} }
  if (typeof client.removeListener === 'function') { try { client.removeListener('close', markGone); client.removeListener('error', markGone) } catch {} }
  if (!client.destroyed) try { client.end() } catch { }
}