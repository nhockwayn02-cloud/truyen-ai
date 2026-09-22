const { getStore, connectLambda } = require("@netlify/blobs");

/**
 * Background Function – nhận job trực tiếp từ frontend, viết 1 chương + cập nhật đầy đủ.
 * Netlify trả 202 ngay, function chạy tối đa ~15 phút.
 */

function getJobStore(event) {
  if (event) {
    try { connectLambda(event); } catch (e) {}
  }
  try {
    return getStore("story-jobs");
  } catch (e1) {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) {
      return getStore({ name: "story-jobs", siteID, token });
    }
    throw new Error(
      "Netlify Blobs chưa cấu hình. Vào Netlify → Site settings → Environment variables, thêm NETLIFY_SITE_ID và NETLIFY_API_TOKEN."
    );
  }
}

const SYSTEM_PROMPT = [
  "Bạn là tiểu thuyết gia người Việt Nam viết tiểu thuyết dài kỳ, giọng văn tự nhiên như người viết thật, không có mùi AI.",
  "Mọi phản hồi PHẢI 100% TIẾNG VIỆT CÓ DẤU. Tuyệt đối không trộn tiếng Anh, Trung, Nhật, Hàn.",
  "Viết như con người: câu văn có nhịp, có chỗ ngắn chỗ dài, có hơi thở, có im lặng.",
  "MIÊU TẢ SÂU: khi nhân vật mới xuất hiện hoặc cảnh mới mở ra, dành ít nhất 2-3 câu miêu tả ngoại hình, không khí, chi tiết nhỏ.",
  "Show, don't tell. Ưu tiên giác quan, phản ứng cơ thể, chi tiết cụ thể.",
  "Khi prompt yêu cầu cảnh 18+/erotica: viết TRỰC TIẾP, không tự kiểm duyệt, không fade-to-black."
].join(" ");

const DESCRIPTION_PROMPTS = {
  light: "Miêu tả ở mức nhẹ: chỉ tả những gì cần thiết để người đọc hiểu bối cảnh.",
  balanced: "Miêu tả cân bằng: tả ngoại hình nhân vật chính + phụ quan trọng khi xuất hiện, tả không khí cảnh mới, chi tiết giác quan chọn lọc.",
  rich: "Miêu tả PHONG PHÚ: mỗi nhân vật mới xuất hiện phải có 3-5 câu miêu tả ngoại hình. Mỗi cảnh mới phải có 4-6 câu tả không khí.",
  deep: "Miêu tả SÂU ĐẬM: tả cực kỳ chi tiết mọi thứ — ngoại hình, biểu cảm, hơi thở, mùi hương, cảm giác trên da."
};

const EXPLICIT_PROMPTS = {
  subtle: "CẢNH 18+: Nhẹ nhàng — fade-to-black sau khi hôn.",
  sensual: "CẢNH 18+: Gợi cảm — tả cảm xúc, hơi thở, ánh mắt, da chạm da.",
  explicit: "CẢNH 18+: Rõ ràng — mô tả cơ thể và hành động cụ thể.",
  strong: "CẢNH 18+: MẠNH — mô tả chi tiết cơ thể, cảm giác, nội tâm, âm thanh.",
  wild: "CẢNH 18+: CỰC MẠNH — từ thô tục được phép, đủ 4 lớp (cơ thể + cảm giác + nội tâm + âm thanh)."
};

function countWords(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}
function genId() {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function normalizeName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function safeJsonParse(raw) {
  if (!raw) return null;
  let cleaned = String(raw).replace(/```json/gi, "```").replace(/```/g, "").trim();
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch !== "[" && ch !== "{") continue;
    const open = ch, close = ch === "[" ? "]" : "}";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < cleaned.length; j++) {
      const c = cleaned[j];
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
          try { return JSON.parse(cleaned.slice(i, j + 1)); } catch (e) {}
        }
      }
    }
  }
  try { return JSON.parse(cleaned); } catch (e) { return null; }
}

