const { getStore, connectLambda } = require("@netlify/blobs");
const crypto = require("crypto");

/*
 * Xưởng Truyện AI v9 — Background Worker
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
  return String(raw || "").replace(/```json/gi, "```").replace(/```/g, "").trim();
}

/* JSON parser chống lỗi: lấy object/array cân bằng trước, sau đó thử JSON.parse. */
function extractBalanced(raw, preferred) {
  const s = stripFences(raw);
  const starts = preferred ? [preferred] : ["[", "{"];
  for (const open of starts) {
    const start = s.indexOf(open);
    if (start < 0) continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
        }
      }
    }
  }
  try { return JSON.parse(s); } catch (_) { return null; }
}

/* Khi array bị cắt giữa chừng, cứu TẤT CẢ object hoàn chỉnh, không chỉ object đầu tiên. */
function repairTruncatedArray(raw) {
  const s = stripFences(raw);
  const start = s.indexOf("[");
  if (start < 0) return [];
  const out = [];
  let i = start + 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] !== "{") break;
    const objStart = i;
    let depth = 0, inStr = false, esc = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const rawObj = s.slice(objStart, i + 1);
          try { out.push(JSON.parse(rawObj)); } catch (_) {}
          i++;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return out;
}

function parseArray(raw) {
  const parsed = extractBalanced(raw, "[");
  if (Array.isArray(parsed)) return { items: parsed, repaired: false };
  const repaired = repairTruncatedArray(raw);
  return { items: repaired, repaired: repaired.length > 0 };
}
function parseObject(raw) {
  const parsed = extractBalanced(raw, "{");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
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

async function callOpenRouter({ endpoint, apiKey, model, messages, maxTokens = 4000, temperature = 0.3 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170000);
  try {
    const res = await fetch(endpoint || DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.URL || "https://xuong-truyen-ai.netlify.app",
        "X-Title": "Xuong Truyen AI v9"
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, frequency_penalty: 0.35, presence_penalty: 0.25 }),
      signal: controller.signal
    });
    if (!res.ok) {
      const err = await res.text();
      const e = new Error(`API ${res.status}: ${err.slice(0, 500)}`);
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    return { text: choice?.message?.content || choice?.text || "", finishReason: choice?.finish_reason || null };
  } finally { clearTimeout(timer); }
}

async function callWithRetry(args, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await callOpenRouter(args); }
    catch (e) {
      last = e;
      if (![408, 425, 429, 500, 502, 503, 504, 524].includes(e.status) && i > 0) break;
      await new Promise(r => setTimeout(r, Math.min(8000, 900 * Math.pow(2, i))));
    }
  }
  throw last || new Error("API thất bại");
}

