const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

/*
 * Xưởng Truyện AI v9.1 — Background Worker
 *
 * Mục tiêu của bản này:
 * - Không mất toàn bộ NV khi JSON array bị cắt.
 * - Không để Status rỗng ghi đè Status cũ.
 * - Tách cập nhật NV/Thế giới thành nhiều lô nhỏ thay vì 1 JSON khổng lồ.
 * - Có retry + repair JSON + checkpoint sau từng bước.
 * - API key được mã hóa khi lưu vào Blobs nếu JOB_SECRET được cấu hình.
 * - Job-status dùng accessToken, không trả secret/API key.
 */

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;
let DEADLINE = Infinity; // đặt lại ở đầu handler
const timeLeft = () => DEADLINE - Date.now();

function getJobStore(event) {
  if (event) { try { connectLambda(event); } catch (_) {} }
  try { return getStore("story-jobs"); } catch (e) {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) return getStore({ name: "story-jobs", siteID, token });
    throw new Error("Netlify Blobs chưa cấu hình. Hãy cấu hình NETLIFY_SITE_ID + NETLIFY_API_TOKEN hoặc dùng Netlify Blobs mặc định.");
  }
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Worker-Token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(obj)
  };
}

function genId(prefix = "x") {
  return prefix + Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
}
function genSecret() { return crypto.randomBytes(32).toString("base64url"); }
function hashSecret(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function secretsEqual(a, b) { return crypto.timingSafeEqual(Buffer.from(a || ""), Buffer.from(b || "")); }

function encryptionKey() {
  const secret = process.env.JOB_SECRET || process.env.NETLIFY_JOB_SECRET || process.env.NETLIFY_API_TOKEN || "";
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}
function encryptText(text) {
  const key = encryptionKey();
  if (!key) return { encrypted: false, value: text };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return { encrypted: true, value: `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${enc.toString("base64url")}` };
}
function decryptText(record) {
  if (!record) return "";
  if (!record.encrypted) return record.value || "";
  const key = encryptionKey();
  if (!key) throw new Error("JOB_SECRET đã được dùng để mã hóa API key nhưng runtime hiện tại không có JOB_SECRET.");
  const [ivS, tagS, dataS] = String(record.value || "").split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivS, "base64url"));
  decipher.setAuthTag(Buffer.from(tagS, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataS, "base64url")), decipher.final()]).toString("utf8");
}

function countWords(text) { return (text || "").trim().split(/\s+/).filter(Boolean).length; }
function normalizeName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}
function stripFences(raw) {
  return String(raw || "")
    .replace(/```(?:json|JSON)?/g, "")
    .replace(/```/g, "")
    .replace(/\uFEFF/g, "")
    .trim();
}

/* ===== JSON parser v9.3 =====
 * Các lỗi cũ đã sửa:
 *  - Không còn đổi “ ” thành " toàn cục (làm hỏng JSON hợp lệ có thoại trong chuỗi).
 *  - Không còn "rơi" vào mảng/object con bên trong khi mảng/object ngoài bị hỏng hoặc bị cắt
 *    (trước đây trả về mảng relationships:[] rồi coi là thành công -> không cập nhật gì mà không báo lỗi).
 *  - Sửa lỗi cú pháp nhẹ: xuống dòng thô trong chuỗi, dấu phẩy thừa, dấu " lồng trong chuỗi.
 *  - Cứu phần JSON bị cắt bằng cách đóng ngoặc tại dấu phẩy hợp lệ gần nhất.
 *  - Kiểm tra khóa bắt buộc: JSON đúng cú pháp nhưng sai cấu trúc = thất bại (không còn im lặng bỏ qua).
 */
function fixJsonSyntax(s, healQuotes) {
  let out = "", inStr = false, esc = false;
  const nextSig = (k) => { while (k < s.length && /\s/.test(s[k])) k++; return s[k]; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') {
        if (healQuotes) {
          const nx = nextSig(i + 1);
          if (!(nx === undefined || nx === "," || nx === ":" || nx === "}" || nx === "]")) { out += '\\"'; continue; }
        }
        inStr = false; out += c; continue;
      }
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") continue;
      if (c === "\t") { out += "\\t"; continue; }
      if (c.charCodeAt(0) < 32) continue;
      out += c; continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "}" || c === "]") out = out.replace(/,\s*$/, "");
    out += c;
  }
  return out;
}

function tryParse(s) {
  try { return { ok: true, value: JSON.parse(s), method: "direct" }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(fixJsonSyntax(s, false)), method: "loose" }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(fixJsonSyntax(s, true)), method: "loose+quote" }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(fixJsonSyntax(s.replace(/[“”]/g, '"'), true)), method: "loose+curly" }; } catch (_) {}
  return { ok: false };
}

/* Chỉ trả các ứng viên NGOÀI CÙNG. Ứng viên chưa đóng (bị cắt) sẽ nuốt phần còn lại, không quét vào bên trong. */
function scanTop(s, open) {
  const close = open === "[" ? "]" : "}";
  const res = [];
  let i = 0;
  while (i < s.length) {
    const st = s.indexOf(open, i);
    if (st < 0) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = st; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { res.push({ text: s.slice(st), complete: false }); break; }
    res.push({ text: s.slice(st, end + 1), complete: true });
    i = end + 1;
  }
  return res;
}

function parseJsonLoose(raw, open) {
  const s = stripFences(raw);
  if (!s) return { value: null, method: "", truncated: "" };
  const whole = tryParse(s);
  if (whole.ok) return { value: whole.value, method: whole.method, truncated: "" };
  let truncated = "";
  for (const c of scanTop(s, open)) {
    if (c.complete) { const t = tryParse(c.text); if (t.ok) return { value: t.value, method: t.method + "-extract", truncated: "" }; }
    else truncated = c.text;
  }
  return { value: null, method: "", truncated };
}

/* JSON bị cắt: thử đóng ngoặc tại từng dấu phẩy (từ cuối ngược lên) tới khi parse được. */
function salvageTruncated(text) {
  const stack = []; let inStr = false, esc = false; const points = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack.length) points.push({ pos: i, closers: stack.slice().reverse().join("") });
  }
  for (let k = points.length - 1; k >= Math.max(0, points.length - 300); k--) {
    const p = points[k];
    const t = tryParse(text.slice(0, p.pos) + p.closers);
    if (t.ok) return t.value;
  }
  return null;
}

/* Cứu từng object hoàn chỉnh trong mảng; đếm object hỏng thay vì âm thầm bỏ. */
function repairTruncatedArray(raw) {
  const s = stripFences(raw);
  const start = s.indexOf("[");
  if (start < 0) return { items: [], dropped: 0 };
  const out = []; let dropped = 0;
  let i = start + 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] !== "{") break;
    const objStart = i;
    let depth = 0, inStr = false, esc = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const t = tryParse(s.slice(objStart, i + 1));
          if (t.ok && t.value && typeof t.value === "object") out.push(t.value); else dropped++;
          i++;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return { items: out, dropped };
}

const isPlainObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function parseArray(raw) {
  const r = parseJsonLoose(raw, "[");
  let v = r.value, method = r.method;
  if (v && !Array.isArray(v) && typeof v === "object") {
    const arr = Object.values(v).find(x => Array.isArray(x));
    if (arr) { v = arr; method += "+unwrap"; }
    else if (v.name || v.description) { v = [v]; method += "+single"; }
    else v = null;
  }
  if (Array.isArray(v)) {
    const items = v.filter(isPlainObj);
    return { items, valid: true, repaired: false, method, dropped: v.length - items.length, truncated: false };
  }
  let items = [], dropped = 0, method2 = "";
  if (r.truncated) {
    const sv = salvageTruncated(r.truncated);
    if (Array.isArray(sv)) { items = sv.filter(isPlainObj); method2 = "salvage"; }
  }
  if (!items.length) {
    const rp = repairTruncatedArray(r.truncated || raw);
    items = rp.items; dropped = rp.dropped; method2 = "object-by-object";
  }
  return { items, valid: items.length > 0, repaired: items.length > 0, method: items.length ? method2 : "", dropped, truncated: !!r.truncated };
}

function parseObjectDetailed(raw, keys) {
  const ok = (v) => isPlainObj(v) && (!keys || !keys.length || keys.some(k => k in v) || Object.keys(v).length === 0);
  const r = parseJsonLoose(raw, "{");
  let v = r.value;
  if (Array.isArray(v)) v = v.find(isPlainObj) || null;
  if (isPlainObj(v) && !ok(v)) { const inner = Object.values(v).find(ok); if (inner) v = inner; }
  if (ok(v)) return { obj: v, method: r.method };
  if (r.truncated) { const sv = salvageTruncated(r.truncated); if (ok(sv)) return { obj: sv, method: "salvage" }; }
  return { obj: null, method: "" };
}

function chunkText(text, maxChars = 14000, overlap = 900) {
  const s = String(text || "");
  if (s.length <= maxChars) return [s];
  const chunks = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + maxChars);
    if (end < s.length) {
      const cut = s.lastIndexOf("\n", end);
      if (cut > start + maxChars * 0.65) end = cut;
    }
    chunks.push(s.slice(start, end));
    if (end >= s.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}
function representativeText(text, maxChars = 42000) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  const part = Math.floor(maxChars / 3);
  return s.slice(0, part) + "\n\n[...ĐOẠN GIỮA... ]\n\n" + s.slice(Math.floor((s.length - part) / 2), Math.floor((s.length + part) / 2)) + "\n\n[...ĐOẠN CUỐI... ]\n\n" + s.slice(-part);
}

const SYSTEM_PROMPT = [
  "Bạn là tiểu thuyết gia Việt Nam viết tiểu thuyết dài kỳ.",
  "Phản hồi văn xuôi phải 100% tiếng Việt có dấu; dữ liệu JSON cũng dùng tiếng Việt ở giá trị chuỗi.",
  "Giữ tính liên tục tuyệt đối: không tự ý hồi sinh người chết, đổi thân phận, đổi địa điểm, đổi cảnh giới hoặc cho nhân vật biết điều họ chưa thể biết.",
  "Ưu tiên chi tiết cụ thể, hành động, giác quan, nguyên nhân và hệ quả."
].join(" ");

const DESCRIPTION_PROMPTS = {
  light: "Miêu tả nhẹ, tập trung diễn biến.",
  balanced: "Miêu tả cân bằng, có giác quan và chi tiết vừa đủ.",
  rich: "Miêu tả phong phú, chú ý ngoại hình và không khí cảnh.",
  deep: "Miêu tả sâu, giàu giác quan nhưng không lặp."
};
const EXPLICIT_PROMPTS = {
  subtle: "Cảnh trưởng thành ở mức nhẹ.",
  sensual: "Cảnh trưởng thành thiên về cảm xúc và cảm giác.",
  explicit: "Cảnh trưởng thành rõ ràng theo yêu cầu của truyện.",
  strong: "Cảnh trưởng thành chi tiết theo thiết lập người dùng.",
  wild: "Cảnh trưởng thành ở mức rất mạnh theo thiết lập người dùng."
};

// v9.2: dùng streaming + idle-timeout thay vì abort cứng sau 170s.
// Chương dài (5000+ từ, ~12-16k token) thường chạy >170s nên bản cũ bị "This operation was aborted".
// Nếu bị ngắt giữa chừng nhưng đã có nội dung, trả phần đã nhận (finishReason="length") để vòng "viết tiếp" xử lý.
async function callOpenRouter({ endpoint, apiKey, model, messages, maxTokens = 4000, temperature = 0.3, totalMs = 400000, firstTokenMs = 150000, idleMs = 60000, creative = false, noReasoning = !creative, _noReasoningParam = false }) {
  if (timeLeft() < 15000) throw new Error("Hết thời gian job nền (giới hạn 15 phút của Netlify)");
  totalMs = Math.min(totalMs, Math.max(15000, timeLeft() - 25000));
  firstTokenMs = Math.min(firstTokenMs, totalMs);
  const controller = new AbortController();
  const startedAt = Date.now();
  let timer = null, abortReason = "";
  const arm = (ms, reason) => {
    clearTimeout(timer);
    timer = setTimeout(() => { abortReason = reason; controller.abort(); }, ms);
  };
  arm(firstTokenMs, `Model không phản hồi sau ${Math.round(firstTokenMs / 1000)}s`);
  let text = "", reasoning = "", finishReason = null, gotAny = false;
  try {
    const res = await fetch(endpoint || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.URL || "https://xuong-truyen-ai.netlify.app",
        "X-Title": "Xuong Truyen AI v9"
      },
      body: JSON.stringify(Object.assign({ model, messages, max_tokens: maxTokens, temperature, stream: true },
        // Penalty chỉ dùng khi VIẾT VĂN. Với JSON, penalty làm model né lặp key/dấu ngoặc -> JSON hỏng.
        creative ? { frequency_penalty: 0.35, presence_penalty: 0.25 } : {},
          // Model có "thinking" sẽ ăn hết max_tokens vào reasoning -> content rỗng/bị cắt. Tắt cho trích xuất (chỉ OpenRouter).
          (noReasoning && !_noReasoningParam && /openrouter\.ai/i.test(endpoint || DEFAULT_ENDPOINT)) ? { reasoning: { enabled: false } } : {})),
      signal: controller.signal
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 400 && noReasoning && !_noReasoningParam && /reasoning/i.test(err)) {
        clearTimeout(timer);
        return callOpenRouter({ endpoint, apiKey, model, messages, maxTokens, temperature, totalMs, firstTokenMs, idleMs, creative, noReasoning, _noReasoningParam: true });
      }
      const e = new Error(`API ${res.status}: ${err.slice(0, 500)}`);
      e.status = res.status;
      throw e;
    }
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      // Provider không hỗ trợ stream -> đọc JSON thường
      const data = await res.json();
      const choice = data.choices?.[0];
      return { text: choice?.message?.content || choice?.text || (creative ? (choice?.message?.reasoning || choice?.message?.reasoning_content) : "") || "", finishReason: choice?.finish_reason || null, reasoningLen: String(choice?.message?.reasoning || choice?.message?.reasoning_content || "").length };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gotAny = true;
      if (Date.now() - startedAt > totalMs) { abortReason = `Quá ${Math.round(totalMs / 1000)}s cho một lần gọi`; controller.abort(); break; }
      arm(idleMs, `Model đứng im ${Math.round(idleMs / 1000)}s giữa chừng`);
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) { const e = new Error(`API stream: ${String(j.error.message || JSON.stringify(j.error)).slice(0, 300)}`); e.status = j.error.code; throw e; }
          const ch = j.choices?.[0];
          const piece = ch?.delta?.content ?? ch?.text ?? "";
          if (piece) text += piece;
          const rp = ch?.delta?.reasoning ?? ch?.delta?.reasoning_content ?? "";
          if (rp) reasoning += rp;
          if (ch?.finish_reason) finishReason = ch.finish_reason;
        } catch (e) { if (e.status) throw e; /* dòng JSON dở dang: bỏ qua */ }
      }
    }
    if (creative && !text.trim() && reasoning.trim()) text = reasoning; // chỉ khi viết văn
    return { text, finishReason, reasoningLen: reasoning.length };
  } catch (e) {
    const aborted = e.name === "AbortError" || /aborted/i.test(e.message || "");
    if (aborted) {
      // Có nội dung đủ dài -> giữ lại, coi như bị cắt để vòng viết tiếp nối tiếp
      if (text.trim().length > 800) return { text, finishReason: "length", partial: true, partialReason: abortReason, reasoningLen: reasoning.length };
      const err = new Error(abortReason || "Kết nối tới model bị ngắt");
      err.retryable = true;
      throw err;
    }
    if (!e.status && gotAny && text.trim().length > 800) return { text, finishReason: "length", partial: true, partialReason: e.message, reasoningLen: reasoning.length };
    if (!e.status) e.retryable = true; // lỗi mạng
    throw e;
  } finally { clearTimeout(timer); }
}

