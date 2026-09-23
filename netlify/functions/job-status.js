const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

function getJobStore(event) {
  try { connectLambda(event); } catch (_) {}
  try { return getStore("story-jobs"); } catch (_) {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name:"story-jobs", siteID, token });
    throw new Error("Netlify Blobs chưa cấu hình.");
  }
}
function hashSecret(v){ return crypto.createHash("sha256").update(String(v||"")).digest("hex"); }
function equalHash(a,b){ try{return crypto.timingSafeEqual(Buffer.from(a||""),Buffer.from(b||""));}catch(_){return false;} }
function jsonResponse(statusCode,obj){return {statusCode,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Content-Type":"application/json"},body:JSON.stringify(obj)};}

exports.handler = async (event) => {
  if(event.httpMethod === "OPTIONS") return jsonResponse(204,{});
  if(event.httpMethod !== "GET") return jsonResponse(405,{error:"Method not allowed"});
  const jobId = event.queryStringParameters?.jobId;
  const accessToken = event.queryStringParameters?.token || (event.headers?.authorization||"").replace(/^Bearer\s+/i,"");
  if(!jobId) return jsonResponse(400,{error:"Missing jobId"});
  try{
    const store=getJobStore(event);
    const job=await store.get(jobId,{type:"json"});
    if(!job) return jsonResponse(404,{error:"Job not found"});
    if(job.accessTokenHash && !equalHash(job.accessTokenHash,hashSecret(accessToken))) return jsonResponse(403,{error:"Token không hợp lệ"});

    const safe={
      schemaVersion:job.schemaVersion||9,
      jobId:job.jobId,
      storyId:job.storyId||null,
      baseChapterCount:job.baseChapterCount||0,
      status:job.status,
      progress:job.progress,
      createdAt:job.createdAt,
      updatedAt:job.updatedAt,
      completedAt:job.completedAt||null,
      error:job.error||null,
      resultChapter:job.resultChapter||null,
      newChapterCount:job.storyState?.chapters?.length||0
    };
    if(job.status === "completed" && job.storyState) safe.storyState=job.storyState;
    return jsonResponse(200,safe);
  }catch(err){return jsonResponse(500,{error:err.message||"Lỗi server"});}
};