function buildContext(state) {
  const p = [];
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

  let result = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], maxTokens: 16000, temperature: isNsfw ? 1 : 0.95 });
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
        maxTokens: 9000, temperature: isNsfw ? 1 : 0.95
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
    const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: `Tóm tắt CHƯƠNG ${n} bằng 5-8 câu tiếng Việt. Bắt buộc bao quát đầu, giữa, cuối; nhân vật; thay đổi trạng thái; quan hệ; vật phẩm/địa điểm; hệ quả và việc chưa giải quyết.\n\n${body}` }], maxTokens: 1000, temperature: 0.25 }, 2);
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
  (u.relationships || []).forEach(r => {
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
  const chunks = chunkText(chapter.text, 12000, 800);
  let totalNew = 0, totalUpdated = 0, repaired = 0, failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const prompt = [
      `CẬP NHẬT NHÂN VẬT — CHƯƠNG ${n}, PHẦN ${i + 1}/${chunks.length}.`,
      "Chỉ liệt kê nhân vật thực sự xuất hiện hoặc được nhắc tới có ý nghĩa trong PHẦN này. Không bịa.",
      "Mỗi object phải ngắn; không lặp hồ sơ cũ dài dòng. Chỉ trả về JSON array.",
      "Danh sách tên đã biết:", compactCharacterList(state),
      "NỘI DUNG PHẦN:", chunks[i],
      'JSON: [{"name":"","tier":"background|minor|supporting|important|major","role":"","relevanceToMC":"","appearance":"","personality":"","occupation":"","faction":"","goals":"","secret":"","weakness":"","fear":"","knowledge":"","currentLocation":"","physicalState":"","mentalState":"","chapterEvent":"","relationships":[{"withName":"","stage":"","trust":"","notes":""}],"isDead":false}]'
    ].join("\n\n");
    try {
      const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "system", content: "Bạn là bộ máy trích xuất dữ liệu nhân vật. Không được viết văn xuôi." }, { role: "user", content: prompt }], maxTokens: 3200, temperature: 0.15 }, 2);
      const parsed = parseArray(r.text);
      if (!parsed.items.length) {
        failed++;
        continue;
      }
      if (parsed.repaired) repaired++;
      parsed.items.forEach(u => { const x = mergeCharacter(state, u, n); if (x.created) totalNew++; else if (x.updated) totalUpdated++; });
    } catch (_) { failed++; }
  }
  return { ok: failed < chunks.length, chunks: chunks.length, nNew: totalNew, nUpdated: totalUpdated, repaired, failed };
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
  const chunks = chunkText(chapter.text, 14000, 800);
  let failed = 0, repaired = 0;
  for (let i = 0; i < chunks.length; i++) {
    const prompt = [
      `CẬP NHẬT THẾ GIỚI — CHƯƠNG ${n}, PHẦN ${i + 1}/${chunks.length}.`,
      "Chỉ trả địa điểm/vật phẩm/thread mới hoặc thay đổi rõ trong phần này. Không bịa.",
      "Địa điểm hiện có: " + (state.locations || []).map(x => x.name).join(", "),
      "Vật phẩm hiện có: " + (state.items || []).map(x => x.name).join(", "),
      "Thread hiện có:\n" + (state.threads || []).slice(-30).map(x => `${x.type}: ${x.desc} [${x.status}]`).join("\n"),
      "NỘI DUNG:", chunks[i],
      'JSON: {"locations":[{"name":"","description":"","status":"active|destroyed|abandoned|locked"}],"items":[{"name":"","description":"","owner":"","status":"active|lost|destroyed|stored"}],"threads":[{"type":"open_thread|foreshadowing|consequence","desc":"","status":"seeded|developing|paid_off|abandoned","matchExistingDesc":""}]}'
    ].join("\n\n");
    try {
      const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "system", content: "Bạn là bộ máy trích xuất world state. Chỉ trả JSON." }, { role: "user", content: prompt }], maxTokens: 2200, temperature: 0.15 }, 2);
      const obj = parseObject(r.text);
      if (!obj) { failed++; continue; }
      applyWorld(obj, n, state);
      if (r.finishReason === "length") repaired++;
    } catch (_) { failed++; }
  }
  return { ok: failed < chunks.length, chunks: chunks.length, repaired, failed };
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
  const previous = state.currentStatus || "(chưa có)";
  const source = ["STATUS CŨ:", previous, "", "TÓM TẮT CHƯƠNG:", chapter.summary || "", "", "ĐOẠN CUỐI:", chapter.text.slice(-9000)].join("\n");
  try {
    const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: [
      `Cập nhật CURRENT STATUS sau chương ${n}. Chỉ thay đổi những gì chương chứng minh. Không xóa thông tin cũ chỉ vì không nhắc lại.`,
      source,
      'Trả DUY NHẤT JSON: {"currentSituation":"","mainCharacter":"","characters":"","locations":"","power":"","relationships":"","knowledge":"","unresolved":"","nextHooks":""}'
    ].join("\n\n") }], maxTokens: 1800, temperature: 0.15 }, 2);
    const obj = parseObject(r.text);
    if (!obj) return { ok: false, reason: "status-parse" };
    const merged = {
      currentSituation: obj.currentSituation || "", mainCharacter: obj.mainCharacter || "", characters: obj.characters || "",
      locations: obj.locations || "", power: obj.power || "", relationships: obj.relationships || "", knowledge: obj.knowledge || "",
      unresolved: obj.unresolved || "", nextHooks: obj.nextHooks || ""
    };
    state.statusState = merged;
    const formatted = formatStatus(merged, n);
    if (formatted.split("\n").length >= 2) {
      state.currentStatus = formatted;
      state.lastStatusChapter = n;
    }
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