async function callWithRetry(args, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await callOpenRouter(args); }
    catch (e) {
      last = e;
      const retryable = e.retryable || [408, 425, 429, 500, 502, 503, 504, 524].includes(e.status);
      if (!retryable) break;
      if (i < tries - 1) await new Promise(r => setTimeout(r, Math.min(8000, 900 * Math.pow(2, i))));
    }
  }
  throw last || new Error("API thất bại");
}

/* Gọi trích xuất: nếu content rỗng (thường do reasoning ăn hết token) thì gọi lại với ngân sách gấp đôi. */
async function callExtract(args, tries = 2) {
  let r = await callWithRetry(args, tries);
  const empty = !String(r.text || "").trim();
  const base = args.maxTokens || 3000;
  // Rỗng hoặc bị cắt (finish=length) -> gọi lại với ngân sách gấp đôi (tối đa 16000)
  if ((empty || r.finishReason === "length") && base < 16000 && timeLeft() > 120000) {
    try {
      const r2 = await callWithRetry({ ...args, maxTokens: Math.min(16000, base * 2) }, tries);
      const has2 = String(r2.text || "").trim();
      if (has2 && (empty || r2.finishReason !== "length" || r2.text.length > r.text.length)) r = { ...r2, retriedBigger: true };
    } catch (e) { if (empty) throw e; }
  }
  return r;
}
function fin(r) { return `finish=${r.finishReason || "?"}, ${String(r.text || "").length} ký tự${r.reasoningLen ? `, reasoning ${r.reasoningLen}` : ""}`; }

async function repairJsonWithAI(job, raw, shape, keys, maxTokens = 6900) {
  const clipped = String(raw || "").slice(0, 24000);
  if (!clipped.trim()) return "";
  const instruction = shape === "array"
    ? 'Chuyển nội dung sau thành JSON array hợp lệ gồm các object. Giữ lại mọi object có thể xác định. Không thêm dữ liệu. Chỉ trả JSON array.'
    : `Chuyển nội dung sau thành một JSON object hợp lệ${keys && keys.length ? " với các khóa: " + keys.join(", ") : ""}. Giữ nguyên thông tin có thể xác định. Không thêm dữ liệu. Chỉ trả JSON object.`;
  try {
    const r = await callExtract({
      endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model,
      messages: [
        { role: "system", content: "Bạn là bộ sửa JSON. Tuyệt đối không viết giải thích ngoài JSON." },
        { role: "user", content: instruction + "\n\nDỮ LIỆU LỖI:\n" + clipped }
      ],
      maxTokens, temperature: 0
    }, 2);
    return r.text || "";
  } catch (_) { return ""; }
}

async function parseArrayWithRepair(job, raw) {
  const p = parseArray(raw);
  if (p.valid) return { ...p, repairedByAI: false };
  const fixed = await repairJsonWithAI(job, raw, "array", null, 8000);
  const again = parseArray(fixed);
  return { ...again, repairedByAI: again.valid, method: again.valid ? "AI-repair" : "" };
}

async function parseObjectWithRepair(job, raw, keys) {
  const p = parseObjectDetailed(raw, keys);
  if (p.obj) return { obj: p.obj, method: p.method, repairedByAI: false };
  const fixed = await repairJsonWithAI(job, raw, "object", keys, 6900);
  const again = parseObjectDetailed(fixed, keys);
  return { obj: again.obj, method: again.obj ? "AI-repair" : "", repairedByAI: !!again.obj };
}

function sampleOf(text, n = 140) { return String(text || "").replace(/\s+/g, " ").slice(0, n); }

function buildContext(state) {
  const p = [];
  const loreTxt = buildLoreBlock(state); if (loreTxt) p.push(loreTxt);
  if (state.mainPlot) p.push("CỐT TRUYỆN:\n" + state.mainPlot);
  if (state.genre) p.push("THỂ LOẠI: " + state.genre);
  if (state.worldSetting) p.push("THẾ GIỚI:\n" + state.worldSetting);
  if (state.worldRules) p.push("LUẬT THẾ GIỚI:\n" + state.worldRules);
  if (state.worldDescription) p.push("KHÔNG KHÍ:\n" + state.worldDescription);
  if (state.pronounRules) p.push("XƯNG HÔ:\n" + state.pronounRules);
  if (state.currentStatus) p.push("CURRENT STATUS:\n" + state.currentStatus);
  if (state.directive) p.push("MỆNH LỆNH:\n" + state.directive);
  if (state.advancedRules) p.push("QUY TẮC:\n" + state.advancedRules);
  if (state.mainCharProfile?.name) p.push("NVC:\n" + JSON.stringify(state.mainCharProfile));
  const chars = (state.characters || []).filter(c => !c.dead).slice(0, 18);
  if (chars.length) {
    p.push("NHÂN VẬT QUAN TRỌNG:\n" + chars.map(c => `- ${c.name} [${c.tier || "supporting"}] | vai trò:${c.role || ""} | ở:${c.currentLocation || "?"} | thể:${c.physicalState || ""} | tâm:${c.mentalState || ""} | biết:${c.knowledge || ""}`).join("\n"));
  }
  if (Array.isArray(state.threads) && state.threads.length) {
    p.push("PLOT THREADS ĐANG MỞ:\n" + state.threads.filter(t => !["paid_off","abandoned","completed"].includes(t.status)).slice(0, 20).map(t => `- ${t.type}: ${t.desc} [${t.status}]`).join("\n"));
  }
  if (Array.isArray(state.foreshadowing) && state.foreshadowing.length) {
    p.push("伏イ / FORESHADOWING CHƯA GIẢI:\n" + state.foreshadowing.filter(f => !["paid_off","abandoned","resolved"].includes(f.status)).slice(-20).map(f => `- ${f.description} [${f.status}] từ ch${f.plantedChapter || "?"}`).join("\n"));
  }
  if (Array.isArray(state.timeline) && state.timeline.length) {
    p.push("TIMELINE GẦN ĐÂY:\n" + state.timeline.slice(-12).map(e => `- Ch${e.chapter}: ${e.summary}`).join("\n"));
  }
  return p.join("\n\n");
}
function recentContext(chapters) {
  if (!chapters.length) return "Đây là chương đầu tiên.";
  const last = chapters[chapters.length - 1];
  const prev = chapters.length > 1 ? chapters[chapters.length - 2] : null;
  return `${prev ? `CHƯƠNG TRƯỚC NỮA:\n${(prev.summary || prev.text || "").slice(0, 900)}\n\n` : ""}ĐOẠN CUỐI CHƯƠNG GẦN NHẤT:\n${(last.text || "").slice(-5000)}`;
}

