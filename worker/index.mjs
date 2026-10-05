import api from './api.cjs';
export { JobDO } from './job-do.mjs';

const DEFAULT_ENDPOINT='https://openrouter.ai/api/v1/chat/completions';
const cors=env=>({'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN||'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization, X-App-Passcode, X-Model-Mode, X-Primary-Model, X-Secondary-Model, X-NSFW-Model','Cache-Control':'no-store'});
const json=(env,status,obj)=>new Response(status===204?null:JSON.stringify(obj),{status,headers:{'Content-Type':'application/json',...cors(env)}});
const relay=(env,res)=>{const h=new Headers(res.headers);Object.entries(cors(env)).forEach(([k,v])=>h.set(k,v));return new Response(res.body,{status:res.status,headers:h})};
const stub=(env,id)=>env.JOBS.get(env.JOBS.idFromName(id));

function messageText(body){return(Array.isArray(body?.messages)?body.messages:[]).map(m=>typeof m?.content==='string'?m.content:'').join('\n')}
function wordCount(t){return String(t||'').trim().split(/\s+/).filter(Boolean).length}
function contentOf(d){const c=d?.choices?.[0]?.message?.content;return typeof c==='string'?c:Array.isArray(c)?c.map(x=>typeof x==='string'?x:x?.text||'').join(''):''}

const NSFW_RE=/(?:nsfw|18\+|cảnh\s*(?:nóng|sex|18)|viết\s*(?:nóng|18)|tình\s*dục|quan\s*hệ\s*tình\s*dục|cảnh\s*ân\s*ái|ân\s*ái|giao\s*hợp|erotic|erotica|porn|sex)/iu;
function hasNsfw(body){const text=messageText(body);return !!(body?.forceNsfw||body?.nsfw||body?.isNsfw||body?.matureFocus==='secondary'||body?.matureFocus==='nsfw'||NSFW_RE.test(text))}
function models(body,request){const hdr=n=>String(request?.headers?.get(n)||'').trim();const mode=String(body?.xuongModelMode||body?.modelMode||hdr('X-Model-Mode')||'none').toLowerCase();const primary=String(body?.primaryModel||body?.xuongPrimaryModel||hdr('X-Primary-Model')||body?.model||'').trim();const nsfw=String(body?.modelNsfw||body?.nsfwModel||body?.xuongNsfwModel||hdr('X-NSFW-Model')||body?.secondaryModel||body?.xuongSecondaryModel||hdr('X-Secondary-Model')||'').trim();return{mode,primary,nsfw}}

function isLongChapterRequest(body){
  const t=messageText(body).replace(/\s+/g,' ').trim();
  if(!t)return false;
  if(/(?:summary|tóm tắt|characterupdates|currentstatus|knowledgeledger|foreshadowing)/i.test(t)&&!/viết\s+(?:tiếp|chương)/i.test(t))return false;
  const hasChapter=/\bchương\s*\d+\b/i.test(t);
  const hasWrite=/(?:viết|soạn|tạo|sáng tác|tiếp tục|nội dung chương|tiểu thuyết)/i.test(t);
  const explicitLong=/(?:mục tiêu|khoảng|ít nhất|tối thiểu)\s*\d[\d,.]*\s*từ/i.test(t);
  const writerMarker=/(?:phần\s*1\s*của\s*quy\s*trình|phần\s*đầu|viết\s*tiếp\s*ngay)/i.test(t);
  return hasChapter&&hasWrite&&(explicitLong||writerMarker||t.length>1800);
}
function extractTarget(body){const n=Number(body?.targetWords||body?.minChapterWords||0);if(n>0)return Math.min(Math.max(n,3000),7000);const t=messageText(body);const m=t.match(/(?:mục tiêu|khoảng|ít nhất|tối thiểu)\s*(\d[\d,.]*)\s*từ/i)||t.match(/(\d[\d,.]*)\s*từ/i);const x=m?Number(String(m[1]).replace(/[,.]/g,'')):5000;return Math.min(Math.max(x||5000,3000),7000)}
function chooseModel(body,request){const m=models(body,request);if(hasNsfw(body)&&m.nsfw)return{active:m.nsfw,fallback:null,role:'NSFW'};if(m.mode==='secondary'&&m.nsfw)return{active:m.nsfw,fallback:null,role:'NSFW'};if(m.primary)return{active:m.primary,fallback:m.mode==='auto'&&m.nsfw&&m.nsfw!==m.primary?m.nsfw:null,role:'PRIMARY'};return{active:body.model||'deepseek/deepseek-v3.2',fallback:m.nsfw&&m.mode==='auto'?m.nsfw:null,role:'PRIMARY'}}

function normalizeBody(body,request){const b={...body};const p=chooseModel(b,request);b.model=p.active;b.stream=false;delete b.xuongModelMode;delete b.xuongPrimaryModel;delete b.xuongSecondaryModel;delete b.xuongNsfwModel;return b}
async function openRouterOnce(body,env,request,url){const key=String(env.OPENROUTER_API_KEY||'').trim()||(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!key)return new Response(JSON.stringify({error:'Chưa cấu hình OpenRouter API key'}),{status:401,headers:{'Content-Type':'application/json'}});const out=normalizeBody(body,request);const r=await fetch(out.apiEndpoint||DEFAULT_ENDPOINT,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key,'http-referer':url.origin,'x-title':'Xuong Truyen AI'},body:JSON.stringify(out)});return r}