function buildContext(state) {
  const parts = [];
  if (state.mainPlot) parts.push("CỐT TRUYỆN CHÍNH:\n" + state.mainPlot);
  if (state.genre) parts.push("Thể loại: " + state.genre);
  if (state.worldSetting) parts.push("Thế giới:\n" + state.worldSetting);
  if (state.worldRules) parts.push("Quy tắc thế giới:\n" + state.worldRules);
  if (state.worldDescription) parts.push("Miêu tả không khí:\n" + state.worldDescription);
  if (state.pronounRules) parts.push("QUY TẮC XƯNG HÔ (BẮT BUỘC):\n" + state.pronounRules);
  if (state.currentStatus) parts.push("CURRENT STATUS:\n" + state.currentStatus);
  if (state.directive) parts.push("MỆNH LỆNH CHƯƠNG TỚI:\n" + state.directive);
  if (state.advancedRules) parts.push("QUY TẮC NÂNG CAO:\n" + state.advancedRules);
  const mc = state.mainCharProfile;
  if (mc && mc.name) {
    parts.push("NHÂN VẬT CHÍNH: " + mc.name +
      (mc.appearance ? "\nNgoại hình: " + mc.appearance : "") +
      (mc.personality ? "\nTính cách: " + mc.personality : "") +
      (mc.speech ? "\nCách nói: " + mc.speech : ""));
  }
  if (Array.isArray(state.characters) && state.characters.length) {
    const important = state.characters
      .filter(c => ["major", "important", "supporting"].includes(c.tier) && !c.dead)
      .slice(0, 10);
    if (important.length) {
      parts.push("NHÂN VẬT QUAN TRỌNG:\n" + important.map(c =>
        `- ${c.name} (${c.tier}): ${c.appearance || ""} | ${c.personality || ""} | Vị trí: ${c.currentLocation || "?"}`
      ).join("\n"));
    }
  }
  const sb = state.styleBible || {};
  if (sb.tone || sb.sample) {
    parts.push("STYLE: " + (sb.tone || "") + (sb.sample ? "\nMẫu: " + sb.sample.slice(0, 400) : ""));
  }
  return parts.join("\n\n");
}

function buildRecentContext(chapters) {
  if (!chapters || !chapters.length) return "Đây là chương đầu tiên.";
  const last = chapters[chapters.length - 1];
  const ending = (last.text || "").slice(-1400);
  let older = "";
  if (chapters.length >= 2) {
    const prev = chapters[chapters.length - 2];
    older = `Chương trước nữa (${prev.title || ""}): ${(prev.summary || prev.text || "").slice(0, 700)}\n\n`;
  }
  return older + `===== ĐOẠN KẾT CHƯƠNG GẦN NHẤT (PHẢI TIẾP NỐI) =====\n${ending}\n===== HẾT =====`;
}

async function callOpenRouter({ endpoint, apiKey, model, messages, maxTokens = 12000, temperature = 0.95 }) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://xuong-truyen-ai.netlify.app",
      "X-Title": "Xuong Truyen AI Background"
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      frequency_penalty: 0.4,
      presence_penalty: 0.3
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content || "",
    finishReason: data.choices?.[0]?.finish_reason || null
  };
}

