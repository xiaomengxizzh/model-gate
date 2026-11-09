// ModelGate Next: dependency-free, read-only preview. Dynamic values only via textContent.
const S = {view:'overview', status:null, config:null, token:'', busy:false, theme:'light', loadedAt:null, logs:null, logFilter:''};
const $ = (id) => document.getElementById(id);
const VIEWS = {overview:'总览',providers:'上游供应商',models:'模型与路由',clients:'客户端接入',diagnostics:'监控与诊断',settings:'安全与设置'};
const num = (x) => Number.isFinite(Number(x)) ? Number(x).toLocaleString('zh-CN',{maximumFractionDigits:1}) : '—';
const ms = (x) => Number.isFinite(Number(x)) && Number(x)>0 ? num(x)+' ms' : '—';
const pct = (x) => Number.isFinite(Number(x)) ? num(x)+'%' : '—';
const byId = (id) => document.getElementById(id);
const node = (tag,cls,text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
const add = (parent,...children) => {children.filter(Boolean).forEach(x=>parent.append(x));return parent;};
const txt = (parent,tag,cls,value) => add(parent,node(tag,cls,value));
const safeUrl = (str) => {try{const u=new URL(String(str));return u.protocol+'//'+u.hostname+(u.port?':'+u.port:'')+(u.pathname==='/'?'':u.pathname);}catch{return '未配置或地址不可用';}};
const badge = (label,variant='muted') => node('span','tag '+variant,label);
const statusKind = (s) => s==='ok'||s==='healthy'?'good':s==='open'||s==='error'||s==='failed'?'bad':s==='half'||s==='degraded'?'warn':'muted';
const statusLabel = (s) => ({ok:'正常',healthy:'正常',open:'熔断',half:'半开',degraded:'降级',error:'异常',failed:'失败'})[s]||'未知';
const toast = (message) => {const e=$('toast');e.textContent=message;e.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>e.hidden=true,3600);};
const code = (value) => node('code','mono',value);
const copyButton = (value,label='复制') => {const b=node('button','button',label);b.type='button';b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(value);toast('已复制到剪贴板');}catch{toast('无法复制，请手动选取内容');}});return b;};
const goOld = (label='在旧控制台编辑 ↗') => {const a=node('a','button',label);a.href='/';a.target='_blank';a.rel='noopener noreferrer';return a;};
function page(title,desc,kicker='CONTROL PLANE') {
  const wrap=node('div','page-intro');
  const main=node('div');
  txt(main,'div','eyebrow',kicker);txt(main,'h1','',title);txt(main,'p','',desc);add(wrap,main);
  return wrap;
}
function panel(title,subtitle,action){
  const root=node('section','panel'),head=node('div','panel-header'),left=node('div');
  txt(left,'h2','',title);if(subtitle)txt(left,'p','',subtitle);
  add(head,left);if(action)add(head,action);
  const body=node('div','panel-body');add(root,head,body);
  return {root,body};
}
function empty(target,title,subtitle){
  const e=node('div','empty'),i=node('span','empty-icon','◌');
  txt(e,'strong','',title);txt(e,'span','',subtitle);e.prepend(i);add(target,e);
}
function alertBox(text,isError=false){
  return node('div','alert'+(isError?' alert-danger':''),text);
}
function item(label,desc,right){
  const r=node('div','stack-row'),left=node('div');
  txt(left,'div','row-primary',label);
  if(desc)txt(left,'div','row-secondary',desc);
  add(r,left,right||node('span','muted','—'));return r;
}
function metric(label,value,foot,symbol){
  const c=node('div','metric'),lab=node('div','metric-label'),sym=node('span','muted',symbol||'↗');
  txt(lab,'span','',label);add(lab,sym);
  add(c,lab);txt(c,'div','metric-value',value);txt(c,'div','metric-foot',foot);return c;
}
function chart(target,points){
  const pts=(Array.isArray(points)?points:[]).filter(p=>p&&Number.isFinite(Number(p.v))&&Number.isFinite(Number(p.t)));
  if(pts.length<2 || !pts.some(p=>Number(p.v)>0)){empty(target,'暂无趋势数据','网关尚未累积足够的真实延迟样本');return;}
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 600 180');svg.setAttribute('class','chart');svg.setAttribute('role','img');svg.setAttribute('aria-label','最近延迟趋势，单位毫秒');
  const ymax=Math.max(1,...pts.map(p=>Number(p.v)))*1.13;
  const coords=pts.map((p,i)=>[12+i*576/(pts.length-1),160-Number(p.v)/ymax*137]);
  const ns='http://www.w3.org/2000/svg';
  const makePath=(d,stroke,fill,width)=>{const p=document.createElementNS(ns,'path');p.setAttribute('d',d);p.setAttribute('stroke',stroke);p.setAttribute('fill',fill);p.setAttribute('stroke-width',width||'2.5');p.setAttribute('stroke-linecap','round');p.setAttribute('stroke-linejoin','round');return p;};
  [45,100,160].forEach(y=>add(svg,makePath('M12 '+y+' H588','var(--line)','none','1')));
  const path=coords.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  add(svg,makePath(path+' L'+coords[coords.length-1][0].toFixed(1)+' 160 L12 160 Z','none','rgba(13,169,149,.09)','0'));
  add(svg,makePath(path,'var(--accent)','none','3'));
  add(target,svg);
  const axis=node('div','chart-axis');
  add(axis,node('span','',new Date(Number(pts[0].t)).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})),node('span','', '峰值 '+num(Math.max(...pts.map(p=>p.v)))+' ms'),node('span','',new Date(Number(pts[pts.length-1].t)).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));add(target,axis);
}
function viewOverview(root){
  add(root,page('一切模型，尽在掌控。','统一观察网关运行状态、路由和请求趋势。所有数据均来自当前连接的本地实例。','GATEWAY / OVERVIEW'));
  const s=S.status||{},g=s.global||{},ps=Array.isArray(s.providers)?s.providers:[],models=Array.isArray(s.models)?s.models:[];
  const hero=node('section','hero'),left=node('div'),ey=node('div','eyebrow','SYSTEM STATUS');
  add(left,ey);txt(left,'h2','', 'ModelGate 已连接');
  txt(left,'p','', '控制面运行中 · 版本 '+(s.configVersion??'未知')+' · '+ps.length+' 个供应商 / '+models.length+' 个真实模型');
  const act=node('button','hero-action','查看模型路由 ↗');act.addEventListener('click',()=>switchView('models'));add(hero,left,act);add(root,hero);
  const m=node('div','metric-grid');
  add(m,metric('累计请求',num(g.requests),'网关统计口径 / 累计','↗'),
    metric('错误请求',num(g.errors),'累计失败请求','!'),
    metric('累计 Token',num(g.tokenCount),'来源于实际 usage 的累计统计','◈'),
    metric('P95 延迟',ms(g.p95),'按网关实际延迟样本计算','◷'));
  add(root,m);
  const grid=node('div','content-grid'),cp=panel('请求延迟趋势','最近已有的延迟采样 · 毫秒'),rp=panel('上游健康状态','依据当前已知状态，非实时自动探针');
  chart(cp.body,g.latTrend);
  if(!ps.length)empty(rp.body,'尚未配置上游','请在原管理台添加 Provider 后刷新');
  for(const p of ps.slice(0,6)){const st=p.st||{};add(rp.body,item(p.id,(p.api||'openai')+' · '+num(st.requests||0)+' 次请求',badge(statusLabel(st.state),statusKind(st.state))));}
  add(grid,cp.root,rp.root);add(root,grid);
  const lower=node('div','content-grid'),last=panel('最近路由','显示最后一次完成路由的模型与 Provider'),notice=panel('运行提示','只读预览版本 / 不触发上游调用');
  if(s.lastServing) {const l=s.lastServing;add(last.body,item(l.model||'—','服务 Provider：'+(l.provider||'—'),badge('最近一次','good')));}
  else empty(last.body,'暂无请求记录','当有模型请求完成时，这里会出现路由信息');
  if(s.cache&&s.cache.alert)add(notice.body,alertBox('缓存提醒：'+(s.cache.alert.msg||'命中率发生变化'),true));
  else add(notice.body,alertBox('配置编辑与 Key 操作仍由旧控制台承担；此处不自动发送付费请求。'));
  add(notice.body,goOld('进入现有管理台 ↗'));add(lower,last.root,notice.root);add(root,lower);
}
function viewProviders(root){
  add(root,page('上游供应商','查看 Provider、协议与已知健康指标。凭据值不在新版界面显示。','CONNECTIVITY / PROVIDERS'));
  const toolbar=node('div','toolbar');const text=node('span','page-note','供应商数据来自 /api/status · 不执行自动探活');add(toolbar,text,goOld());add(root,toolbar);
  const grid=node('div','list-cards');const ps=S.status?.providers||[];
  if(!ps.length)empty(grid,'未连接任何 Provider','到旧控制台添加第一个供应商');
  ps.forEach(p=>{const card=node('article','panel provider-card'),top=node('div','provider-top'),identity=node('div'),row=node('div','inline-actions'),avatar=node('div','provider-avatar',(p.id||'P').slice(0,1).toUpperCase());
    add(identity,txt(node('div'),'h3','provider-name',p.id),node('p','provider-sub',(p.api||'openai').toUpperCase()+' / '+(p.hasKey?'凭据已设置':'凭据未检测到')));
    add(row,avatar,identity);add(top,row,badge(statusLabel(p.st?.state),statusKind(p.st?.state)));add(card,top);
    txt(card,'div','provider-url',safeUrl(p.baseUrl));
    const bottom=node('div','provider-bottom');
    [['请求',num(p.st?.requests||0)],['错误',num(p.st?.errors||0)],['P95',ms(p.st?.p95)]].forEach(it=>{const x=node('div');txt(x,'small','',it[0]);txt(x,'strong','',it[1]);add(bottom,x);});add(card,bottom);add(grid,card);
  });add(root,grid);
}
async function showRoute(model,box,btn){
  btn.disabled=true;box.replaceChildren(node('div','muted','正在读取只读路由预览…'));
  try{
    const data=await request('/api/route-preview',{method:'POST',body:{model}});
    const hit=data.hit||{},lines=[];
    lines.push('入口模型：'+model);lines.push('匹配类型：'+(hit.type||'未知'));
    if(hit.provider)lines.push('默认 Provider：'+hit.provider);
    if(Array.isArray(hit.directory))hit.directory.forEach((e,i)=>lines.push((i+1)+'. '+(e.model||'—')+' / '+(e.mode||'afterAll')+' / '+(Array.isArray(e.providers)?e.providers.join(' → '):'')));
    if(hit.note)lines.push('说明：'+hit.note);
    box.replaceChildren(node('pre','code-surface',lines.join('\n')));
  }catch(e){box.replaceChildren(alertBox('路由预览失败：'+e.message,true));}
  finally{btn.disabled=false;}
}
function viewModels(root){
  add(root,page('模型与路由','展示真实模型、虚拟模型和关联 Provider；路由预览不会发起模型推理。','CATALOG / ROUTING'));
  const s=S.status||{},all=[...(s.models||[]).map(x=>({...x,_virtual:false})),...(s.virtualModels||[]).map(x=>({...x,_virtual:true}))];
  const tools=node('div','toolbar'),search=node('input','search'),actions=node('div','inline-actions');
  search.placeholder='搜索模型名称 / 供应商…';search.type='search';search.setAttribute('aria-label','搜索模型');
  add(actions,badge('共 '+all.length+' 个入口'),goOld());add(tools,search,actions);add(root,tools);
  const p=panel('模型目录','点击“预览”检查路由，不会消耗上游额度'),tableSlot=node('div','data-table-wrap'),routeBox=node('div','');
  p.body.style.padding='0';
  const renderRows=()=>{tableSlot.replaceChildren();const matches=all.filter(m=>(m.name+' '+(m.provider||'')).toLowerCase().includes(search.value.toLowerCase()));
    if(!matches.length){empty(tableSlot,'没有匹配的模型','尝试调整搜索词');return;}
    const table=node('table','data-table'),thead=node('thead'),hr=node('tr');
    ['模型','类型','主要 Provider / 链路','累计请求','额度 / Token','操作'].forEach(n=>txt(hr,'th','',n));add(thead,hr);const tbody=node('tbody');
    matches.forEach(m=>{const tr=node('tr'),name=node('td'),provider=node('td'),actions=node('td'),b=node('button','button','预览');
      txt(name,'div','strong',m.name);txt(name,'small','',Array.isArray(m.alias)&&m.alias.length?'别名：'+m.alias.join(', '):'');add(tr,name);
      const kind=node('td');add(kind,badge(m._virtual?'虚拟入口':(m.capability||'chat'),m._virtual?'warn':'muted'));add(tr,kind);
      txt(provider,'span','mono',m._virtual?(m.directory||[]).map(x=>x.model).join(' → '):(m.provider||'—'));add(tr,provider);
      txt(tr,'td','mono',num(m.requests||0));txt(tr,'td','mono',m.dailyQuota>0?num(m.today||0)+' / '+num(m.dailyQuota):num(m.tokens||0)+' tk');
      b.addEventListener('click',()=>showRoute(m.name,routeBox,b));add(actions,b);add(tr,actions);add(tbody,tr);
    });add(table,thead,tbody);add(tableSlot,table);};
  search.addEventListener('input',renderRows);renderRows();add(p.root,tableSlot);add(root,p.root);
  const route=panel('路由解释','预览结果不会包含任何 Key 或用户消息内容');
  routeBox.className='';add(route.body,routeBox);empty(routeBox,'选择一个模型','点击目录最右侧“预览”查看实际匹配链');add(root,route.root);
}
function viewClients(root){
  add(root,page('客户端接入','将已有模型 API 集中通过同一个本地地址访问。此处只提供连接信息，不读取客户端的认证文件。','INTEGRATIONS / CLIENTS'));
  const base=location.origin+'/v1',top=panel('本地服务入口','复制 Base URL，然后在客户端配置模型名');
  const actions=node('div','inline-actions');add(actions,copyButton(base,'复制 Base URL'),goOld('配置模型 ↗'));
  add(top.body,node('pre','code-surface',base),actions,alertBox('当前未探测 Codex 或 DSH 的连接状态。支持何种 wire 取决于实际模型配置和上游能力。'));add(root,top.root);
  const grid=node('div','content-grid');const cod=panel('Codex CLI / Desktop','以 Responses 为主要兼容入口'),dsh=panel('DSH 与 OpenAI 兼容客户端','按上游模型协议选择 Chat 或 Responses');
  const ccode='base_url = "'+base+'"\nwire_api = "responses"\n# 模型与 provider 名称需与你的本机配置一致';
  add(cod.body,node('pre','code-surface',ccode),alertBox('Chat 桥可能丢弃 namespace/web_search 等托管工具。需要完整工具能力时优先评估原生 Responses 上游。'));
  add(dsh.body,node('pre','code-surface','Base URL: '+base+'\nChat: POST /v1/chat/completions\nResponses: POST /v1/responses'),alertBox('DSH 的模型目录需要登记目标模型；网关返回 /v1/models 并不能自动绕过客户端模型白名单。'));
  add(grid,cod.root,dsh.root);add(root,grid);
}
async function loadLogs(host){
  host.replaceChildren(node('div','muted','正在读取最近日志…'));
  try{
    const r=await request('/api/logs?lines=150');S.logs=Array.isArray(r.lines)?r.lines:[];
    const pre=node('pre','code-surface');
    pre.textContent=S.logs.filter(l=>l.toLowerCase().includes((S.logFilter||'').toLowerCase())).slice(-150).join('\n')||'暂无可显示的日志记录';
    host.replaceChildren(pre);
  }catch(e){host.replaceChildren(alertBox('日志读取失败：'+e.message,true));}
}
function viewDiagnostics(root){
  add(root,page('监控与诊断','从真实网关读取错误、延迟和脱敏日志。不会自动调用上游模型。','OPERATIONS / DIAGNOSTICS'));
  const s=S.status||{},g=s.global||{},metrics=node('div','metric-grid');
  add(metrics,metric('请求',num(g.requests),'累计网关请求','↗'),metric('重试',num(g.retries),'累计重试','↻'),metric('流中断',num(g.interrupts),'累计中断','⚑'),metric('平均延迟',ms(g.avgMs),'真实请求统计','◷'));add(root,metrics);
  const p=panel('最近日志','最多展示最近 150 行 · 日志中仍可能含业务元数据，请谨慎分享');
  const toolbar=node('div','toolbar'),search=node('input','search'),reload=node('button','button','重新读取日志');search.type='search';search.placeholder='仅在当前页面筛选…';
  search.setAttribute('aria-label','筛选日志');const host=node('div');
  search.addEventListener('input',()=>{S.logFilter=search.value;if(S.logs){const pre=node('pre','code-surface',S.logs.filter(l=>l.toLowerCase().includes(S.logFilter.toLowerCase())).slice(-150).join('\n')||'无匹配日志');host.replaceChildren(pre);}});
  reload.addEventListener('click',()=>loadLogs(host));add(toolbar,search,reload);add(p.body,toolbar,host);add(root,p.root);loadLogs(host);
}
function kv(label,value){const row=node('div','kv');txt(row,'div','k',label);txt(row,'div','v',value);return row;}
function viewSettings(root){
  add(root,page('安全与设置','以只读方式核查网关版本、绑定和管理面状态。编辑与密钥管理继续使用旧控制台。','GOVERNANCE / SETTINGS'));
  const s=S.status||{},p=panel('实例信息','来源：/api/status 与 /api/config'),body=p.body;
  add(body,kv('实例地址',location.origin),kv('配置版本',String(S.config?.configVersion??s.configVersion??'未知')),kv('绑定主机',s.server?.host||'—'),kv('端口',String(s.server?.port||'—')),kv('管理令牌',s.needAuth?'已启用':'未启用'),kv('密钥文件加密',s.server?.keyEncrypted?'已检测到':'未确认'),kv('进程运行时间',Number.isFinite(Number(s.uptimeMs))?num(Math.round(Number(s.uptimeMs)/60000))+' 分钟':'—'));
  add(body,alertBox('当前为 UI 初稿：保存配置、上传凭据、恢复备份等写操作不会从此页面触发。'));
  add(body,goOld('前往现有安全设置 ↗'));add(root,p.root);
  const q=panel('后续前端集成门槛','完成后才能替换正式入口');
  const timeline=node('div','timeline');
  [['F0','API 字段和旧功能完整对照'],['F1','全新框架、主题、导航与只读联通'],['F2','配置事务、Key 操作、409 版本冲突'],['F3','诊断、连接向导、真实测试反馈'],['F4–F5','浏览器、可访问性、安全审计及影子部署']].forEach(x=>{const row=node('div','timeline-item');add(row,node('span','timeline-step',x[0]));const d=node('div');txt(d,'strong','',x[1]);txt(d,'p','','当前初稿不代表该阶段已通过最终验收');add(row,d);add(timeline,row);});add(q.body,timeline);add(root,q.root);
}
function render(){
  const root=$('view-content');if(!root)return;root.replaceChildren();
  $('current-view-name').textContent=VIEWS[S.view];
  document.querySelectorAll('.nav-link').forEach(b=>{const on=b.dataset.view===S.view;b.classList.toggle('is-active',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if(!S.status){add(root,page('暂时无法连接本地网关','请确认当前实例正在运行，然后点击刷新。'));add(root,alertBox('没有读取到 /api/status；不会显示模拟统计数据。',true));return;}
  ({overview:viewOverview,providers:viewProviders,models:viewModels,clients:viewClients,diagnostics:viewDiagnostics,settings:viewSettings}[S.view]||viewOverview)(root);
  const p=$('side-pulse');p.className='pulse pulse-good';$('side-status').textContent='网关在线 · '+(S.status.server?.port||'local');
}
function switchView(view){if(!VIEWS[view])return;S.view=view;S.logFilter='';render();$('view-content').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
async function request(path,opts={}){
  const h={'accept':'application/json'};if(S.token)h.authorization='Bearer '+S.token;if(opts.body!==undefined)h['content-type']='application/json';
  const r=await fetch(path,{method:opts.method||'GET',headers:h,body:opts.body===undefined?undefined:JSON.stringify(opts.body),cache:'no-store',credentials:'same-origin'});
  let data;try{data=await r.json();}catch{data={};}
  if(r.status===401){$('auth-overlay').hidden=false;throw new Error('需要有效的管理令牌');}
  if(!r.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||('HTTP '+r.status));
  return data;
}
async function refresh(){
  if(S.busy)return;S.busy=true;$('refresh').disabled=true;
  try{
    const auth=await fetch('/api/auth',{cache:'no-store'});if(!auth.ok)throw new Error('无法读取 /api/auth');
    const a=await auth.json();if(a.needAuth&&!S.token){$('auth-overlay').hidden=false;$('admin-token').focus();return;}
    const data=await Promise.all([request('/api/status'),request('/api/config')]);
    S.status=data[0];S.config=data[1];S.loadedAt=Date.now();$('auth-overlay').hidden=true;
    render();toast('已读取网关最新状态');
  }catch(e){
    if(!S.status){const root=$('view-content');root.replaceChildren(page('连接失败','无法读取本地网关控制面'));add(root,alertBox(e.message,true));}
    else toast('刷新失败：'+e.message);
    $('side-status').textContent='连接异常';$('side-pulse').className='pulse pulse-bad';
  }finally{S.busy=false;$('refresh').disabled=false;}
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
$('refresh').addEventListener('click',refresh);
$('theme-toggle').addEventListener('click',()=>{S.theme=S.theme==='light'?'dark':'light';document.documentElement.dataset.theme=S.theme;});
$('auth-form').addEventListener('submit',async(e)=>{e.preventDefault();S.token=$('admin-token').value.trim();$('admin-token').value='';$('auth-error').textContent='';await refresh();if(!$('auth-overlay').hidden){$('auth-error').textContent='令牌未通过验证，或网关不可用。';S.token='';}});
refresh();