/* ===== v10 Lorebook (đồng bộ với client) ===== */
function loreCompileKey(k) {
  const m = k.match(/^\/(.+)\/([a-z]*)$/i);
  try {
    if (m) return new RegExp(m[1], Array.from(new Set((m[2].replace(/[gy]/g, "") + "iu").split(""))).join(""));
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return new RegExp("(?:^|[^\\p{L}\\p{N}_])" + esc + "(?![\\p{L}\\p{N}_])", "iu");
  } catch (e) { return null; }
}
function buildLoreBlock(state) {
  const cards = Array.isArray(state.lorebook) ? state.lorebook : [];
  if (!cards.length) return "";
  const text = (state.chapters || []).slice(-2).map(c => c.text || "").join("\n\n").slice(-12000) + "\n" + (state.directive || "") + "\n" + String(state.currentStatus || "").slice(0, 1500);
  const budget = Math.max(200, Number(state.loreBudgetTokens) || 2000);
  const hits = cards.filter(c => {
    if (c.enabled === false || !String(c.content || "").trim()) return false;
    if (c.always) return true;
    return String(c.keys || "").split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).some(k => { const re = loreCompileKey(k); return re && re.test(text); });
  }).sort((a, b) => (Number(b.priority) || 50) - (Number(a.priority) || 50));
  const parts = []; let used = 0;
  for (const c of hits) {
    const block = "• " + (c.name || "?") + ": " + String(c.content).trim();
    const t = Math.ceil(block.length / 3.2);
    if (used + t > budget) continue;
    used += t; parts.push(block);
  }
  return parts.length ? "THẺ TRI THỨC (Lorebook — bắt buộc tuân thủ khi nhân vật/đối tượng xuất hiện):\n" + parts.join("\n") : "";
}

async function generateOneChapter(job) {
  const state = job.storyState;
  const chapters = Array.isArray(state.chapters) ? state.chapters : [];
  const chapterNumber = chapters.length + 1;
  const minWords = Math.min(Math.max(Number(state.minChapterWords) || 5000, 500), 9000);
  const directive = String(state.directive || "").toLowerCase();
  const hot = ["cảnh nóng", "18+", "sex", "nsfw", "erotic", "quan hệ"].some(k => directive.includes(k));
  const isNsfw = !!job.forceNsfw || (state.mature && state.nsfwMode !== "never" && hot);
  const model = isNsfw ? (job.modelNsfw || job.model) : job.model;
  const prompt = [
    `VIẾT CHƯƠNG ${chapterNumber}. Truyện đã có ${chapters.length} chương.`,
    `Tối thiểu ${minWords} từ. ${DESCRIPTION_PROMPTS[state.descriptionLevel] || DESCRIPTION_PROMPTS.balanced}`,
    "Không mở đầu bằng tiêu đề, không giải thích ngoài truyện.",
    "Không lặp lại đoạn kết chương trước; phải tiếp nối nguyên nhân và hệ quả.",
    buildContext(state), recentContext(chapters),
    isNsfw ? ("MỨC TRƯỞNG THÀNH: " + (EXPLICIT_PROMPTS[state.explicitLevel] || "")) : "",
    "Định dạng cuối: TIÊU ĐỀ: <tên>\nNỘI DUNG:\n<văn xuôi>"
  ].filter(Boolean).join("\n\n");

  let result = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], maxTokens: 16000, temperature: isNsfw ? 1 : 0.95, totalMs: 420000, creative: true }, 2);
  const titleMatch = result.text.match(/TIÊU ĐỀ\s*:\s*(.+)/i);
  const bodyMatch = result.text.match(/NỘI DUNG\s*:\s*([\s\S]*)/i);
  const title = (titleMatch?.[1] || "Chương mới").replace(/^chương\s*\d+\s*[:\-–—.]*/i, "").trim() || "Chương mới";
  let text = (bodyMatch?.[1] || result.text).trim();
  let truncated = result.finishReason === "length";
  const issues = [];
  let attempts = 0;

  while (countWords(text) < minWords * 0.9 && attempts < 4) {
    attempts++;
    const current = countWords(text);
    const tail = text.slice(-5000);
    const need = Math.max(1200, minWords - current);
    try {
      const cont = await callWithRetry({
        endpoint: job.apiEndpoint, apiKey: job.apiKey, model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: [
          `Viết TIẾP chương ${chapterNumber}. Hiện ${current} từ, cần thêm khoảng ${need} từ.`,
          "Bắt đầu ngay sau câu cuối. Không tóm tắt, không mở chương mới, không lặp.",
          "ĐOẠN CUỐI:", tail,
          "Chỉ trả văn xuôi tiếp theo."
        ].join("\n\n") }],
        maxTokens: 9000, temperature: isNsfw ? 1 : 0.95, creative: true
      }, 2);
      if (!cont.text || cont.text.trim().length < 50) { issues.push(`Viết tiếp #${attempts} quá ngắn`); break; }
      text = text.replace(/\s+$/, "") + "\n\n" + cont.text.trim();
      truncated = cont.finishReason === "length";
    } catch (e) { issues.push(`Viết tiếp #${attempts}: ${e.message}`); break; }
  }
  const wordCount = countWords(text);
  if (wordCount < minWords * 0.9) issues.push(`Thiếu từ: ${wordCount}/${minWords}`);
  return { title, text, wordCount, truncated, plan: "", continuityWarnings: [], modelUsed: model, isNsfw, polished: false, summary: "", versions: [], compressed: false, createdBy: "background-v9", createdAt: Date.now(), autoUpdateIssues: issues, minWordsTarget: minWords };
}

async function generateSummary(job, chapter, n) {
  try {
    const body = representativeText(chapter.text, 30000);
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: `Tóm tắt CHƯƠNG ${n} bằng 5-8 câu tiếng Việt. Bắt buộc bao quát đầu, giữa, cuối; nhân vật; thay đổi trạng thái; quan hệ; vật phẩm/địa điểm; hệ quả và việc chưa giải quyết.\n\n${body}` }], maxTokens: 2900, temperature: 0.25 }, 2);
    return (r.text || "").trim();
  } catch (_) { return ""; }
}