async function updateLongMemory(job, chapter, n, state) {
  const source = [
    "TÓM TẮT:", chapter.summary || "",
    "ĐOẠN ĐẦU:", chapter.text.slice(0, 3500),
    "ĐOẠN CUỐI:", chapter.text.slice(-7500),
    "FORESHADOWING ĐANG MỞ:", (state.foreshadowing || []).filter(x => !["paid_off","abandoned","resolved"].includes(x.status)).slice(-20).map(x => `${x.description} [${x.status}]`).join("\n")
  ].join("\n\n");
  try {
    const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: [
      `CẬP NHẬT LONG-TERM MEMORY SAU CHƯƠNG ${n}.`,
      "Chỉ ghi sự kiện có bằng chứng. Không bịa.",
      source,
      'Trả DUY NHẤT JSON: {"events":[{"type":"event|consequence|reveal|death|power_change","summary":"","causes":"","consequences":""}],"foreshadowing":[{"description":"","status":"seeded|developing|paid_off|abandoned","match":"","characters":""}],"knowledge":[{"character":"","fact":"","confidence":"direct|inferred|reported"}]}.'
    ].join("\n\n") }], maxTokens: 2200, temperature: 0.15 }, 2);
    const obj = parseObject(r.text);
    if (!obj) return { ok: false };
    if (!Array.isArray(state.timeline)) state.timeline = [];
    if (!Array.isArray(state.foreshadowing)) state.foreshadowing = [];
    if (!Array.isArray(state.knowledgeLedger)) state.knowledgeLedger = [];
    (obj.events || []).forEach(e => {
      if (!e?.summary) return;
      state.timeline.push({ id: genId("ev"), chapter: n, type: e.type || "event", summary: e.summary, causes: e.causes || "", consequences: e.consequences || "" });
    });
    (obj.foreshadowing || []).forEach(f => {
      if (!f?.description) return;
      const key = normalizeName(f.match || f.description).slice(0, 60);
      let x = state.foreshadowing.find(a => normalizeName(a.description).slice(0, 60) === key || normalizeName(a.description).includes(key.slice(0, 30)));
      if (!x) state.foreshadowing.push({ id: genId("fs"), description: f.description, status: f.status || "seeded", plantedChapter: n, lastUpdated: n, characters: f.characters || "" });
      else { if (f.status) x.status = f.status; x.lastUpdated = n; if (f.characters) x.characters = f.characters; }
    });
    (obj.knowledge || []).forEach(k => {
      if (!k?.character || !k?.fact) return;
      const key = normalizeName(k.character) + "|" + normalizeName(k.fact).slice(0, 80);
      let x = state.knowledgeLedger.find(a => normalizeName(a.character) + "|" + normalizeName(a.fact).slice(0, 80) === key);
      if (!x) state.knowledgeLedger.push({ id: genId("kl"), character: k.character, fact: k.fact, confidence: k.confidence || "direct", firstChapter: n, lastUpdated: n });
      else x.lastUpdated = n;
    });
    state.timeline = state.timeline.slice(-250);
    state.foreshadowing = state.foreshadowing.slice(-150);
    state.knowledgeLedger = state.knowledgeLedger.slice(-500);
    state.lastMemorySyncChapter = n;
    return { ok: true };
  } catch (_) { return { ok: false }; }
}

async function scanScenes(job, chapter, n, state) {
  if (!state.mature) return { ok: true, skipped: true };
  const source = representativeText(chapter.text, 24000);
  try {
    const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: `Nếu chương có cảnh trưởng thành, trích xuất ngắn gọn. Nếu không có trả []. Chỉ JSON array.\n${source}\n[{"intensity":1,"participants":[],"description":"","structure":"kiss|foreplay|sex|other"}]` }], maxTokens: 1400, temperature: 0.1 }, 2);
    const parsed = parseArray(r.text);
    if (!parsed.items.length && String(r.text || "").trim() !== "[]") return { ok: false };
    if (!Array.isArray(state.scenes)) state.scenes = [];
    parsed.items.forEach(s => { if (!s?.description) return; state.scenes.push({ id: genId("s"), chapter: n, intensity: Math.max(1, Math.min(10, Number(s.intensity) || 5)), participants: Array.isArray(s.participants) ? s.participants : [], description: s.description, structure: s.structure || "other", createdAt: Date.now() }); });
    return { ok: true, repaired: parsed.repaired };
  } catch (_) { return { ok: false }; }
}

