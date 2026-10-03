const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
function cors(extra = {}) { return { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization, X-App-Passcode", "Cache-Control":"no-store", ...extra }; }
function json(obj,status=200){ return new Response(JSON.stringify(obj),{status,headers:{...cors(),"Content-Type":"application/json"}}); }
function b64u(bytes){ let s=""; const a=new Uint8Array(bytes); for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000)); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function token(){ return b64u(crypto.getRandomValues(new Uint8Array(32))); }
async function sha(v){ const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(v||""))); return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
async function encryptApiKey(apiKey,secret){ if(!secret)return {encrypted:false,value:apiKey}; const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(secret))); const key=await crypto.subtle.importKey("raw",h,{name:"AES-GCM"},false,["encrypt"]); const iv=crypto.getRandomValues(new Uint8Array(12)); const all=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(apiKey))); return {encrypted:true,value:`${b64u(iv)}.${b64u(all.slice(-16))}.${b64u(all.slice(0,-16))}`}; }
function endpoint(raw,env){ let u; try{u=new URL(String(raw||DEFAULT_ENDPOINT));}catch{return {ok:false,error:"Endpoint API không hợp lệ."};} if(u.protocol!=="https:")return {ok:false,error:"Endpoint API phải dùng https."}; const h=u.hostname.toLowerCase(); const allow=String(env.ALLOWED_API_HOSTS||"").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean); if(allow.length&&!allow.some(x=>h===x||h.endsWith("."+x)))return {ok:false,error:"Endpoint API không nằm trong danh sách được phép."}; return {ok:true,url:u.toString()}; }
export async function onRequestOptions(){ return new Response(null,{status:204,headers:cors()}); }
export async function onRequestPost({request,env}){
 try{
  const body=await request.json().catch(()=>({}));
  if(env.APP_PASSCODE && (request.headers.get("x-app-passcode")||body.passcode||"")!==env.APP_PASSCODE)return json({error:"Sai hoặc thiếu mã truy cập (APP_PASSCODE).",needPasscode:true},401);
  const storyState=body.storyState; const apiKey=String(body.apiKey||"").trim().replace(/^bearer\s+/i,"").replace(/^["']|["']$/g,"");
  if(!storyState||!apiKey)return json({error:"Thiếu storyState hoặc API key"},400);
  if(JSON.stringify(storyState).length>8000000)return json({error:"Story state quá lớn."},413);
  const ep=endpoint(body.apiEndpoint,env); if(!ep.ok)return json({error:ep.error},400);
  const jobId="job_"+Date.now().toString(36)+"_"+b64u(crypto.getRandomValues(new Uint8Array(6)));
  const accessToken=token(), workerToken=token();
  const job={schemaVersion:13,jobId,storyId:storyState.storyId||null,baseChapterCount:Array.isArray(storyState.chapters)?storyState.chapters.length:0,status:"pending",createdAt:Date.now(),updatedAt:Date.now(),apiEndpoint:ep.url,model:body.model||"deepseek/deepseek-v3.2",modelNsfw:body.modelNsfw||"aion-labs/aion-2.0",forceNsfw:!!body.forceNsfw,hintStyle:String(body.hintStyle||"normal").slice(0,20),hintFormat:String(body.hintFormat||"detail").slice(0,20),apiKeyEncrypted:await encryptApiKey(apiKey,env.JOB_SECRET||""),apiKey:null,accessTokenHash:await sha(accessToken),workerTokenHash:await sha(workerToken),storyState,resultChapter:null,error:null,progress:"Đang chờ bắt đầu..."};
  if(!env.STORY_JOBS)return json({error:"Cloudflare KV STORY_JOBS chưa được cấu hình."},500);
  if(!env.BACKGROUND_QUEUE)return json({error:"Cloudflare Queue BACKGROUND_QUEUE chưa được cấu hình."},500);
  await env.STORY_JOBS.put(jobId,JSON.stringify(job),{expirationTtl:86400});
  await env.BACKGROUND_QUEUE.send({jobId,workerToken});
  return json({success:true,jobId,accessToken,warnings:env.JOB_SECRET?[]:["JOB_SECRET chưa cấu hình — API key sẽ không được mã hóa khi lưu job."],message:"Job đã được tạo. Có thể đóng/tắt iPhone; app sẽ tự kiểm tra và đồng bộ."});
 }catch(err){ return json({error:err?.message||"Lỗi server khi tạo job"},500); }
}
export async function onRequest(){ return json({error:"Method not allowed"},405); }