function compactCharacterList(state) {
  return (state.characters || []).slice(0, 80).map(c => `- ${c.name} [${c.tier || "supporting"}]${c.dead ? " [ĐÃ CHẾT]" : ""}`).join("\n") || "(chưa có)";
}

function mergeTextField(oldValue, newValue, max = 1400) {
  const a = String(oldValue || "").trim(), b = String(newValue || "").trim();
  if (!b) return a;
  if (!a) return b.slice(0, max);
  if (normalizeName(a) === normalizeName(b) || normalizeName(a).includes(normalizeName(b))) return a;
  if (normalizeName(b).includes(normalizeName(a))) return b.slice(0, max);
  const merged = a + "; " + b;
  return merged.slice(0, max);
}

function mergeCharacter(state, u, chapterNumber) {
  if (!u?.name) return { created: false, updated: false };
  const name = String(u.name).trim();
  if (!name) return { created: false, updated: false };
  let c = (state.characters || []).find(x => normalizeName(x.name) === normalizeName(name));
  let created = false;
  if (!c) {
    c = {
      id: genId("c"), name, tier: u.tier || "supporting", role: u.role || "", relevanceToMC: u.relevanceToMC || "",
      appearance: u.appearance || "", personality: u.personality || "", occupation: u.occupation || "", faction: u.faction || "",
      goals: u.goals || "", secret: u.secret || "", weakness: u.weakness || "", fear: u.fear || "", knowledge: u.knowledge || "",
      currentLocation: u.currentLocation || "", physicalState: u.physicalState || "", mentalState: u.mentalState || "", independentPlot: "",
      relationships: [], firstAppearance: chapterNumber, lastAppearance: chapterNumber, locked: false, dead: !!u.isDead,
      deathChapter: u.isDead ? chapterNumber : null, history: []
    };
    if (!Array.isArray(state.characters)) state.characters = [];
    state.characters.push(c); created = true;
  } else {
    ["appearance","personality","goals","secret","weakness","fear","knowledge"].forEach(k => { if (u[k]) c[k] = mergeTextField(c[k], u[k]); });
    ["role","relevanceToMC","occupation","faction"].forEach(k => { if (u[k]) c[k] = u[k]; });
    ["currentLocation","physicalState","mentalState"].forEach(k => { if (u[k]) c[k] = u[k]; });
    if (u.tier && !c.locked) c.tier = u.tier;
    if (u.isDead === true && !c.dead) { c.dead = true; c.deathChapter = chapterNumber; }
    c.lastAppearance = chapterNumber;
  }
  if (!Array.isArray(c.relationships)) c.relationships = [];
  (Array.isArray(u.relationships) ? u.relationships : []).forEach(r => {
    if (!r?.withName) return;
    let rel = c.relationships.find(x => normalizeName(x.withName) === normalizeName(r.withName));
    if (!rel) { rel = { withName: r.withName, stage: "", trust: "", notes: "", history: [] }; c.relationships.push(rel); }
    ["stage","trust","notes"].forEach(k => { if (r[k]) rel[k] = r[k]; });
    if (r.notes) { if (!Array.isArray(rel.history)) rel.history = []; rel.history.push({ chapter: chapterNumber, change: r.notes }); }
  });
  if (u.chapterEvent) { if (!Array.isArray(c.history)) c.history = []; c.history.push({ chapter: chapterNumber, event: u.chapterEvent }); }
  return { created, updated: true };
}

async function updateCharacters(job, chapter, n, state) {
  if (!Array.isArray(state.characters)) state.characters = [];
  const chunks = chunkText(chapter.text, 9000, 700);
  const res = { ok: true, chunks: chunks.length, nNew: 0, nUpdated: 0, failed: 0, dropped: 0, cut: 0, notes: [], problems: [] };
  for (let i = 0; i < chunks.length; i++) {
    const tag = `NV lô ${i + 1}/${chunks.length}`;
    if (timeLeft() < 60000) { res.failed++; res.notes.push(`${tag}: BỎ QUA vì sắp hết thời gian job (15 phút của Netlify)`); continue; }
    const prompt = [
      `CẬP NHẬT NHÂN VẬT — CHƯƠNG ${n}, PHẦN ${i + 1}/${chunks.length}.`,
      "Chỉ liệt kê nhân vật thực sự xuất hiện hoặc được nhắc tới có ý nghĩa trong PHẦN này. Không bịa.",
      "Tối đa 12 nhân vật; mỗi trường tối đa khoảng 25 từ; không lặp hồ sơ cũ dài dòng. Không dùng dấu \" bên trong giá trị chuỗi. Chỉ trả về JSON array.",
      "Danh sách tên đã biết:", compactCharacterList(state),
      "NỘI DUNG PHẦN:", chunks[i],
      'JSON: [{"name":"","tier":"background|minor|supporting|important|major","role":"","relevanceToMC":"","appearance":"","personality":"","occupation":"","faction":"","goals":"","secret":"","weakness":"","fear":"","knowledge":"","currentLocation":"","physicalState":"","mentalState":"","chapterEvent":"","relationships":[{"withName":"","stage":"","trust":"","notes":""}],"isDead":false}]'
    ].join("\n\n");
    try {
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "system", content: "Bạn là bộ máy trích xuất dữ liệu nhân vật. Không được viết văn xuôi. Chỉ trả JSON hợp lệ." }, { role: "user", content: prompt }], maxTokens: 11500, temperature: 0.15 }, 2);
      const parsed = await parseArrayWithRepair(job, r.text);
      if (!parsed.valid) {
        res.failed++;
        res.notes.push(`${tag}: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`);
        continue;
      }
      let created = 0, upd = 0, merr = 0;
      parsed.items.forEach(u => {
        try { const x = mergeCharacter(state, u, n); if (x.created) created++; else if (x.updated) upd++; }
        catch (e) { merr++; }
      });
      res.nNew += created; res.nUpdated += upd; res.dropped += (parsed.dropped || 0) + merr;
      if (r.finishReason === "length" || parsed.truncated) res.cut++;
      res.notes.push(`${tag}: ${fin(r)}, parse=${parsed.method || "?"}, ${parsed.items.length} NV (+${created} mới, ${upd} cập nhật)${parsed.dropped ? `, ${parsed.dropped} object hỏng bị bỏ` : ""}${merr ? `, ${merr} lỗi merge` : ""}`);
    } catch (e) { res.failed++; res.notes.push(`${tag}: LỖI gọi model — ${sampleOf(e.message, 160)}`); }
  }
  res.ok = res.failed < chunks.length;
  if (res.failed) res.problems.push(`NV: ${res.failed}/${chunks.length} lô không đọc được`);
  if (res.cut) res.problems.push(`NV: model bị cắt cụt ở ${res.cut} lô (có thể thiếu NV cuối lô)`);
  if (res.dropped) res.problems.push(`NV: ${res.dropped} object NV hỏng bị bỏ`);
  return res;
}