function cleanJobForStore(job) {
  return { ...job, apiKey: job.apiKeyEncrypted ? null : (job.apiKey || null), apiKeyEncrypted: job.apiKeyEncrypted || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return jsonResponse(204, {});
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
    if (job.workerTokenHash) {
      if (!secretsEqual(job.workerTokenHash, hashSecret(workerToken))) return jsonResponse(403, { error: "Worker token không hợp lệ" });
    } else if (Number(job.schemaVersion || 0) >= 9) {
      return jsonResponse(403, { error: "Worker token không hợp lệ" });
    }
    if (["completed", "failed"].includes(job.status)) return jsonResponse(200, { success: true, jobId, status: job.status });
    if (job.status === "running") return jsonResponse(202, { success: true, jobId, status: "running" });

    job.status = "running";
    job.updatedAt = Date.now();
    job.progress = "Đang chuẩn bị viết chương...";
    job.apiKey = decryptText(job.apiKeyEncrypted);
    await store.setJSON(jobId, cleanJobForStore(job));

    const chapter = await generateOneChapter(job);
    const n = (job.storyState.chapters || []).length + 1;
    job.progress = "Đang tạo tóm tắt..."; job.updatedAt = Date.now(); await store.setJSON(jobId, cleanJobForStore(job));
    chapter.summary = await generateSummary(job, chapter, n);

    const newState = JSON.parse(JSON.stringify(job.storyState));
    if (!Array.isArray(newState.chapters)) newState.chapters = [];
    newState.chapters.push(chapter);
    newState.currentChapterIndex = newState.chapters.length - 1;
    newState.chaptersSinceBackup = (newState.chaptersSinceBackup || 0) + 1;
    if (!Array.isArray(chapter.autoUpdateIssues)) chapter.autoUpdateIssues = [];

    const checkpoint = async (progress) => { job.progress = progress; job.updatedAt = Date.now(); job.storyState = newState; await store.setJSON(jobId, cleanJobForStore(job)); };

    await checkpoint("Đang cập nhật nhân vật...");
    const rc = await updateCharacters(job, chapter, n, newState);
    if (!rc.ok) chapter.autoUpdateIssues.push(`NV: ${rc.failed}/${rc.chunks} lô lỗi; hệ thống vẫn giữ các NV đã cứu${rc.repaired ? `; JSON được cứu ${rc.repaired} lô` : ""}.`);
    else if (rc.repaired) chapter.autoUpdateIssues.push(`NV: đã tự cứu JSON bị cắt ở ${rc.repaired} lô; không bỏ toàn bộ danh sách.`);
    await checkpoint("Đang cập nhật địa điểm, vật phẩm, plot thread...");

    const rw = await updateWorld(job, chapter, n, newState);
    if (!rw.ok) chapter.autoUpdateIssues.push(`Thế giới: ${rw.failed}/${rw.chunks} lô lỗi.`);
    await checkpoint("Đang cập nhật Current Status...");

    const rs = await updateCurrentStatus(job, chapter, n, newState);
    if (!rs.ok) chapter.autoUpdateIssues.push("Status: không cập nhật được; Status cũ được giữ nguyên.");
    await checkpoint("Đang cập nhật Timeline / Foreshadowing / Knowledge Ledger...");
    const rm = await updateLongMemory(job, chapter, n, newState);
    if (!rm.ok) chapter.autoUpdateIssues.push("Memory: không cập nhật được Timeline/Foreshadowing/Knowledge; dữ liệu cũ được giữ.");
    await checkpoint("Đang quét Scene...");

    const rscene = await scanScenes(job, chapter, n, newState);
    if (!rscene.ok && !rscene.skipped) chapter.autoUpdateIssues.push("Scene: không đọc được dữ liệu cảnh.");

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
