const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function b64u(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unb64u(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function shaHex(v) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(v || "")));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function decryptApiKey(record, secret) {
  if (!record) return "";
  if (!record.encrypted) return String(record.value || "");
  if (!secret) throw new Error("JOB_SECRET chưa được cấu hình trên Background Worker");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(secret)));
  const key = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
  const [ivS, tagS, dataS] = String(record.value || "").split(".");
  if (!ivS || !tagS || !dataS) throw new Error("API key encrypted payload không hợp lệ");
  const iv = unb64u(ivS), tag = unb64u(tagS), data = unb64u(dataS);
  const ciphertext = new Uint8Array(data.length + tag.length);
  ciphertext.set(data); ciphertext.set(tag, data.length);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, ciphertext));
}
async function encryptApiKey(apiKey, secret) {
  if (!secret) throw new Error("JOB_SECRET chưa được cấu hình trên Background Worker");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(secret)));
  const key = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const all = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(String(apiKey || ""))));
  const tag = all.slice(-16), data = all.slice(0, -16);
  return { encrypted: true, value: `${b64u(iv)}.${b64u(tag)}.${b64u(data)}` };
}
function wordCount(s) { return String(s || "").trim().split(/\s+/).filter(Boolean).length; }
function compactState(st) {
  return {
    styleBible: st.styleBible || "",
    storyBible: st.storyBible || "",
    worldRules: st.worldRules || "",
    currentStatus: st.currentStatus || "",
    directive: st.directive || "",
    nextChapterHint: st.nextChapterHint || "",
    chapterOutline: st.chapterOutline || "",
    mainPlot: st.mainPlot || "",
    worldSetting: st.worldSetting || "",
    mainCharProfile: st.mainCharProfile || null,
    characters: Array.isArray(st.characters) ? st.characters.slice(-20) : [],
    locations: Array.isArray(st.locations) ? st.locations.slice(-20) : [],
    items: Array.isArray(st.items) ? st.items.slice(-20) : [],
    threads: Array.isArray(st.threads) ? st.threads.slice(-20) : [],
    foreshadowing: Array.isArray(st.foreshadowing) ? st.foreshadowing.slice(-20) : [],
    chapters: Array.isArray(st.chapters) ? st.chapters.slice(-2).map(c => ({ title: c.title, text: String(c.text || "").slice(-7000), summary: c.summary || "" })) : []
  };
}
function buildPrompt(st, n, target) {
  const brief = String(st.directive || st.nextChapterHint || st.chapterOutline || "").trim();
  return [
    `VIẾT CHƯƠNG ${n} BẰNG TIẾNG VIỆT.`,
    `Mục tiêu khoảng ${target} từ; không vượt ${Math.ceil(target * 1.15)} từ.`,
    "Chỉ 1–3 sự kiện chính. Không tự tạo nhân vật quan trọng mới. Giữ continuity tuyệt đối với canon và Current Status.",
    "Chia thành nhiều đoạn văn; thoại xuống đoạn riêng; không trả về JSON, không tiêu đề, không giải thích, không nói về AI.",
    brief ? `KẾ HOẠCH/MỆNH LỆNH CỦA NGƯỜI DÙNG — NGUỒN SỰ THẬT: ${brief}` : "Tiếp nối trực tiếp diễn biến hiện tại.",
    "CANON VÀ TRẠNG THÁI:", JSON.stringify(compactState(st))
  ].join("\n\n");
}
async function callModel(job, apiKey) {
  const st = job.storyState || {};
  const n = Array.isArray(st.chapters) ? st.chapters.length + 1 : 1;
  const target = Math.min(Math.max(Number(st.minChapterWords) || 5000, 500), 12000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(job.apiEndpoint || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://truyen-ai.pages.dev", "X-Title": "Xưởng Truyện AI V13.1" },
      body: JSON.stringify({
        model: job.model || "deepseek/deepseek-v3.2",
        temperature: 0.7,
        max_tokens: Math.min(16000, Math.max(5000, Math.round(target * 1.6))),
        messages: [
          { role: "system", content: "Bạn là engine viết tiểu thuyết dài kỳ V13.1. Viết tiếng Việt tự nhiên, giữ continuity, không tự mở subplot, tối đa 3 sự kiện chính." },
          { role: "user", content: buildPrompt(st, n, target) }
        ]
      }),
      signal: controller.signal
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${raw.slice(0, 700)}`);
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error("OpenRouter trả về JSON không hợp lệ"); }
    const content = String(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "").trim();
    if (!content) throw new Error("Model không trả về nội dung chương");
    return { n, target, text: content };
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("OpenRouter timeout sau 180 giây");
    throw e;
  } finally { clearTimeout(timer); }
}
async function processJob(jobId, workerToken, env) {
  const job = await env.STORY_JOBS.get(jobId, { type: "json" });
  if (!job) throw new Error("Job not found");
  if (job.workerTokenHash && job.workerTokenHash !== await shaHex(workerToken || "")) throw new Error("Worker token không hợp lệ");
  if (job.status === "completed" || job.status === "failed") return;
  job.status = "running";
  job.progress = "Đang viết chương...";
  job.updatedAt = Date.now();
  await env.STORY_JOBS.put(jobId, JSON.stringify(job));
  try {
    const apiKey = await decryptApiKey(job.apiKeyEncrypted, env.JOB_SECRET);
    if (!apiKey) throw new Error("API key không tồn tại hoặc không giải mã được");
    const result = await callModel(job, apiKey);
    const st = structuredClone(job.storyState || {});
    st.chapters = Array.isArray(st.chapters) ? st.chapters : [];
    const chapter = {
      title: `Chương ${result.n}`,
      text: result.text,
      wordCount: wordCount(result.text),
      summary: "",
      status: "SYNCED",
      modelUsed: job.model || "",
      generatedAt: Date.now(),
      createdBy: "background-v13.1-cloudflare"
    };
    st.chapters.push(chapter);
    st.currentChapterIndex = st.chapters.length - 1;
    job.storyState = st;
    job.resultChapter = chapter;
    job.status = "completed";
    job.progress = "Hoàn thành";
    job.completedAt = Date.now();
    job.updatedAt = Date.now();
    job.error = null;
    job.apiKeyEncrypted = null;
    job.apiKey = null;
    await env.STORY_JOBS.put(jobId, JSON.stringify(job));
  } catch (error) {
    job.status = "failed";
    job.error = error?.message || String(error);
    job.progress = `Lỗi: ${job.error}`;
    job.updatedAt = Date.now();
    job.apiKeyEncrypted = null;
    job.apiKey = null;
    await env.STORY_JOBS.put(jobId, JSON.stringify(job));
  }
}
async function fetchHandler(request, env) {
  const u = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method === "POST" && u.pathname.endsWith("/internal/encrypt")) {
    try {
      const body = await request.json();
      return Response.json(await encryptApiKey(body?.apiKey, env.JOB_SECRET));
    } catch (e) { return Response.json({ error: e.message || String(e) }, { status: 500 }); }
  }
  return Response.json({ ok: true, service: "truyen-ai-bg-v13.1", queueConsumer: true });
}
export default {
  async fetch(request, env) { return fetchHandler(request, env); },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const data = typeof message.body === "string" ? { jobId: message.body } : (message.body || {});
      if (!data.jobId) { message.ack(); continue; }
      await processJob(data.jobId, data.workerToken || "", env);
      message.ack();
    }
  }
};
