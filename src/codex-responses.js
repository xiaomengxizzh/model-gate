// Codex Responses ↔ OpenAI Chat adapter (MVP).
// Zero external dependencies. Reject unsupported message parts rather than dropping user data.
import { randomUUID } from 'node:crypto'

export class UnsupportedResponsesInput extends Error {
  constructor(message) { super(message); this.name = 'UnsupportedResponsesInput'; this.status = 422 }
}
function parseArgs(s) { try { return JSON.parse(s) } catch { return null } }
function messageContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw new UnsupportedResponsesInput('Unsupported Responses message content')
  const out = []
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new UnsupportedResponsesInput('Invalid Responses input part')
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') throw new UnsupportedResponsesInput('Responses text part must contain text')
      out.push({ type: 'text', text: part.text })
    } else if (part.type === 'input_image') {
      if (typeof part.image_url !== 'string') throw new UnsupportedResponsesInput('Responses image part needs image_url')
      out.push({ type: 'image_url', image_url: { url: part.image_url } })
    } else throw new UnsupportedResponsesInput('Unsupported Responses input part: ' + (part.type || '(missing)'))
  }
  if (out.every(p => p.type === 'text')) return out.map(p => p.text).join('\n')
  return out
}
export function responsesToChat(body) {
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || !body.model) throw new UnsupportedResponsesInput('Responses body needs model')
  if (body.previous_response_id) throw new UnsupportedResponsesInput('previous_response_id is unsupported by stateless Chat conversion; send full input history')
  const messages = [], customTools = new Set()
  if (body.instructions != null) {
    if (typeof body.instructions !== 'string') throw new UnsupportedResponsesInput('instructions must be string')
    messages.push({ role: 'system', content: body.instructions })
  }
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  if (!Array.isArray(input)) throw new UnsupportedResponsesInput('Responses input must be string or array')
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new UnsupportedResponsesInput('Invalid Responses input item')
    if (item.type === 'reasoning') continue // Opaque reasoning state has no Chat analogue.
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (typeof item.name !== 'string' || typeof item.call_id !== 'string') throw new UnsupportedResponsesInput('Invalid Responses tool call')
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input || '' }) : (item.arguments || '{}')
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: args } }] })
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!item.call_id) throw new UnsupportedResponsesInput('Tool output missing call_id')
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) })
      continue
    }
    if (!item.type || item.type === 'message') {
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) throw new UnsupportedResponsesInput('Unsupported Responses role')
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: messageContent(item.content) })
      continue
    }
    throw new UnsupportedResponsesInput('Unsupported Responses input item: ' + item.type)
  }
  const out = { model: body.model, messages, stream: !!body.stream }
  if (out.stream) out.stream_options = { include_usage: true }
  if (Array.isArray(body.tools)) out.tools = body.tools.map(t => {
    if (!t || typeof t.name !== 'string') throw new UnsupportedResponsesInput('Invalid Responses tool')
    if (t.type === 'function') return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }
    if (t.type === 'custom') {
      customTools.add(t.name)
      return { type: 'function', function: { name: t.name, description: t.description || '', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } }
    }
    throw new UnsupportedResponsesInput('Unsupported Responses tool type: ' + t.type)
  })
  if (body.tool_choice === 'none' || body.tool_choice === 'auto' || body.tool_choice === 'required') out.tool_choice = body.tool_choice
  else if (body.tool_choice && typeof body.tool_choice === 'object' && body.tool_choice.name) out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } }
  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) out.max_tokens = body.max_output_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  // Reasoning modes differ by upstream; forward only explicit supported client setting.
  if (body.reasoning && typeof body.reasoning.effort === 'string' && ['low','medium','high','xhigh'].includes(body.reasoning.effort)) out.reasoning_effort = body.reasoning.effort
  return { body: out, customTools }
}
function toolToOutput(tc, customTools) {
  const fn = tc.function || {}
  if (customTools && customTools.has(fn.name)) {
    const decoded = parseArgs(fn.arguments || '')
    const input = decoded && typeof decoded.input === 'string' ? decoded.input : (fn.arguments || '')
    return { id: 'ctc_' + randomUUID(), type: 'custom_tool_call', call_id: tc.id || 'call_' + randomUUID(), name: fn.name, input, status: 'completed' }
  }
  return { id: 'fc_' + randomUUID(), type: 'function_call', call_id: tc.id || 'call_' + randomUUID(), name: fn.name || '', arguments: fn.arguments || '{}', status: 'completed' }
}
export function chatToResponses(o, requestedModel, customTools = new Set()) {
  const choice = o && o.choices && o.choices[0]
  if (!choice) throw new Error('Chat upstream response has no choices')
  const msg = choice.message || {}
  const output = []
  if (typeof msg.content === 'string' && msg.content) output.push({ id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content, annotations: [] }] })
  for (const tc of msg.tool_calls || []) output.push(toolToOutput(tc, customTools))
  const u = o.usage || {}
  return { id: 'resp_' + randomUUID(), object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model: requestedModel || o.model || '', output, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0, total_tokens: u.total_tokens || 0 }, error: null, incomplete_details: null }
}
// Responses SSE event framing and item ordering for Codex clients.
export async function relayChatAsResponses(client, stream, options = {}) {
  let ended = false, contentSent = false, clientGone = false
  let usage = null, buffer = '', text = '', textStarted = false, seq = 0
  const toolByIndex = new Map()
  const response = { id: 'resp_' + randomUUID(), object: 'response', created_at: Math.floor(Date.now()/1000), status: 'in_progress', model: options.model || '', output: [], error: null, incomplete_details: null }
  const send = (kind, data) => {
    if (!client.destroyed && !client.writableEnded) {
      contentSent = true
      client.write('event: '+kind+'\ndata: '+JSON.stringify({ type: kind, sequence_number: seq++, ...data })+'\n\n')
    }
  }
  const init = () => {
    if (client.headersSent) return
    client.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-cache', 'connection':'keep-alive' })
    send('response.created', { response: { ...response } })
    send('response.in_progress', { response: { ...response } })
  }
  function startText() {
    if (textStarted) return
    textStarted = true
    const item = { id:'msg_' + randomUUID(), type:'message', role:'assistant', status:'in_progress', content:[] }
    response.output.push(item)
    send('response.output_item.added', { output_index: response.output.length - 1, item })
    send('response.content_part.added', { item_id: item.id, output_index:response.output.length - 1, content_index:0, part:{ type:'output_text', text:'', annotations:[] } })
  }
  function flushTools() {
    for (const [, tc] of [...toolByIndex].sort(([a],[b])=>a-b)) {
      const item = toolToOutput({ id:tc.id, function:{name:tc.name, arguments:tc.arguments} }, options.customTools)
      const idx = response.output.length
      response.output.push(item)
      send('response.output_item.added', {output_index:idx,item:{...item,status:'in_progress', ...(item.type==='function_call'?{arguments:''}:{input:''})}})
      if (item.type === 'function_call') {
        if (item.arguments) send('response.function_call_arguments.delta',{item_id:item.id,output_index:idx,delta:item.arguments})
        send('response.function_call_arguments.done',{item_id:item.id,output_index:idx,arguments:item.arguments})
      } else {
        if (item.input) send('response.custom_tool_call_input.delta',{item_id:item.id,output_index:idx,delta:item.input})
        send('response.custom_tool_call_input.done',{item_id:item.id,output_index:idx,input:item.input})
      }
      send('response.output_item.done',{output_index:idx,item})
    }
  }
  function handleSse(block) {
    const lines = block.split('\n').map(x=>x.replace(/\r$/,''))
    const data = lines.filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n')
    if (!data) return
    if (data === '[DONE]') { ended = true; return }
    let o; try { o = JSON.parse(data) } catch { return }
    if (o.error) throw new Error(typeof o.error === 'string' ? o.error : o.error.message || 'upstream SSE error')
    if (o.usage) usage = o.usage
    for (const c of o.choices || []) {
      const d = c.delta || {}
      if (typeof d.content === 'string' && d.content) {
        init(); startText(); text += d.content
        const item = response.output.find(x=>x.type==='message')
        send('response.output_text.delta',{item_id:item.id,output_index:response.output.indexOf(item),content_index:0,delta:d.content})
      }
      if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0
        const t = toolByIndex.get(idx) || { id:'', name:'', arguments:'' }
        if (tc.id) t.id = tc.id
        if (tc.function?.name) t.name += tc.function.name
        if (tc.function?.arguments) t.arguments += tc.function.arguments
        toolByIndex.set(idx,t)
      }
    }
  }
  const finish = (success, reason='') => {
    init()
    if (textStarted) {
      const item = response.output.find(x=>x.type==='message'), idx = response.output.indexOf(item)
      const part={type:'output_text',text,annotations:[]}
      send('response.output_text.done',{item_id:item.id,output_index:idx,content_index:0,text})
      send('response.content_part.done',{item_id:item.id,output_index:idx,content_index:0,part})
      const doneItem={...item,status:'completed',content:[part]}
      response.output[idx]=doneItem
      send('response.output_item.done',{output_index:idx,item:doneItem})
    }
    flushTools()
    if (usage) response.usage={input_tokens:usage.prompt_tokens||0,output_tokens:usage.completion_tokens||0,total_tokens:usage.total_tokens||0}
    response.status = success ? 'completed' : 'failed'
    if (!success) response.error={code:'upstream_stream_interrupted',message:reason||'upstream stream ended without [DONE]'}
    send(success?'response.completed':'response.failed',{response})
    if (!client.writableEnded) client.end()
  }
  try {
    for await (const chunk of stream) {
      if (client.destroyed) {clientGone=true;break}
      buffer += chunk.toString('utf8').replace(/\r\n/g,'\n')
      let at
      while ((at=buffer.indexOf('\n\n')) !== -1) { const block=buffer.slice(0,at);buffer=buffer.slice(at+2);handleSse(block) }
      if (ended) break
    }
    if (!clientGone) finish(ended)
  } catch(e) { if (!clientGone) finish(false,e.message) }
  return {completed:ended && !clientGone,clientGone,contentSent,usage,reconnects:0}
}
export async function relayNativeResponses(client, stream) {
  let completed = false, clientGone = false, contentSent = false, buffer=''
  if (!client.headersSent) client.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'})
  try {
    for await (const chunk of stream) {
      if (client.destroyed) {clientGone = true;break}
      const s = chunk.toString('utf8')
      client.write(chunk)
      contentSent=true
      buffer=(buffer+s).slice(-16000)
      if (/event:\s*response\.completed/.test(buffer) || /"type"\s*:\s*"response\.completed"/.test(buffer)) completed=true
    }
  } catch { /* incomplete event stream is reported to caller */ }
  if (!clientGone && !client.writableEnded) client.end()
  return {completed,clientGone,contentSent,reconnects:0}
}