function findThread(state, t) {
  const key = normalizeName(t.matchExistingDesc || t.desc).slice(0, 50);
  if (!key) return null;
  return (state.threads || []).find(x => normalizeName(x.desc).slice(0, 50) === key || normalizeName(x.desc).includes(key.slice(0, 28)) || key.includes(normalizeName(x.desc).slice(0, 28)));
}
function applyWorld(obj, n, state) {
  if (!Array.isArray(state.locations)) state.locations = [];
  if (!Array.isArray(state.items)) state.items = [];
  if (!Array.isArray(state.threads)) state.threads = [];
  (obj.locations || []).forEach(u => {
    if (!u?.name) return;
    let x = state.locations.find(a => normalizeName(a.name) === normalizeName(u.name));
    if (!x) { x = { id: genId("l"), name: u.name, description: "", status: "active", firstAppearance: n, lastAppearance: n }; state.locations.push(x); }
    if (u.description) x.description = mergeTextField(x.description, u.description, 1200);
    if (u.status) x.status = u.status;
    x.lastAppearance = n;
  });
  (obj.items || []).forEach(u => {
    if (!u?.name) return;
    let x = state.items.find(a => normalizeName(a.name) === normalizeName(u.name));
    if (!x) { x = { id: genId("i"), name: u.name, description: "", owner: "", status: "active", firstAppearance: n, lastAppearance: n }; state.items.push(x); }
    if (u.description) x.description = mergeTextField(x.description, u.description, 1000);
    if (u.owner) x.owner = u.owner;
    if (u.status) x.status = u.status;
    x.lastAppearance = n;
  });
  (obj.threads || []).forEach(t => {
    if (!t?.desc) return;
    let x = findThread(state, t);
    if (!x) state.threads.push({ id: genId("t"), type: t.type || "open_thread", status: t.status || "seeded", desc: t.desc, chapterIntroduced: n, lastUpdated: n, history: [] });
    else { if (t.status) x.status = t.status; x.lastUpdated = n; if (!Array.isArray(x.history)) x.history = []; x.history.push({ chapter: n, status: t.status || x.status, note: t.desc }); }
  });
}
async function updateWorld(job, chapter, n, state) {
  if (!Array.isArray(state.locations)) state.locations = [];
  if (!Array.isArray(state.items)) state.items = [];
  if (!Array.isArray(state.threads)) state.threads = [];
  const chunks = chunkText(chapter.text, 10000, 700);
  const res = { ok: true, chunks: chunks.length, failed: 0, cut: 0, notes: [], problems: [] };
  const keys = ["locations", "items", "threads"];
  for (let i = 0; i < chunks.length; i++) {
    const tag = `Thế giới lô ${i + 1}/${chunks.length}`;
    if (timeLeft() < 60000) { res.failed++; res.notes.push(`${tag}: BỎ QUA vì sắp hết thời gian job`); continue; }
    const prompt = [
      `CẬP NHẬT THẾ GIỚI — CHƯƠNG ${n}, PHẦN ${i + 1}/${chunks.length}.`,
      "Chỉ trả địa điểm/vật phẩm/thread mới hoặc thay đổi rõ trong phần này. Không bịa. Mô tả ngắn (tối đa 25 từ). Không dùng dấu \" bên trong giá trị chuỗi.",
      "Địa điểm hiện có: " + state.locations.map(x => x.name).join(", "),
      "Vật phẩm hiện có: " + state.items.map(x => x.name).join(", "),
      "Thread hiện có:\n" + state.threads.slice(-30).map(x => `${x.type}: ${x.desc} [${x.status}]`).join("\n"),
      "NỘI DUNG:", chunks[i],
      'JSON: {"locations":[{"name":"","description":"","status":"active|destroyed|abandoned|locked"}],"items":[{"name":"","description":"","owner":"","status":"active|lost|destroyed|stored"}],"threads":[{"type":"open_thread|foreshadowing|consequence","desc":"","status":"seeded|developing|paid_off|abandoned","matchExistingDesc":""}]}'
    ].join("\n\n");
    try {
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "system", content: "Bạn là bộ máy trích xuất world state. Chỉ trả JSON hợp lệ." }, { role: "user", content: prompt }], maxTokens: 9200, temperature: 0.15 }, 2);
      const parsed = await parseObjectWithRepair(job, r.text, keys);
      if (!parsed.obj) { res.failed++; res.notes.push(`${tag}: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`); continue; }
      const before = [state.locations.length, state.items.length, state.threads.length];
      applyWorld(parsed.obj, n, state);
      if (r.finishReason === "length") res.cut++;
      res.notes.push(`${tag}: ${fin(r)}, parse=${parsed.method || "?"}, +${state.locations.length - before[0]} địa điểm, +${state.items.length - before[1]} vật phẩm, +${state.threads.length - before[2]} thread`);
    } catch (e) { res.failed++; res.notes.push(`${tag}: LỖI — ${sampleOf(e.message, 160)}`); }
  }
  res.ok = res.failed < chunks.length;
  if (res.failed) res.problems.push(`Thế giới: ${res.failed}/${chunks.length} lô không đọc được`);
  if (res.cut) res.problems.push(`Thế giới: model bị cắt cụt ở ${res.cut} lô`);
  return res;
}

function formatStatus(obj, n) {
  const lines = [`Current Status Update - Sau Chương ${n}`];
  const map = [
    ["Tình hình chung", obj.currentSituation], ["Nhân vật chính", obj.mainCharacter], ["Nhân vật liên quan", obj.characters],
    ["Vị trí", obj.locations], ["Sức mạnh/cảnh giới", obj.power], ["Quan hệ", obj.relationships],
    ["Bí mật/kiến thức", obj.knowledge], ["Vấn đề chưa giải quyết", obj.unresolved], ["Hệ quả tiếp theo", obj.nextHooks]
  ];
  map.forEach(([k, v]) => { if (v) lines.push(`- ${k}: ${v}`); });
  return lines.join("\n");
}
async function updateCurrentStatus(job, chapter, n, state) {
  const res = { ok: false, notes: [], problems: [] };
  if (timeLeft() < 60000) { res.notes.push("Status: BỎ QUA vì sắp hết thời gian job"); res.problems.push("Status: bỏ qua vì hết thời gian"); return res; }
  const previous = state.currentStatus || "(chưa có)";
  const source = ["STATUS CŨ:", previous, "", "TÓM TẮT CHƯƠNG:", chapter.summary || "", "", "ĐOẠN CUỐI:", chapter.text.slice(-9000)].join("\n");
  const keys = ["currentSituation", "mainCharacter", "characters", "locations", "power", "relationships", "knowledge", "unresolved", "nextHooks"];
  try {
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: [
      `Cập nhật CURRENT STATUS sau chương ${n}. Chỉ thay đổi những gì chương chứng minh. Không xóa thông tin cũ chỉ vì không nhắc lại. Mỗi trường là MỘT chuỗi văn bản ngắn (không dùng mảng), không dùng dấu " bên trong chuỗi.`,
      source,
      'Trả DUY NHẤT JSON: {"currentSituation":"","mainCharacter":"","characters":"","locations":"","power":"","relationships":"","knowledge":"","unresolved":"","nextHooks":""}'
    ].join("\n\n") }], maxTokens: 5750, temperature: 0.15 }, 2);
    const parsed = await parseObjectWithRepair(job, r.text, keys);
    const obj = parsed.obj;
    if (!obj) { res.notes.push(`Status: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`); res.problems.push("Status: không đọc được JSON; Status cũ được giữ nguyên"); return res; }
    const str = (v) => Array.isArray(v) ? v.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("; ") : (v && typeof v === "object" ? JSON.stringify(v) : String(v || "").trim());
    const merged = {};
    keys.forEach(k => { merged[k] = str(obj[k]); });
    const filled = keys.filter(k => merged[k]).length;
    if (!filled) { res.notes.push("Status: JSON hợp lệ nhưng mọi trường đều rỗng"); res.problems.push("Status: model trả rỗng; Status cũ được giữ nguyên"); return res; }
    state.statusState = merged;
    state.currentStatus = formatStatus(merged, n);
    state.lastStatusChapter = n;
    res.ok = true;
    res.notes.push(`Status: ${fin(r)}, parse=${parsed.method || "?"}, ${filled}/${keys.length} trường có dữ liệu`);
    if (r.finishReason === "length") res.problems.push("Status: model bị cắt cụt");
    return res;
  } catch (e) { res.notes.push(`Status: LỖI — ${sampleOf(e.message, 160)}`); res.problems.push("Status: lỗi gọi model; Status cũ được giữ nguyên"); return res; }
}