async function callModel(body,env,request,url,forcedModel){const b={...body,model:forcedModel||body.model,stream:false,max_tokens:Math.max(Number(body.max_tokens)||0,9000)};const r=await openRouterOnce(b,env,request,url);if(!r.ok)return{res:r,text:'',model:forcedModel||b.model};const d=await r.clone().json().catch(()=>null);return{res:r,text:contentOf(d),model:d?.model||forcedModel||b.model}}

async function runLongChapter(body,env,request,url){
  const target=extractTarget(body),goal=Math.floor(target*.8),plan=chooseModel(body,request);let accumulated='',lastModel=plan.active,lastStatus=200;const maxRounds=8;
  for(let i=0;i<maxRounds&&wordCount(accumulated)<goal;i++){
    const first=i===0;const base=Array.isArray(body.messages)?body.messages:[];
    const prompt=first?base:[...base,{role:'user',content:`ĐÂY LÀ CÙNG MỘT CHƯƠNG. Văn bản đã viết hiện có ${wordCount(accumulated)} từ. Hãy viết TIẾP ngay từ đoạn cuối, không tóm tắt, không lặp lại, không kết thúc sớm. Thêm khoảng 1000-1600 từ tiếng Việt. Giữ nguyên canon, nhân vật, quan hệ, địa điểm và 1-3 sự kiện chính. Chỉ trả phần văn xuôi mới.\n<DA_VIET>\n${accumulated.slice(-24000)}\n</DA_VIET>`}];
    const reqBody={...body,messages:prompt,stream:false,max_tokens:10000};
    let result=await callModel(reqBody,env,request,url,plan.active);lastStatus=result.res.status;lastModel=result.model;
    if(!result.res.ok&&plan.fallback&&plan.fallback!==plan.active){result=await callModel(reqBody,env,request,url,plan.fallback);lastStatus=result.res.status;lastModel=result.model}
    if(!result.res.ok)break;
    let part=String(result.text||'').trim();let got=wordCount(part);
    if(got<500){const retryBody={...reqBody,messages:[...prompt,{role:'user',content:`Output vừa rồi chỉ có ${got} từ. Bắt buộc viết ít nhất 800 từ ở lượt này. Không được kết thúc chương.`]};const retry=await callModel(retryBody,env,request,url,lastModel);if(retry.res.ok&&wordCount(retry.text)>=500){part=retry.text;got=wordCount(part);lastModel=retry.model}}
    if(got<300)break;
    accumulated=accumulated?accumulated+'\n\n'+part:part;
  }
  if(!accumulated)return new Response(JSON.stringify({error:'Không nhận được nội dung từ model',status:lastStatus}),{status:502,headers:{'Content-Type':'application/json'}});
  const out={choices:[{index:0,message:{role:'assistant',content:accumulated},finish_reason:'stop'}],model:lastModel,object:'chat.completion',x_truyen_ai:{longChapter:true,wordCount:wordCount(accumulated),target,goal,model:lastModel,role:hasNsfw(body)?'NSFW':'PRIMARY'}};
  return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})
}

async function serveApp(request,env){const res=await env.ASSETS.fetch(request);const ct=res.headers.get('content-type')||'';if(!ct.includes('text/html'))return res;let html=await res.text();if(!html.includes('/hot-switch.js'))html=html.replace(/<\/body>/i,'<script src="/hot-switch.js" defer></script></body>');const h=new Headers(res.headers);h.delete('content-length');h.set('content-type','text/html; charset=UTF-8');return new Response(html,{status:res.status,statusText:res.statusText,headers:h})}

export default{async fetch(request,env){const u=new URL(request.url);if(request.method==='OPTIONS')return json(env,204,{});if(!u.pathname.startsWith('/api/'))return serveApp(request,env);if(!env.JOBS)return json(env,500,{error:'Durable Object JOBS chưa được bind'});const route=u.pathname.slice(5).replace(/\/+$/,'');
  if(route==='health')return json(env,200,{ok:true,service:'truyen-ai',architecture:'single-worker+durable-object+openrouter',durableObject:!!env.JOBS,openRouterConfigured:!!String(env.OPENROUTER_API_KEY||'').trim(),time:new Date().toISOString()});
  if(route==='ai'){if(request.method!=='POST')return json(env,405,{error:'Method not allowed'});let body;try{body=await request.json()}catch{return json(env,400,{error:'JSON không hợp lệ'})}if(!body?.model||!Array.isArray(body?.messages))return json(env,400,{error:'Thiếu model hoặc messages'});if(isLongChapterRequest(body))return runLongChapter(body,env,request,u);const p=chooseModel(body,request);const r=await callModel(body,env,request,u,p.active);return relay(env,r.res)}
  if(route==='create-job'||route==='bg/create-job'){if(request.method!=='POST')return json(env,405,{error:'Method not allowed'});const id=api.newJobId();const h=new Headers({'content-type':'application/json','x-job-id':id});const pc=request.headers.get('x-app-passcode');if(pc)h.set('x-app-passcode',pc);return relay(env,await stub(env,id).fetch('https://job/init',{method:'POST',headers:h,body:request.body}))}
  if(route==='job-status'||route==='bg/job-status'){if(request.method!=='GET')return json(env,405,{error:'Method not allowed'});const id=u.searchParams.get('jobId');if(!api.isJobId(id))return json(env,404,{error:'Job not found'});const h=new Headers();const au=request.headers.get('authorization');if(au)h.set('authorization',au);return relay(env,await stub(env,id).fetch('https://job/status'+u.search,{headers:h}))}
  return json(env,404,{error:'API route not found'})
}};