async function generateOneChapter(job) {
  const state = job.storyState;
  const chapters = state.chapters || [];
  const chapterNumber = chapters.length + 1;
  const context = buildContext(state);
  const recent = buildRecentContext(chapters);
  const descLevel = state.descriptionLevel || "balanced";
  const explicitLevel = state.explicitLevel || "strong";
  const minWords = Math.min(state.minChapterWords || 4000, 5000);

  let useModel = job.model;
  let isNsfw = false;
  if (job.forceNsfw || (state.mature && state.nsfwMode !== "never")) {
    const directive = (state.directive || "").toLowerCase();
    const hotKeywords = ["cảnh nóng", "sex", "18+", "làm tình", "âu yếm", "quan hệ", "nóng", "erotic", "nsfw"];
    if (job.forceNsfw || hotKeywords.some(k => directive.includes(k))) {
      useModel = job.modelNsfw || job.model;
      isNsfw = true;
    }
  }

  const prompt = [
    "BẮT BUỘC NGÔN NGỮ: 100% TIẾNG VIỆT CÓ DẤU.",
    "GIỌNG VĂN: Tự nhiên như người viết thật.",
    "",
    `Bạn đang viết CHƯƠNG THỨ ${chapterNumber}. Truyện đã có ${chapters.length} chương.`,
    "",
    "🎨 " + (DESCRIPTION_PROMPTS[descLevel] || DESCRIPTION_PROMPTS.balanced),
    "",
    "Bối cảnh:",
    context || "(chưa có — tự sáng tạo hợp lý)",
    "",
    recent,
    "",
    `Viết chương TỐI THIỂU ${minWords} từ. Chia nhiều cảnh/đoạn.`,
    "CHỐNG LẶP: Không lặp sự kiện, cấu trúc, cụm từ đã dùng.",
    state.pronounRules ? ("\nQUY TẮC XƯNG HÔ:\n" + state.pronounRules) : "",
    isNsfw ? ("\nMỨC 18+: " + (EXPLICIT_PROMPTS[explicitLevel] || EXPLICIT_PROMPTS.strong)) : "",
    "",
    "QUY TẮC TIÊU ĐỀ: Chỉ TÊN CHƯƠNG tiếng Việt, KHÔNG chữ 'Chương', KHÔNG số.",
    "",
    "Định dạng:",
    "TIÊU ĐỀ: <tên chương>",
    "NỘI DUNG:",
    "<toàn bộ chương>"
  ].filter(Boolean).join("\n");

  let { text: rawText, finishReason } = await callOpenRouter({
    endpoint: job.apiEndpoint,
    apiKey: job.apiKey,
    model: useModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ],
    maxTokens: 12000,
    temperature: isNsfw ? 1.0 : 0.95
  });

  const titleMatch = rawText.match(/TIÊU ĐỀ:\s*(.+)/i);
  const bodyMatch = rawText.match(/NỘI DUNG:\s*([\s\S]*)/i);
  let title = titleMatch ? titleMatch[1].trim() : "";
  title = title
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/^chương\s*\d+\s*[:\-–—.]\s*/i, "")
    .replace(/^\d+\s*[:\-–—.]\s*/, "")
    .trim();
  if (!title) title = "Không có tiêu đề";

  let text = bodyMatch ? bodyMatch[1].trim() : rawText.trim();
  let wordCount = countWords(text);
  let truncated = finishReason === "length";

  // Auto-continue tối đa 1 lần (tiết kiệm thời gian)
  if (wordCount < minWords * 0.8 && !truncated) {
    const tail = text.slice(-1800);
    const contPrompt = [
      "BẮT BUỘC: 100% TIẾNG VIỆT CÓ DẤU.",
      `VIẾT TIẾP chương ${chapterNumber} (không mở chương mới). Hiện ${wordCount} từ, cần tối thiểu ${minWords} từ.`,
      "",
      "===== ĐOẠN CUỐI (PHẢI TIẾP NỐI) =====",
      tail,
      "===== HẾT =====",
      "",
      "Viết tiếp 1500-2500 từ. Bắt đầu ngay từ câu tiếp theo.",
      isNsfw ? ("MỨC 18+: " + (EXPLICIT_PROMPTS[explicitLevel] || "")) : ""
    ].join("\n");

    try {
      const contRes = await callOpenRouter({
        endpoint: job.apiEndpoint,
        apiKey: job.apiKey,
        model: useModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: contPrompt }
        ],
        maxTokens: 8000,
        temperature: 0.95
      });
      if (contRes.text && contRes.text.length > 100) {
        text = text.replace(/\s+$/, "") + "\n\n" + contRes.text.trim();
        wordCount = countWords(text);
        truncated = contRes.finishReason === "length";
      }
    } catch (e) {
      console.warn("Auto-continue failed:", e.message);
    }
  }

  return {
    title,
    text,
    wordCount,
    truncated,
    plan: "",
    continuityWarnings: [],
    modelUsed: useModel,
    isNsfw,
    polished: false,
    summary: "",
    versions: [],
    compressed: false,
    createdBy: "background",
    createdAt: Date.now(),
    autoUpdateIssues: []
  };
}

