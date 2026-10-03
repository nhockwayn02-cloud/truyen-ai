/* Xưởng Truyện AI V13.1 — Cloudflare Background API
 * Netlify removed from runtime path.
 * create-job -> Worker-owned encryption -> KV + Queue
 * job-status -> KV
 * Pages no longer encrypts API keys with its own JOB_SECRET.
 */
const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const ALLOWED = new Set(["create-job", "job-status"]);

function cors(extra = {}) {
  return { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET, POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization, X-App-Passcode", "Cache-Control":"no-store", ...extra };
}
function b64u(bytes) { let s=""; const a=new Uint8Array(bytes); for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000)); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function randomToken(){ return b64u(crypto.getRandomValues(new Uint8Array(32))); }
async function shaHex(v){ const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(v||""))); return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
async function encryptApiKey(apiKey, service){
  const r = await service.fetch(new Request("https://internal/encrypt", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({apiKey}) }));
  const data = await r.json().catch(()=>({}));
  if(!r.ok || !data?.encrypted || !data?.value) throw new Error(data?.error || "Background Worker không mã hóa được API key.");
  return data;
}
function validEndpoint(raw, env){
  let u; try{u=new URL(String(raw||DEFAULT_ENDPOINT));}catch(_){return {ok:false,error:"Endpoint API không hợp lệ."};}
  if(u.protocol!=="https:") return {ok:false,error:"Endpoint API phải dùng https."};
  if(u.username||u.password) return {ok:false,error:"Endpoint API không được chứa user/password."};
  const h=u.hostname.toLowerCase();
  if((h==="localhost"||h.endsWith(".local")||h.endsWith(".internal")||/^127\./.test(h)||/^10\./.test(h)||/^192\.168\./.test(h))) return {ok:false,error:"Endpoint API trỏ tới địa chỉ nội bộ — bị chặn."};
  const allow=String(env.ALLOWED_API_HOSTS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean);
  if(allow.length&&!allow.some(x=>h===x||h.endsWith("."+x))) return {ok:false,error:"Endpoint API không nằm trong danh sách được phép."};
  return {ok:true,url:u.toString()};
}
function passcodeOk(req, body, env){ const need=env.APP_PASSCODE; if(!need)return true; return (req.headers.get("x-app-passcode")||body?.passcode||"")===need; }
function response(obj,status=200){ return Response.json(obj,{status,headers:cors({"Content-Type":"application/json"})}); }

async function createJob(req, env){
  if(req.method!=="POST") return response({error:"Method not allowed"},405);
  const body=await req.json().catch(()=>({}));
  if(!passcodeOk(req,body,env)) return response({error:"Sai hoặc thiếu mã truy cập (APP_PASSCODE).",needPasscode:true},401);
  const storyState=body.storyState;
  const apiKey=String(body.apiKey||"").trim().replace(/^bearer\s+/i,"").replace(/^["']|["']$/g,"");
  if(!storyState||!apiKey)return response({error:"Thiếu storyState hoặc API key"},400);
  if(JSON.stringify(storyState).length>8_000_000)return response({error:"Story state quá lớn."},413);
  const ep=validEndpoint(body.apiEndpoint||DEFAULT_ENDPOINT,env); if(!ep.ok)return response({error:ep.error},400);
  if(!env.BG_SERVICE)return response({error:"Cloudflare BG_SERVICE chưa được cấu hình."},503);
  const jobId="job_"+Date.now().toString(36)+"_"+b64u(crypto.getRandomValues(new Uint8Array(6)));
  const accessToken=randomToken(), workerToken=randomToken();
  const apiKeyEncrypted=await encryptApiKey(apiKey,env.BG_SERVICE);
  const job={schemaVersion:13,jobId,storyId:storyState.storyId||null,baseChapterCount:Array.isArray(storyState.chapters)?storyState.chapters.length:0,status:"pending",createdAt:Date.now(),updatedAt:Date.now(),apiEndpoint:ep.url,model:body.model||"deepseek/deepseek-v3.2",modelNsfw:body.modelNsfw||"aion-labs/aion-2.0",forceNsfw:!!body.forceNsfw,hintStyle:String(body.hintStyle||"normal").slice(0,20),hintFormat:String(body.hintFormat||"detail").slice(0,20),apiKeyEncrypted,apiKey:null,accessTokenHash:await shaHex(accessToken),workerTokenHash:await shaHex(workerToken),storyState,resultChapter:null,error:null,progress:"Đang chờ bắt đầu..."};
  await env.STORY_JOBS.put(jobId,JSON.stringify(job));
  await env.BACKGROUND_QUEUE.send({jobId,workerToken});
  return response({success:true,jobId,accessToken,warnings:[],message:"Job đã được tạo. Có thể đóng/tắt iPhone; app sẽ tự kiểm tra và đồng bộ."});
}

async function jobStatus(req, env){
  if(req.method!=="GET")return response({error:"Method not allowed"},405);
  const u=new URL(req.url), jobId=u.searchParams.get("jobId"), token=u.searchParams.get("token")||(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if(!jobId)return response({error:"Missing jobId"},400);
  const job=await env.STORY_JOBS.get(jobId,{type:"json"});
  if(!job)return response({error:"Job not found"},404);
  if(job.accessTokenHash && job.accessTokenHash!==(await shaHex(token)))return response({error:"Token không hợp lệ"},403);
  if(u.searchParams.get("ack")==="1"){
    if(job.status==="completed"||job.status==="failed"){await env.STORY_JOBS.delete(jobId);return response({deleted:true,jobId});}
    return response({error:"Job chưa kết thúc, không thể xoá."},409);
  }
  const safe={schemaVersion:job.schemaVersion||13,jobId:job.jobId,storyId:job.storyId||null,baseChapterCount:job.baseChapterCount||0,status:job.status,progress:job.progress,createdAt:job.createdAt,updatedAt:job.updatedAt,completedAt:job.completedAt||null,error:job.error||null,resultChapter:job.resultChapter||null,qualityGateFailed:!!job.qualityGateFailed,newChapterCount:job.storyState?.chapters?.length||0};
  if(job.status==="completed"&&job.storyState)safe.storyState=job.storyState;
  return response(safe);
}

export async function onRequest(context){
  const req=context.request;
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors()});
  const parts=context.params?.path, path=Array.isArray(parts)?parts.join("/"):String(parts||"");
  if(!ALLOWED.has(path))return response({error:"Cloudflare BG endpoint không được phép."},404);
  try{return path==="create-job"?await createJob(req,context.env):await jobStatus(req,context.env);}catch(err){console.error("Cloudflare BG API",err);return response({error:err.message||"Lỗi server"},500);}
}