async function updateLongMemory(job, chapter, n, state) {
  const res = { ok: false, notes: [], problems: [] };
  if (timeLeft() < 60000) { res.notes.push("Memory: BỎ QUA vì sắp hết thời gian job"); res.problems.push("Memory: bỏ qua vì hết thời gian"); return res; }
  if (!Array.isArray(state.timeline)) state.timeline = [];
  if (!Array.isArray(state.foreshadowing)) state.foreshadowing = [];
  if (!Array.isArray(state.knowledgeLedger)) state.knowledgeLedger = [];
  const source = [
    "TÓM TẮT:", chapter.summary || "",
    "ĐOẠN ĐẦU:", chapter.text.slice(0, 3500),
    "ĐOẠN CUỐI:", chapter.text.slice(-7500),
    "FORESHADOWING ĐANG MỞ:", state.foreshadowing.filter(x => !["paid_off", "abandoned", "resolved"].includes(x.status)).slice(-20).map(x => `${x.description} [${x.status}]`).join("\n")
  ].join("\n\n");
  const keys = ["events", "foreshadowing", "knowledge"];
  try {
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: [
      `CẬP NHẬT LONG-TERM MEMORY SAU CHƯƠNG ${n}.`,
      "Chỉ ghi sự kiện có bằng chứng. Không bịa. Mỗi mục ngắn gọn (tối đa 30 từ). Không dùng dấu \" bên trong chuỗi.",
      source,
      'Trả DUY NHẤT JSON: {"events":[{"type":"event|consequence|reveal|death|power_change","summary":"","causes":"","consequences":""}],"foreshadowing":[{"description":"","status":"seeded|developing|paid_off|abandoned","match":"","characters":""}],"knowledge":[{"character":"","fact":"","confidence":"direct|inferred|reported"}]}'
    ].join("\n\n") }], maxTokens: 9200, temperature: 0.15 }, 2);
    const parsed = await parseObjectWithRepair(job, r.text, keys);
    const obj = parsed.obj;
    if (!obj) { res.notes.push(`Memory: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`); res.problems.push("Memory: không đọc được JSON; dữ liệu cũ được giữ"); return res; }
    const b = [state.timeline.length, state.foreshadowing.length, state.knowledgeLedger.length];
    (Array.isArray(obj.events) ? obj.events : []).forEach(e => {
      if (!e?.summary) return;
      state.timeline.push({ id: genId("ev"), chapter: n, type: e.type || "event", summary: e.summary, causes: e.causes || "", consequences: e.consequences || "" });
    });
    (Array.isArray(obj.foreshadowing) ? obj.foreshadowing : []).forEach(f => {
      if (!f?.description) return;
      const key = normalizeName(f.match || f.description).slice(0, 60);
      let x = state.foreshadowing.find(a => normalizeName(a.description).slice(0, 60) === key || normalizeName(a.description).includes(key.slice(0, 30)));
      if (!x) state.foreshadowing.push({ id: genId("fs"), description: f.description, status: f.status || "seeded", plantedChapter: n, lastUpdated: n, characters: f.characters || "" });
      else { if (f.status) x.status = f.status; x.lastUpdated = n; if (f.characters) x.characters = f.characters; }
    });
    (Array.isArray(obj.knowledge) ? obj.knowledge : []).forEach(k => {
      if (!k?.character || !k?.fact) return;
      const key = normalizeName(k.character) + "|" + normalizeName(k.fact).slice(0, 80);
      let x = state.knowledgeLedger.find(a => normalizeName(a.character) + "|" + normalizeName(a.fact).slice(0, 80) === key);
      if (!x) state.knowledgeLedger.push({ id: genId("kl"), character: k.character, fact: k.fact, confidence: k.confidence || "direct", firstChapter: n, lastUpdated: n });
      else x.lastUpdated = n;
    });
    const added = [state.timeline.length - b[0], state.foreshadowing.length - b[1], state.knowledgeLedger.length - b[2]];
    state.timeline = state.timeline.slice(-250);
    state.foreshadowing = state.foreshadowing.slice(-150);
    state.knowledgeLedger = state.knowledgeLedger.slice(-500);
    state.lastMemorySyncChapter = n;
    res.ok = true;
    res.notes.push(`Memory: ${fin(r)}, parse=${parsed.method || "?"}, +${added[0]} sự kiện, +${added[1]} foreshadowing, +${added[2]} knowledge`);
    if (r.finishReason === "length") res.problems.push("Memory: model bị cắt cụt");
    return res;
  } catch (e) { res.notes.push(`Memory: LỖI — ${sampleOf(e.message, 160)}`); res.problems.push("Memory: lỗi gọi model; dữ liệu cũ được giữ"); return res; }
}

async function scanScenes(job, chapter, n, state) {
  const res = { ok: true, skipped: true, notes: [], problems: [] };
  return res; /* v10.1: bỏ Scene Tracker cho nhẹ */
  if (!state.mature) { res.skipped = true; res.notes.push("Scene: bỏ qua (chưa bật 'Cho phép trưởng thành')"); return res; }
  if (timeLeft() < 60000) { res.ok = false; res.notes.push("Scene: BỎ QUA vì sắp hết thời gian job"); res.problems.push("Scene: bỏ qua vì hết thời gian"); return res; }
  const source = representativeText(chapter.text, 24000);
  try {
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: `Nếu chương có cảnh trưởng thành, trích xuất ngắn gọn (mô tả tối đa 30 từ, không dùng dấu " trong chuỗi). Nếu không có trả []. Chỉ JSON array.\n${source}\n[{"intensity":1,"participants":[],"description":"","structure":"kiss|foreplay|sex|other"}]` }], maxTokens: 4600, temperature: 0.1 }, 2);
    const parsed = await parseArrayWithRepair(job, r.text);
    if (!parsed.valid) { res.ok = false; res.notes.push(`Scene: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`); res.problems.push("Scene: không đọc được dữ liệu cảnh"); return res; }
    if (!Array.isArray(state.scenes)) state.scenes = [];
    let added = 0;
    parsed.items.forEach(s => { if (!s?.description) return; added++; state.scenes.push({ id: genId("s"), chapter: n, intensity: Math.max(1, Math.min(10, Number(s.intensity) || 5)), participants: Array.isArray(s.participants) ? s.participants : [], description: s.description, structure: s.structure || "other", createdAt: Date.now() }); });
    res.notes.push(`Scene: ${fin(r)}, parse=${parsed.method || "?"}, +${added} cảnh`);
    return res;
  } catch (e) { res.ok = false; res.notes.push(`Scene: LỖI — ${sampleOf(e.message, 160)}`); res.problems.push("Scene: lỗi gọi model"); return res; }
}

