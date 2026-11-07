// Zero-dependency Codex Responses bridge contract tests; run: node --test tests/codex-responses.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {responsesToChat,chatToResponses,relayChatAsResponses,UnsupportedResponsesInput} from '../src/codex-responses.js'
import {handleCodexResponses,codexSession} from '../src/codex-handler.js'
class FakeResponse extends EventEmitter {
  constructor(){super();this.headersSent=false;this.writableEnded=false;this.destroyed=false;this.body=''}
  writeHead(status,headers){this.headersSent=true;this.status=status;this.headers=headers}
  write(buf){this.body+=String(buf);return true}
  end(data){if(data)this.body+=String(data);this.writableEnded=true}
}
async function* chunks(str) {yield Buffer.from(str.slice(0,19)); yield Buffer.from(str.slice(19,51)); yield Buffer.from(str.slice(51))}
test('Responses to Chat preserves tool id and output',()=>{
 const data={model:'deepseek-v4.1-flash',stream:true,instructions:'Be terse',input:[{role:'user',content:[{type:'input_text',text:'hi'}]},{type:'function_call',call_id:'call_1',name:'shell_command',arguments:'{"command":"pwd"}'},{type:'function_call_output',call_id:'call_1',output:'ok'}],tools:[{type:'function',name:'shell_command',parameters:{type:'object'}}]}
 const r=responsesToChat(data)
 assert.equal(r.body.messages[1].content,'hi')
 assert.equal(r.body.messages[2].tool_calls[0].id,'call_1')
 assert.equal(r.body.messages[3].tool_call_id,'call_1')
 assert.equal(r.body.tools[0].function.name,'shell_command')
})
test('custom tool converted and restored',()=>{
 const d=responsesToChat({model:'deepseek-v4.1-flash',input:'hello',tools:[{type:'custom',name:'apply_patch',format:{type:'grammar'}}]})
 const out=chatToResponses({model:'deepseek-v4.1-flash',choices:[{message:{tool_calls:[{id:'call_2',type:'function',function:{name:'apply_patch',arguments:'{"input":"*** Begin Patch"}'}}]}}]},'deepseek-v4.1-flash',d.customTools)
 assert.equal(out.output[0].type,'custom_tool_call')
 assert.equal(out.output[0].input,'*** Begin Patch')
})
test('fail closed on unknown attachments',()=>{
 assert.throws(()=>responsesToChat({model:'m',input:[{role:'user',content:[{type:'input_audio',audio:'x'}]}]}),UnsupportedResponsesInput)
})
test('chat SSE framed as ordered Responses events',async()=>{
 const res=new FakeResponse()
 const s='data: '+JSON.stringify({choices:[{index:0,delta:{content:'Hi'}}]})+'\n\n'+'data: '+JSON.stringify({choices:[{index:0,delta:{content:'!'}}],usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4}})+'\n\n'+'data: [DONE]\n\n'
 const done=await relayChatAsResponses(res,chunks(s),{model:'deepseek-v4.1-flash'})
 assert.equal(done.completed,true)
 assert.equal(res.status,200)
 assert.ok(res.body.indexOf('response.output_item.added')<res.body.indexOf('response.content_part.added'))
 assert.ok(res.body.indexOf('response.content_part.added')<res.body.indexOf('response.output_text.delta'))
 assert.match(res.body,/response\.completed/)
 assert.match(res.body,/Hi!/)
})
function makeCtx(wire='chat'){
 const state={cfg:{models:{'deepseek-v4.1-flash':{provider:'go'}},providers:{go:{apiKeyEnv:'OPENCODE_API_KEY'}}},log:{warn(){},info(){}}}
 const prov={api:'openai',apiKey:'x',keyOk:true,baseUrl:'https://opencode.ai/inference/go',_def:{codexWire:wire,opencodeSession:true,omitStreamOptions:true},extraHeaders:{}}
 return {state,buildProvider:()=>prov}
}
test('session IDs native to Codex are reused for OpenCode',async()=>{
 const req={headers:{'session-id':'ses-123'}}
 assert.equal(codexSession(req,{}),'ses-123')
 const res=new FakeResponse()
 const {state,buildProvider}=makeCtx()
 let observed
 const forward=async (prov,path,method,headers,bytes,opts)=>{
   observed={path,headers,body:JSON.parse(bytes.toString()),opts}
   return {ok:true,status:200,headers:{'content-type':'application/json'},stream:chunks(JSON.stringify({model:'deepseek-v4.1-flash',choices:[{message:{content:'ok'}}]}))}
 }
 await handleCodexResponses({req,res,body:{model:'deepseek-v4.1-flash',input:'hello'},state,forward,buildProvider})
 assert.equal(res.status,200)
 assert.equal(JSON.parse(res.body).output[0].content[0].text,'ok')
 assert.equal(observed.path,'/openai/v1/chat/completions')
 assert.equal(observed.headers['x-opencode-session'],'ses-123')
 assert.equal(observed.opts.retry.maxAttempts,1)
 assert.equal(observed.opts.noRetry429,true)
 assert.equal(observed.body.stream_options,undefined)
})
test('original upstream 429 and Retry-After are kept (no blind retry)',async()=>{
 const res=new FakeResponse()
 const {state,buildProvider}=makeCtx()
 await handleCodexResponses({req:{headers:{'session-id':'same'}},res,body:{model:'deepseek-v4.1-flash',input:'hi'},state,buildProvider,forward:async()=>({ok:false,status:429,headers:{'retry-after':'31'},stream:chunks('{"error":"rate"}')} )})
 assert.equal(res.status,429)
 assert.equal(res.headers['retry-after'],'31')
 assert.match(res.body,/rate/)
})
test('reject missing stable OpenCode session before upstream call',async()=>{
 const res=new FakeResponse()
 const {state,buildProvider}=makeCtx()
 await handleCodexResponses({req:{headers:{}},res,body:{model:'deepseek-v4.1-flash',input:'hi'},state,buildProvider,forward:()=>{throw Error('should not reach network')}})
 assert.equal(res.status,400)
 assert.match(res.body,/missing_session/)
})
test('decline governance bypass for quota-controlled model',async()=>{
 const res=new FakeResponse()
 const {state,buildProvider}=makeCtx()
 state.cfg.models['deepseek-v4.1-flash'].quota=1
 await handleCodexResponses({req:{headers:{'session-id':'same'}},res,body:{model:'deepseek-v4.1-flash',input:'hi'},state,buildProvider,forward:()=>{throw Error('must not call upstream')}})
 assert.equal(res.status,422)
 assert.match(res.body,/unsupported_route/)
})
