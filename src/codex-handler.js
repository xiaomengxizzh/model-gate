// Opt-in Responses entry for Codex; deliberately does not rewrite Codex auth.json.
// Phase 1 isolated bridge: exact model/provider only, no silent model/protocol fallback.
import { responsesToChat, chatToResponses, relayChatAsResponses, relayNativeResponses, UnsupportedResponsesInput } from './codex-responses.js'

async function readAll(stream, limit = 4 * 1024 * 1024) {
  const chunks=[];let n=0
  for await (const chunk of stream) { n+=chunk.length;if(n>limit)throw new Error('upstream response too large');chunks.push(chunk) }
  return Buffer.concat(chunks)
}
function send(res,status,value,extra={}) {
  if(res.headersSent)return
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',...extra})
  res.end(typeof value === 'string' || Buffer.isBuffer(value)?value:JSON.stringify(value))
}
export function codexSession(req,body) {
  const hs = req.headers || {}
  const id = hs['x-opencode-session'] || hs['session-id'] || hs['session_id'] || hs['x-codex-session-id'] || hs['thread-id'] || hs['thread_id'] || hs['x-session-id'] || hs['x-conversation-id'] || (body.metadata && body.metadata.session_id)
  return typeof id === 'string' && /^[\w.:-]{1,240}$/.test(id) ? id : ''
}
export async function handleCodexResponses({req,res,body,state,forward,buildProvider}) {
  const model=body?.model
  if(typeof model!=='string'||!model)return send(res,400,{error:{type:'invalid_request',message:'Responses model is required'}})
  const md=state.cfg.models && state.cfg.models[model]
  // Fail closed: the legacy forward chain still owns virtual aliases, quotas and fallbacks.
  // Do not silently bypass its limits by expanding virtual models here.
  if(!md || !md.provider) return send(res,404,{error:{type:'unknown_model',message:'Codex bridge requires an explicit models.<model> entry'}})
  if(md.quota || md.dailyQuota || md.maxContext || (md.fallbacks||[]).length || (state.cfg.virtualModels||[]).length) {
    return send(res,422,{error:{type:'unsupported_route',message:'Experimental Codex bridge cannot bypass existing quota/fallback/virtual-model governance; use the ordinary Chat endpoint until the unified route is implemented'}})
  }
  let prov
  try {prov=buildProvider(state.cfg,md.provider)}catch{return send(res,502,{error:{type:'no_provider',message:'Configured upstream is not available'}})}
  if(!prov.baseUrl || !prov.keyOk) return send(res,502,{error:{type:'no_provider',message:'Upstream URL or credential is unavailable'}})
  const wire=prov._def.codexWire || 'native'
  if(!['chat','native'].includes(wire))return send(res,422,{error:{type:'invalid_provider_config',message:'codexWire must be chat or native'}})
  const hasSession=prov._def.opencodeSession === true
  const session=codexSession(req,body)
  if(hasSession&&!session)return send(res,400,{error:{type:'missing_session',message:'OpenCode Go requires a stable conversation session header (Codex session-id/thread-id, or x-opencode-session)'}})
  let upstreamBody=body, customTools=new Set()
  try {if(wire==='chat'){const out=responsesToChat(body);upstreamBody=out.body;customTools=out.customTools}}
  catch(err){if(err instanceof UnsupportedResponsesInput)return send(res,422,{error:{type:'unsupported_responses_input',message:err.message}});throw err}
  // Do not force every upstream to support stream_options/reasoning_effort: model-specific metadata applies.
  if(wire==='chat') {
    if(prov._def.omitStreamOptions)delete upstreamBody.stream_options
    if(prov._def.omitReasoningEffort)delete upstreamBody.reasoning_effort
  }
  const bytes=Buffer.from(JSON.stringify(upstreamBody))
  const hs={'content-type':'application/json','accept':body.stream?'text/event-stream':'application/json','accept-encoding':'identity','content-length':bytes.length,'user-agent':'model-gate/codex-bridge'}
  if(prov.apiKey)hs.authorization='Bearer '+prov.apiKey
  for(const name of ['session-id','session_id','thread-id','thread_id','x-codex-session-id'])if(typeof req.headers[name]==='string')hs[name]=req.headers[name]
  if(hasSession)hs['x-opencode-session']=session
  for(const [k,v] of Object.entries(prov.extraHeaders || {})){
    if(!['authorization','cookie','host','content-length','proxy-authorization','x-opencode-session'].includes(k.toLowerCase()) && typeof v==='string')hs[k]=v
  }
  const path=wire==='chat'?(prov._def.codexChatPath||'/openai/v1/chat/completions'):(prov._def.codexResponsesPath||'/openai/v1/responses')
  let upstream
  try {
    upstream=await forward(prov,path,'POST',hs,bytes,{...state.cfg.defaults,retry:{maxAttempts:1},noRetry429:true},state.log)
  } catch(err) {
    state.log?.warn('codex bridge upstream failed',model,md.provider,err.status||err.code||'network')
    return send(res,502,{error:{type:'upstream_transport_error',message:'Codex bridge upstream transport failed',status:err.status||null}})
  }
  if(!upstream.ok){
    const raw=await readAll(upstream.stream).catch(()=>Buffer.from(''))
    const retryAfter=upstream.headers?.['retry-after']
    state.log?.warn('codex bridge upstream HTTP',upstream.status,'model='+model,'provider='+md.provider)
    return send(res,upstream.status,raw.length?raw:{error:{type:'upstream_error',message:'Upstream returned HTTP '+upstream.status}},retryAfter?{'retry-after':String(retryAfter)}:{})
  }
  state.log?.info('codex bridge upstream accepted', 'model='+model, 'provider='+md.provider,'wire='+wire)
  const isSse=/event-stream/i.test(upstream.headers?.['content-type']||'')
  if(body.stream && isSse){
    const done=wire==='chat'?await relayChatAsResponses(res,upstream.stream,{model,customTools}):await relayNativeResponses(res,upstream.stream)
    if(!done.completed && !done.clientGone)state.log?.warn('codex bridge stream interrupted','model='+model,'wire='+wire)
    return
  }
  let data
  try{data=JSON.parse((await readAll(upstream.stream)).toString('utf8'))}catch{return send(res,502,{error:{type:'bad_upstream',message:'Unable to parse upstream JSON'}})}
  if(wire==='chat'){
    try{data=chatToResponses(data,model,customTools)}catch{return send(res,502,{error:{type:'bad_upstream',message:'Chat response does not match expected schema'}})}
  }
  if(body.stream){
    // Some gateways ignore stream=true. Emit an explicit complete Responses object rather than a fake chat SSE.
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'})
    res.write('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',sequence_number:0,response:data})+'\n\n')
    res.end()
  }else send(res,200,data)
}