async function generateSummary(job, chapter, chapterNumber) {
  try {
    const { text } = await callOpenRouter({
      endpoint: job.apiEndpoint,
      apiKey: job.apiKey,
      model: job.model,
      messages: [{
        role: "user",
        content: [
          "Tóm tắt chương sau trong 3-5 câu (TIẾNG VIỆT). Tập trung sự kiện, nhân vật, thay đổi quan hệ. Chỉ trả tóm tắt.",
          "",
          "Chương " + chapterNumber + ":",
          chapter.text.slice(0, 12000)
        ].join("\n")
      }],
      maxTokens: 500,
      temperature: 0.3
    });
    return (text || "").trim();
  } catch (e) {
    return "";
  }
}

async function updateCharacters(job, chapter, chapterNumber, state) {
  try {
    const existing = (state.characters || []).map(c =>
      `${c.name} (${c.tier || "supporting"}): ${c.appearance || ""} | ${c.personality || ""}`
    ).join("\n") || "(chưa có)";
    let body = chapter.text;
    if (body.length > 25000) body = body.slice(0, 10000) + "\n\n[...]\n\n" + body.slice(-12000);

    const { text: raw } = await callOpenRouter({
      endpoint: job.apiEndpoint,
      apiKey: job.apiKey,
      model: job.model,
      messages: [{
        role: "user",
        content: [
          "Theo dõi nhân vật. Trả JSON array nhân vật MỚI hoặc CÓ THAY ĐỔI.",
          "NHÂN VẬT HIỆN CÓ:", existing,
          "",
          "CHƯƠNG " + chapterNumber + ":", body,
          "",
          'Trả DUY NHẤT JSON: [{"name":"","tier":"supporting","appearance":"","personality":"","currentLocation":""}]'
        ].join("\n")
      }],
      maxTokens: 2000,
      temperature: 0.2
    });

    const arr = safeJsonParse(raw);
    if (!Array.isArray(arr)) return { ok: false };
    if (!Array.isArray(state.characters)) state.characters = [];

    arr.forEach(u => {
      if (!u.name) return;
      const n = normalizeName(u.name);
      let char = state.characters.find(c => normalizeName(c.name) === n);
      if (!char) {
        state.characters.push({
          id: genId(), name: u.name, tier: u.tier || "supporting",
          appearance: u.appearance || "", personality: u.personality || "",
          currentLocation: u.currentLocation || "",
          firstAppearance: chapterNumber, lastAppearance: chapterNumber,
          locked: false, dead: false, history: []
        });
      } else {
        if (u.appearance) char.appearance = u.appearance;
        if (u.personality) char.personality = u.personality;
        if (u.currentLocation) char.currentLocation = u.currentLocation;
        char.lastAppearance = chapterNumber;
      }
    });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

async function updateWorld(job, chapter, chapterNumber, state) {
  try {
    let body = chapter.text;
    if (body.length > 22000) body = body.slice(0, 9000) + "\n\n[...]\n\n" + body.slice(-10000);
    const { text: raw } = await callOpenRouter({
      endpoint: job.apiEndpoint,
      apiKey: job.apiKey,
      model: job.model,
      messages: [{
        role: "user",
        content: [
          "Địa điểm: " + ((state.locations || []).map(l => l.name).join(", ") || "(chưa)"),
          "Vật phẩm: " + ((state.items || []).map(i => i.name).join(", ") || "(chưa)"),
          "",
          "Chương " + chapterNumber + ":", body,
          "",
          'Trả JSON: {"locations":[{"name":"","description":"","status":"active"}],"items":[{"name":"","description":"","owner":"","status":"active"}],"threads":[{"type":"open_thread","desc":"","status":"seeded"}]}'
        ].join("\n")
      }],
      maxTokens: 1500,
      temperature: 0.25
    });
    const obj = safeJsonParse(raw);
    if (!obj) return { ok: false };
    if (!Array.isArray(state.locations)) state.locations = [];
    if (!Array.isArray(state.items)) state.items = [];
    if (!Array.isArray(state.threads)) state.threads = [];

    (obj.locations || []).forEach(u => {
      if (!u.name) return;
      let l = state.locations.find(x => normalizeName(x.name) === normalizeName(u.name));
      if (!l) state.locations.push({ id: genId(), name: u.name, description: u.description || "", status: u.status || "active", firstAppearance: chapterNumber, lastAppearance: chapterNumber });
      else { if (u.description) l.description = u.description; if (u.status) l.status = u.status; l.lastAppearance = chapterNumber; }
    });
    (obj.items || []).forEach(u => {
      if (!u.name) return;
      let it = state.items.find(x => normalizeName(x.name) === normalizeName(u.name));
      if (!it) state.items.push({ id: genId(), name: u.name, description: u.description || "", owner: u.owner || "", status: u.status || "active", firstAppearance: chapterNumber, lastAppearance: chapterNumber });
      else { if (u.description) it.description = u.description; if (u.owner) it.owner = u.owner; if (u.status) it.status = u.status; it.lastAppearance = chapterNumber; }
    });
    (obj.threads || []).forEach(t => {
      if (!t.desc) return;
      state.threads.push({ id: genId(), type: t.type || "open_thread", status: t.status || "seeded", desc: t.desc, chapterIntroduced: chapterNumber });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

async function updateCurrentStatus(job, chapter, chapterNumber, state) {
  try {
    let body = chapter.text;
    if (body.length > 22000) body = body.slice(0, 9000) + "\n\n[...]\n\n" + body.slice(-10000);
    const { text: st } = await callOpenRouter({
      endpoint: job.apiEndpoint,
      apiKey: job.apiKey,
      model: job.model,
      messages: [{
        role: "user",
        content: [
          "Viết lại CURRENT STATUS sau chương " + chapterNumber + ".",
          "STATUS CŨ:", state.currentStatus || "(chưa có)",
          "",
          "CHƯƠNG " + chapterNumber + ":", body,
          "",
          "Trả về status mới, dòng đầu: Current Status Update - Sau Chương " + chapterNumber
        ].join("\n")
      }],
      maxTokens: 2000,
      temperature: 0.25
    });
    let cleaned = (st || "").trim();
    if (cleaned && !/sau chương\s*\d+/i.test(cleaned.slice(0, 80))) {
      cleaned = "Current Status Update - Sau Chương " + chapterNumber + "\n" + cleaned;
    }
    state.currentStatus = cleaned;
    state.lastStatusChapter = chapterNumber;
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

async function scanScenes(job, chapter, chapterNumber, state) {
  if (!state.mature) return { ok: true, skipped: true };
  try {
    let body = chapter.text;
    if (body.length > 20000) body = body.slice(0, 8000) + "\n\n[...]\n\n" + body.slice(-9000);
    const { text: raw } = await callOpenRouter({
      endpoint: job.apiEndpoint,
      apiKey: job.apiKey,
      model: job.model,
      messages: [{
        role: "user",
        content: [
          "Phát hiện cảnh 18+. Chương " + chapterNumber + ":", body,
          "",
          'Trả JSON array (có thể []): [{"intensity":1-10,"participants":[],"description":"","structure":"kiss|foreplay|sex|other"}]'
        ].join("\n")
      }],
      maxTokens: 1200,
      temperature: 0.2
    });
    const arr = safeJsonParse(raw);
    if (!Array.isArray(arr)) return { ok: false };
    if (!Array.isArray(state.scenes)) state.scenes = [];
    arr.forEach(s => {
      if (!s.description) return;
      state.scenes.push({
        id: genId(), chapter: chapterNumber,
        intensity: Math.min(10, Math.max(1, parseInt(s.intensity, 10) || 5)),
        participants: Array.isArray(s.participants) ? s.participants : [],
        description: s.description, structure: s.structure || "other", createdAt: Date.now()
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: ""
    };
  }

  let jobId = null;
  let job = null;
  const store = getJobStore(event);

  try {
    const body = JSON.parse(event.body || "{}");

    // Hai chế độ:
    // 1) Có jobId → tiếp tục job cũ (từ create-job)
    // 2) Có storyState + apiKey → tạo job mới và viết luôn (khuyến nghị)
    if (body.jobId && !body.storyState) {
      jobId = body.jobId;
      job = await store.get(jobId, { type: "json" });
      if (!job) {
        return { statusCode: 404, body: JSON.stringify({ error: "Job not found" }) };
      }
    } else if (body.storyState && body.apiKey) {
      jobId = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      job = {
        jobId,
        status: "running",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        apiEndpoint: body.apiEndpoint || "https://openrouter.ai/api/v1/chat/completions",
        model: body.model || "deepseek/deepseek-v3.2",
        modelNsfw: body.modelNsfw || "aion-labs/aion-2.0",
        forceNsfw: !!body.forceNsfw,
        apiKey: body.apiKey.trim(),
        storyState: body.storyState,
        resultChapter: null,
        error: null,
        progress: "Đang viết chương..."
      };
      await store.setJSON(jobId, job);
    } else {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Cần jobId hoặc (storyState + apiKey)" })
      };
    }

    // Đánh dấu running
    job.status = "running";
    job.progress = "Đang viết chương...";
    job.updatedAt = Date.now();
    await store.setJSON(jobId, job);

    // Viết chương
    const chapter = await generateOneChapter(job);
    const chapterNumber = (job.storyState.chapters || []).length + 1;

    job.progress = "Đang tạo tóm tắt...";
    job.updatedAt = Date.now();
    await store.setJSON(jobId, job);

    chapter.summary = await generateSummary(job, chapter, chapterNumber);

    const newState = JSON.parse(JSON.stringify(job.storyState));
    if (!Array.isArray(newState.chapters)) newState.chapters = [];
    newState.chapters.push(chapter);
    newState.currentChapterIndex = newState.chapters.length - 1;
    newState.chaptersSinceBackup = (newState.chaptersSinceBackup || 0) + 1;

    job.progress = "Đang cập nhật nhân vật...";
    await store.setJSON(jobId, job);
    const rChar = await updateCharacters(job, chapter, chapterNumber, newState);
    if (!rChar.ok) chapter.autoUpdateIssues.push("NV");

    job.progress = "Đang cập nhật thế giới...";
    await store.setJSON(jobId, job);
    const rWorld = await updateWorld(job, chapter, chapterNumber, newState);
    if (!rWorld.ok) chapter.autoUpdateIssues.push("Thế giới");

    job.progress = "Đang cập nhật Current Status...";
    await store.setJSON(jobId, job);
    const rStatus = await updateCurrentStatus(job, chapter, chapterNumber, newState);
    if (!rStatus.ok) chapter.autoUpdateIssues.push("Status");

    job.progress = "Đang quét Scene...";
    await store.setJSON(jobId, job);
    const rScene = await scanScenes(job, chapter, chapterNumber, newState);
    if (!rScene.ok && !rScene.skipped) chapter.autoUpdateIssues.push("Scene");

    // Hoàn thành
    job.status = "completed";
    job.progress = "Hoàn thành";
    job.resultChapter = chapter;
    job.storyState = newState;
    job.apiKey = null;
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    await store.setJSON(jobId, job);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        jobId,
        chapterTitle: chapter.title,
        wordCount: chapter.wordCount
      })
    };
  } catch (err) {
    console.error("Background error:", err);
    if (job && jobId) {
      job.status = "failed";
      job.error = err.message || String(err);
      job.progress = "Lỗi: " + (err.message || "unknown");
      job.apiKey = null;
      job.updatedAt = Date.now();
      try { await store.setJSON(jobId, job); } catch (e) {}
    }
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
