const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function getJobStore(event) {
  try { connectLambda(event); } catch (_) {}
  try { return getStore("story-jobs"); } catch (_) {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "story-jobs", siteID, token });
    throw new Error("Netlify Blobs chưa cấu hình. Hãy cấu hình Netlify Blobs hoặc NETLIFY_SITE_ID + NETLIFY_API_TOKEN.");
  }
}
function hashSecret(v) { return crypto.createHash("sha256").update(String(v || "")).digest("hex"); }
function jsonResponse(statusCode, obj) {
  return { statusCode, headers: { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type", "Content-Type":"application/json" }, body: JSON.stringify(obj) };
}
function encryptApiKey(apiKey) {
  const secret = process.env.JOB_SECRET || process.env.NETLIFY_JOB_SECRET || process.env.NETLIFY_API_TOKEN || "";
  if (!secret) return { encrypted:false, value:apiKey };
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(apiKey,"utf8"), cipher.final()]);
  return { encrypted:true, value:`${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}` };
}
function genSecret(){ return crypto.randomBytes(32).toString("base64url"); }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  if (event.httpMethod !== "POST") return jsonResponse(405, { error:"Method not allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const storyState = body.storyState;
    const apiKey = String(body.apiKey || "").trim().replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "");
    if (!storyState || !apiKey) return jsonResponse(400, { error:"Thiếu storyState hoặc API key" });
    if (JSON.stringify(storyState).length > 8_000_000) return jsonResponse(413, { error:"Story state quá lớn. Hãy backup/nén chương cũ trước khi gửi background." });

    const store = getJobStore(event);
    const jobId = "job_" + Date.now().toString(36) + "_" + crypto.randomBytes(6).toString("hex");
    const accessToken = genSecret();
    const workerToken = genSecret();
    const apiKeyEncrypted = encryptApiKey(apiKey);
    const now = Date.now();
    const job = {
      schemaVersion: 9,
      jobId,
      storyId: storyState.storyId || null,
      baseChapterCount: Array.isArray(storyState.chapters) ? storyState.chapters.length : 0,
      status:"pending",
      createdAt:now,
      updatedAt:now,
      apiEndpoint:body.apiEndpoint || DEFAULT_ENDPOINT,
      model:body.model || "deepseek/deepseek-v3.2",
      modelNsfw:body.modelNsfw || "aion-labs/aion-2.0",
      forceNsfw:!!body.forceNsfw,
      apiKeyEncrypted,
      apiKey:null,
      accessTokenHash:hashSecret(accessToken),
      workerTokenHash:hashSecret(workerToken),
      storyState,
      resultChapter:null,
      error:null,
      progress:"Đang chờ bắt đầu..."
    };
    await store.setJSON(jobId, job);

    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
    if (!siteUrl) throw new Error("Không xác định được URL Netlify để kích hoạt background function.");

    // Background Function trả 202 ngay; await ở đây chỉ đảm bảo request kích hoạt đã được gửi.
    const trigger = await fetch(siteUrl + "/.netlify/functions/write-chapter-background", {
      method:"POST",
      headers:{"Content-Type":"application/json","X-Worker-Token":workerToken},
      body:JSON.stringify({jobId, workerToken})
    });
    if (!trigger.ok && trigger.status !== 202) {
      const t = await trigger.text().catch(()=>"");
      job.status="failed"; job.error=`Không kích hoạt được background (${trigger.status}): ${t.slice(0,300)}`; job.updatedAt=Date.now();
      await store.setJSON(jobId, job);
      return jsonResponse(502, { error:job.error });
    }

    return jsonResponse(200, {
      success:true,
      jobId,
      accessToken,
      message:"Job đã được tạo. Có thể đóng/tắt iPhone; khi mở lại app sẽ tự kiểm tra và đồng bộ."
    });
  } catch (err) {
    console.error("create-job v9:", err);
    return jsonResponse(500, { error:err.message || "Lỗi server" });
  }
};