function cleanJobForStore(job) {
  return { ...job, apiKey: job.apiKeyEncrypted ? null : (job.apiKey || null), apiKeyEncrypted: job.apiKeyEncrypted || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
  DEADLINE = Date.now() + 13.5 * 60 * 1000; // Netlify background function tối đa 15 phút
  let jobId = null, job = null, store;
  try {
    store = getJobStore(event);
    const body = JSON.parse(event.body || "{}");
    jobId = body.jobId;
    if (!jobId) return jsonResponse(400, { error: "Thiếu jobId" });
    job = await store.get(jobId, { type: "json" });
    if (!job) return jsonResponse(404, { error: "Job not found" });
    if (Date.now() - Number(job.createdAt || 0) > MAX_JOB_AGE_MS) return jsonResponse(410, { error: "Job đã quá hạn" });

    const workerToken = body.workerToken || event.headers?.["x-worker-token"] || event.headers?.["X-Worker-Token"] || "";
    const tokenOk = () => { try { return secretsEqual(job.workerTokenHash, hashSecret(workerToken)); } catch (_) { return false; } };
    if (job.workerTokenHash) {
      if (!tokenOk()) return jsonResponse(403, { error: "Worker token không hợp lệ" });
    } else if (Number(job.schemaVersion || 0) >= 9) {
      return jsonResponse(403, { error: "Worker token không hợp lệ" });
    }
    if (["completed", "failed"].includes(job.status)) return jsonResponse(200, { success: true, jobId, status: job.status });
    if (job.status === "running") return jsonResponse(202, { success: true, jobId, status: "running" });

    job.status = "running";
    job.updatedAt = Date.now();
    job.progress = "Đang chuẩn bị viết chương...";
    job.apiKey = decryptText(job.apiKeyEncrypted);
    if (!job.storyState || typeof job.storyState !== "object") throw new Error("Job không có storyState");
    ["chapters", "characters", "locations", "items", "threads", "scenes", "timeline", "foreshadowing", "knowledgeLedger", "memoryEvents"].forEach(k => { if (!Array.isArray(job.storyState[k])) job.storyState[k] = []; });
    await store.setJSON(jobId, cleanJobForStore(job));

    const chapter = await generateOneChapter(job);
    const n = job.storyState.chapters.length + 1;
    job.progress = "Đang tạo tóm tắt..."; job.updatedAt = Date.now(); await store.setJSON(jobId, cleanJobForStore(job));
    chapter.summary = await generateSummary(job, chapter, n);

    const newState = JSON.parse(JSON.stringify(job.storyState));
    newState.chapters.push(chapter);
    newState.currentChapterIndex = newState.chapters.length - 1;
    newState.chaptersSinceBackup = (newState.chaptersSinceBackup || 0) + 1;
    if (!Array.isArray(chapter.autoUpdateIssues)) chapter.autoUpdateIssues = [];
    chapter.updateDiagnostics = [];
    const absorb = (label, res) => {
      (res.notes || []).forEach(t => chapter.updateDiagnostics.push(t));
      (res.problems || []).forEach(p => { if (!chapter.autoUpdateIssues.includes(p)) chapter.autoUpdateIssues.push(p); });
    };

    const checkpoint = async (progress) => { job.progress = progress; job.updatedAt = Date.now(); job.storyState = newState; await store.setJSON(jobId, cleanJobForStore(job)); };
    const runStep = async (label, progress, fn) => {
      await checkpoint(progress);
      try { const t0 = Date.now(); const res = await fn(); res.notes = res.notes || []; if (res.notes.length) res.notes[res.notes.length - 1] += ` [${Math.round((Date.now() - t0) / 1000)}s]`; absorb(label, res); return res; }
      catch (e) { const res = { ok: false, notes: [`${label}: LỖI không lường trước — ${sampleOf(e.message, 200)}`], problems: [`${label}: lỗi hệ thống`] }; absorb(label, res); return res; }
    };

    // Các bước ghi vào các khóa state khác nhau nên chạy song song an toàn (JS đơn luồng, merge đồng bộ sau mỗi await).
    // Song song giúp tổng thời gian nằm trong giới hạn 15 phút của Netlify khi chia lô nhỏ.
    const runPar = async (label, fn) => {
      try { const t0 = Date.now(); const res = await fn(); res.notes = res.notes || []; if (res.notes.length) res.notes[res.notes.length - 1] += ` [${Math.round((Date.now() - t0) / 1000)}s]`; absorb(label, res); return res; }
      catch (e) { const res = { ok: false, notes: [`${label}: LỖI không lường trước — ${sampleOf(e.message, 200)}`], problems: [`${label}: lỗi hệ thống`] }; absorb(label, res); return res; }
    };
    await checkpoint("Đang cập nhật nhân vật + thế giới...");
    await Promise.all([
      runPar("NV", () => updateCharacters(job, chapter, n, newState)),
      runPar("Thế giới", () => updateWorld(job, chapter, n, newState))
    ]);
    await checkpoint("Đang cập nhật Status + Memory + Scene...");
    await Promise.all([
      runPar("Status", () => updateCurrentStatus(job, chapter, n, newState)),
      runPar("Memory", () => updateLongMemory(job, chapter, n, newState)),
      runPar("Scene", () => scanScenes(job, chapter, n, newState))
    ]);
    await checkpoint("Đang lưu kết quả...");

    job.status = "completed";
    job.progress = "Hoàn thành";
    job.resultChapter = chapter;
    job.storyState = newState;
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    job.apiKey = null;
    job.apiKeyEncrypted = null;
    await store.setJSON(jobId, cleanJobForStore(job));
    return jsonResponse(200, { success: true, jobId, chapterTitle: chapter.title, wordCount: chapter.wordCount });
  } catch (err) {
    console.error("Background v9 error:", err);
    if (job && jobId && store) {
      job.status = "failed";
      job.error = err.message || String(err);
      job.progress = "Lỗi: " + job.error;
      job.apiKey = null;
      job.updatedAt = Date.now();
      try { await store.setJSON(jobId, cleanJobForStore(job)); } catch (_) {}
    }
    return jsonResponse(500, { error: err.message || "Lỗi server", jobId });
  }
};
