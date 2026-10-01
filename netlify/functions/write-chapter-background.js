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

const CREATIVE_TEMP = 0.7; // V12.20: hạ từ 0.82 để bớt từ lỗi
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

// <<SHARED-CORE:BEGIN>> (tự sinh từ shared/core.js — KHÔNG sửa tay; chạy: node scripts/sync-shared.js)
function countWords(text) { return (text || "").trim().split(/\s+/).filter(Boolean).length; }

function normalizeName(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function chapterWordLimits(st) {
  // Client gọi không tham số (dùng state toàn cục); worker truyền state của job.
  if (!st && typeof state !== "undefined") st = state;
  const target = Math.min(Math.max(Number(st && st.minChapterWords) || 5000, 500), 6000);
  return { target, hardMax: Math.ceil(target * 1.15) };
}

function trimToWordLimit(text, maxWords) {
  // V12.14: cắt theo vị trí ký tự để GIỮ NGUYÊN xuống dòng/đoạn (bản cũ split+join làm mất toàn bộ đoạn văn/thoại).
  const s = String(text || "").trim();
  if (!s || countWords(s) <= maxWords) return { text: s, trimmed: false };
  const re = /\S+/g; let mt, n = 0, end = 0;
  while ((mt = re.exec(s))) { n++; end = mt.index + mt[0].length; if (n >= maxWords) break; }
  let out = s.slice(0, end);
  const m = out.match(/^([\s\S]*[.!?…][”"’']?)(?:\s|$)/);
  // V12.20: ngưỡng 70% giới hạn (bản cũ chỉ 180 từ cuối -> hay cắt cụt giữa câu khi đoạn dài)
  if (m && countWords(m[1]) >= Math.max(1, Math.floor(maxWords * 0.7))) out = m[1];
  return { text: out.trim(), trimmed: true };
}

function stripForeign(text) {
  // V12.10: dọn chữ Hán/Nhật/Hàn/Cyrillic/Thái/Ả Rập/Hindi còn sót (kể cả khi dưới ngưỡng viết lại).
  if (!text) return text;
  let t = String(text)
    .replace(/，/g, ", ").replace(/。/g, ". ").replace(/！/g, "! ").replace(/？/g, "? ").replace(/：/g, ": ").replace(/、/g, ", ")
    .replace(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0E00-\u0E7F\u0600-\u06FF\u0900-\u097F]+/g, "");
  return t.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?;:])/g, "$1").replace(/\( *\)|“ *”|" *"/g, "");
}

function detectNonVietnamese(text) {
  if (!text) return false;
  const foreign = (String(text).match(/[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0E00-\u0E7F\u0600-\u06FF\u0900-\u097F]/g) || []).length;
  const total = String(text).replace(/\s/g, "").length || 1;
  return (foreign / total) > 0.005;
}

function normalizeChapterMatureFocus(v) {
  const x = String(v || "none").toLowerCase();
  return x === "primary" || x === "secondary" ? x : "none";
}

const NSFW_KEYWORDS = [
  "cảnh nóng", "cảnh sex", "cảnh 18", "cảnh 18+", "làm tình", "ân ái", "giao hợp", "sex", "sexx", "sexy", "nsfw", "erotic", "erotica", "porn", "âu yếm", "vuốt ve", "mơn trớn", "ve vuốt", "hôn sâu", "hôn môi", "hôn cổ", "cởi đồ", "cởi áo", "cởi quần", "không mặc", "khỏa thân", "trần truồng", "nude", "sờ soạng", "sờ ngực", "sờ mông", "nắn bóp", "liếm", "thổi kèn", "dương vật", "âm đạo", "âm hộ", "núm vú", "háng", "cặc", "lồn", "thúc mạnh", "xuất tinh", "orgasm", "cao trào", "khoái cảm", "doggy", "missionary", "cowgirl", "oral", "blowjob", "handjob", "viết nóng", "viết 18", "tăng nhiệt", "nóng hơn", "cảnh ân ái", "đêm tân hôn", "mất trinh", "đoạt mất", "chiếm đoạt cơ thể", "ham muốn", "dục vọng", "nứng", "rên rỉ", "rên la", "rên ưỡn", "quan hệ tình dục", "quan hệ xác thịt", "bóp mông"
];

const _NSFW_RE = new RegExp("(?<![\\p{L}\\p{N}])(?:" + NSFW_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\p{L}\\p{N}])", "iu");

function textHasNsfwKeyword(text) {
  if (!text) return false;
  return _NSFW_RE.test(String(text).normalize("NFC"));
}

function parseAgeNum(a) { const m = String(a == null ? "" : a).match(/\d{1,4}/); return m ? parseInt(m[0], 10) : null; }

function underageNames(s) {
  const out = []; const chk = (n, a) => { const v = parseAgeNum(a); if (n && v !== null && v < 18) out.push(String(n)); };
  chk(s.mainCharProfile && s.mainCharProfile.name, s.mainCharProfile && s.mainCharProfile.age);
  (s.characters || []).forEach(c => chk(c && c.name, c && c.age));
  return out;
}

function ageGuardPrompt(s) {
  const u = underageNames(s);
  return "RÀO CHẮN TUỔI (bắt buộc): chỉ nhân vật đã trưởng thành (từ 18 tuổi trở lên) mới được tham gia cảnh tình dục/khiêu dâm. Tuyệt đối không viết nội dung tình dục với nhân vật dưới 18 tuổi hoặc được mô tả như trẻ em."
    + (u.length ? (" Nhân vật KHÔNG được xuất hiện trong cảnh 18+: " + u.join(", ") + ".") : "");
}

function _sumNorm(s){ return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim(); }

function summaryNameList(text, characters){
  const nt=_sumNorm(text);
  return (characters||[]).map(c=>c&&c.name).filter(Boolean).filter(n=>nt.includes(_sumNorm(n))).slice(0,40);
}

function _sumNameGrounded(name, text){
  const toks=String(name).split(/\s+/).filter(Boolean);
  let hit=0;
  toks.forEach(t=>{ try{ if(new RegExp("(^|[^\\p{L}])"+t+"(?![\\p{L}])","u").test(text)) hit++; }catch(_){} });
  return hit >= Math.ceil(toks.length/2);
}

function summaryGrounded(summary, text){
  const names=[]; const bad=[]; let good=0;
  (String(summary).match(/(?:\p{Lu}\p{Ll}+)(?:\s+\p{Lu}\p{Ll}+)+/gu)||[]).forEach(nm=>{
    if(names.includes(nm)) return; names.push(nm);
    if(_sumNameGrounded(nm, text)) good++; else bad.push(nm);
  });
  const nameOk = names.length<2 || bad.length/names.length <= 0.34;
  const tw=new Set((_sumNorm(text).match(/[a-z0-9]{2,}/g)||[]));
  const sw=(_sumNorm(summary).match(/[a-z]{4,}/g)||[]);
  const ov = sw.length ? sw.filter(w=>tw.has(w)).length/sw.length : 1;
  return { ok: nameOk && ov>=0.4, bad, ov };
}

function extractiveSummary(text){
  const paras=String(text||"").split(/\n+/).map(p=>p.trim()).filter(p=>p.length>60);
  if(!paras.length) return "";
  const pick=Math.min(9, paras.length); const out=[];
  for(let i=0;i<pick;i++){
    const p=paras[Math.floor(i*paras.length/pick)];
    const w=p.split(/\s+/); let seg=w.slice(0,45).join(" ");
    if(w.length>45){ const k=Math.max(seg.lastIndexOf(". "),seg.lastIndexOf("! "),seg.lastIndexOf("? ")); if(k>seg.length*0.4) seg=seg.slice(0,k+1); }
    out.push(seg);
  }
  return "**Tóm tắt chương:** (trích tự động từ văn bản)\n\n"+out.join("\n\n");
}

function buildSummaryPrompt(text, n, names, adult){
  return [
    "Bạn là bộ máy tóm tắt. Chỉ được dựa vào văn bản trong thẻ <chuong>; không có kiến thức nào khác về truyện này.",
    "<chuong>", text, "</chuong>",
    "NHIỆM VỤ: tóm tắt CHƯƠNG "+n+" trên đây theo đúng trình tự diễn ra.",
    "1) Chỉ dùng nhân vật, địa điểm, đồ vật, giờ giấc, lời thoại CÓ trong <chuong>. Không thêm, không suy diễn. Nếu chương không nêu giờ giấc hay chức danh thì KHÔNG ghi.",
    names && names.length ? "2) Tên nhân vật xuất hiện trong chương (chỉ dùng đúng các tên này): "+names.join(", ")+"." : "2) Dùng đúng tên nhân vật như viết trong chương.",
    "3) Định dạng: mở đầu bằng dòng \"**Tóm tắt chương:**\", rồi 1 câu nêu mạch chính, sau đó 4-5 đoạn ngắn theo diễn biến (mỗi đoạn một cảnh/mốc). Không dùng nhãn Đầu/Giữa/Cuối, không gạch đầu dòng, không mô tả tiêu chí tóm tắt.",
    adult
      ? "4) Chương này có cảnh người lớn (18+/khống chế): thuật lại CỤ THỂ, không nói giảm nói tránh — nêu đúng ai làm gì với ai, hành động, đạo cụ, tư thế/vị trí, câu nói/mệnh lệnh chính và hệ quả, dùng đúng từ ngữ mà chương đã dùng; không rút gọn thành 'cảnh nóng/thân mật', không bỏ cảnh, không thêm chi tiết ngoài văn bản, không bình luận đạo đức."
      : "4) Với cảnh nhạy cảm (18+/bạo lực/cưỡng ép): thuật lại ngắn gọn, trung lập ai làm gì với ai, câu nói/mệnh lệnh chính và hệ quả — không bỏ cảnh, không thêm chi tiết ngoài văn bản.",
    "5) Câu cuối: trạng thái cuối chương theo đúng văn bản.",
    "6) Độ dài 300-400 từ tiếng Việt, tối đa 400. Chỉ trả về bản tóm tắt."
  ].join("\n");
}

function summaryRetryNote(g){
  return "\n\nLỖI LẦN TRƯỚC: bản tóm tắt chứa nội dung KHÔNG có trong <chuong>"+(g.bad&&g.bad.length?" (tên không có trong chương, cấm dùng: "+g.bad.join(", ")+")":"")+". Viết lại: bắt đầu bằng \"**Tóm tắt chương:**\" rồi chỉ kể lại các sự kiện có thật trong <chuong>.";
}

function formatParagraphs(text) {
  // V12.15: tự ngắt đoạn khi AI trả về khối văn đặc; mỗi lượt thoại một đoạn riêng; các đoạn cách nhau 1 dòng trống.
  const src = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!src) return src;
  const OPEN = /^[“"«‘'—–-]\s*/;
  const isTerm = c => ".!?…".indexOf(c) >= 0;
  const splitSentences = block => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < block.length; i++) {
      const ch = block[i]; cur += ch;
      if (ch === "“") q = true; else if (ch === "”") q = false; else if (ch === '"') q = !q;
      if (q) continue;
      let j = i; while (j + 1 < block.length && /["”’'»)]/.test(block[j + 1])) { j++; cur += block[j]; }
      const last = cur.replace(/["”’'»)\s]+$/, "").slice(-1);
      if (isTerm(last) && (j === i ? isTerm(ch) : true) && /\s/.test(block[j + 1] || " ")) {
        let k = j + 1; while (k < block.length && /\s/.test(block[k])) k++;
        const nx = block.slice(k, k + 1);
        if (!nx || /[\p{Lu}“"«‘—–-]/u.test(nx)) { out.push(cur.trim()); cur = ""; }
        i = j;
      } else i = j;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const paras = [];
  for (const raw of src.split(/\n+/)) {
    const block = raw.trim(); if (!block) continue;
    const sents = splitSentences(block);
    if (block.length <= 500 && !sents.some((x, i) => i > 0 && OPEN.test(x))) { paras.push(block); continue; }
    let cur = [], len = 0, curDialog = false;
    const flush = () => { if (cur.length) paras.push(cur.join(" ")); cur = []; len = 0; curDialog = false; };
    for (const s of sents) {
      const dlg = OPEN.test(s);
      if (dlg && cur.length) flush();
      if (!dlg && curDialog) flush();
      cur.push(s); len += s.length; curDialog = dlg || curDialog;
      if (curDialog) { if (/["”’»][^“"]{0,80}$/.test(s) || /[.!?…]$/.test(s)) flush(); }
      else if (cur.length >= 3 || len >= 320) flush();
    }
    flush();
  }
  return paras.join("\n\n");
}

// ===== V12.15: chống lặp cảnh + phát hiện từ lạ =====
function _normWords(s) {
  return String(s || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}
function _grams(words, n) {
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(" "));
  return set;
}
function _sim(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size);
}
// Nếu văn bản có một "bản viết lại" của phần đầu (model chép lại từ đầu), cắt bỏ từ chỗ lặp trở đi.
// Trả về text gốc nếu không phát hiện gì. Chấp nhận cả trường hợp 2 bản dính liền không có dòng trống.
function dedupeRepeatedScene(text) {
  const src = String(text || "");
  if (src.length < 1500) return src;
  const sep = src.replace(/(\p{Ll}[.!?…”"])(\p{Lu}\p{Ll})/gu, "$1\n\n$2");
  const paras = sep.split(/\n\s*\n+|\n/).map(p => p.trim()).filter(Boolean);
  const info = paras.map(p => { const w = _normWords(p); return { p, n: w.length, g: _grams(w, 3) }; });
  const isDup = (i, from) => {
    if (info[i].n < 8) return -1;
    for (let j = from; j < i; j++) if (info[j].n >= 8 && _sim(info[i].g, info[j].g) >= 0.5) return j;
    return -1;
  };
  for (let i = 3; i < info.length - 1; i++) {
    const j = isDup(i, 0);
    if (j < 0 || j > 2) continue; // chỉ coi là 'viết lại từ đầu' khi trùng với các đoạn mở đầu chương
    // xác nhận: đoạn kế tiếp cũng trùng với một đoạn nằm sau j (tránh nhầm câu lặp có chủ đích)
    let ok = false;
    for (let k = i + 1; k <= Math.min(i + 2, info.length - 1) && !ok; k++) {
      if (info[k].n < 8) continue;
      for (let m = j + 1; m < i; m++) if (_sim(info[k].g, info[m].g) >= 0.5) { ok = true; break; }
    }
    if (ok) return paras.slice(0, i).join("\n\n");
  }
  return src;
}
// Với lượt viết tiếp: bỏ các đoạn mở đầu lặp lại nội dung đã có. Trả "" nếu toàn bộ là lặp.
function dropRestartedContinuation(baseText, contText) {
  const base = String(baseText || ""), cont = String(contText || "").trim();
  if (!cont) return cont;
  const baseG = _grams(_normWords(base), 3);
  const paras = cont.split(/\n\s*\n+|\n/).map(p => p.trim()).filter(Boolean);
  let cut = paras.length;
  for (let i = 0; i < paras.length; i++) {
    const w = _normWords(paras[i]); if (w.length < 15) continue;
    if (_sim(_grams(w, 3), baseG) >= 0.7) { cut = i; break; }
  }
  return paras.slice(0, cut).join("\n\n");
}
const _VN_OK = new Set(["sedan","neon","email","wifi","online","offline","game","app","video","office","laptop","zalo","facebook","youtube","internet","tiktok","inbox","mail","file","link","logo","menu","poster","taxi","radio","karaoke","video","casino","hotel","studio","check","deadline","ceo","kpi","vip","boss","sexy","show","team","sale","sales","manager","ipad","iphone","macbook","google","zoom","slack","excel","word","pdf","silicon","latex","titan","inox","laser","camera","remote","vibrator","plug","cuff","temp","lock","sexy","porn","sms","wifi","bluetooth","smartphone","selfie","livestream","hashtag","comment","story","stress","stalker","vest","blazer","jacket","cardigan","sandal","jeans","shorts","bikini","lingerie","corset","sofa","mascara","vecni","lipstick","gloss","lotion","serum","shampoo","parfum","spa","massage","gym","yoga","pilates","sandwich","burger","pizza","coffee","latte","cappuccino","cocktail","whisky","vodka","chanel","dior","gucci","prada","hermes","versace","nike","adidas","lelo","durex","kindle","netflix","spotify","messenger","instagram","iphone","android","samsung","alô","alo","hello","okay","bye","café","cafe","bar","pub","resort","menu","blouse","boxer","ballet","salon","shop","box","stylist","designer","leader","model","manager","outfit","style","cocktail"]);
const _VN_SYL = /^(ngh|ng|nh|kh|gh|gi|ph|qu|th|tr|ch|[bcdghklmnpqrstvx])?[aeiouy]{1,3}(ng|nh|ch|[cmnpt])?$/;
// V12.19: tiếng cười/hét/thở/tượng thanh viết bằng chữ không dấu (Aaaa, hahaha, hihi, hmmm, shhh...) KHÔNG phải từ lạ.
const _VN_SFX_RUN = /(.)\1{2,}/i;                                   // aaaa, ahhh, hmmm, shhh, ooooh
const _VN_SFX_LAUGH = /^[aeiou]?([hk][aeiou])\1+h?$/i;               // hahaha, hihi, hehe, huhuhu, kekeke, ahaha
const _VN_SFX_WORD = /^(?:h+m+|sh+|ps+t+|ts+k+|gr+|zz+z*|uh+m*|ah+|oh+|eh+)$/i;
function _isSoundEffect(low) { return _VN_SFX_RUN.test(low) || _VN_SFX_LAUGH.test(low) || _VN_SFX_WORD.test(low); }
// V12.19: bằng chứng đổi hồ sơ (thăng chức...) phải TRÍCH từ chính chương: >=70% từ của bằng chứng có trong văn bản nguồn.
function evidenceInText(evidence, text) {
  const ev = _normWords(String(evidence || "")).filter(w => w.length >= 2);
  if (ev.length < 3) return false;
  const have = new Set(_normWords(String(text || "")));
  let hit = 0; ev.forEach(w => { if (have.has(w)) hit++; });
  return hit / ev.length >= 0.7;
}
// V12.20: kiểm tra một âm tiết tiếng Việt hợp lệ (bỏ dấu thanh, giữ ă â ê ô ơ ư đ). Bắt lỗi kiểu "mươititude", "bănnton", "bọcampo".
const _VN_SYL_FULL = /^(?:ngh|ng|nh|kh|gh|gi|ph|qu|th|tr|ch|[bcdđghklmnpqrstvx])?[aăâeêioôơuưy]{1,3}(?:ng|nh|ch|[cmnpt])?$/;
function _stripToneMarks(s) { return String(s).normalize("NFD").replace(/[\u0300\u0301\u0303\u0309\u0323]/g, "").normalize("NFC"); }
function _isValidVnSyllable(low) { return _VN_SYL_FULL.test(_stripToneMarks(low)); }
function _hasVnDiacritic(t) { return /[ăâêôơưđàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(t); }
// Liệt kê từ lạ (không phải âm tiết tiếng Việt) chen trong văn bản. Chỉ để cảnh báo / làm đầu vào cho bước tự sửa.
// V12.20: bắt cả từ CÓ DẤU bị ghép lỗi (mươititude, bănnton, bọcampo); trước đây chỉ bắt từ không dấu.
function findStrayWords(text, allowNames, limit) {
  const out = []; const seen = new Set(); const max = Number(limit) || 12;
  const allow = new Set(_normWords((allowNames || []).join(" ")).map(w => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  const allowExact = new Set(_normWords((allowNames || []).join(" ")));
  const toks = String(text || "").match(/\p{L}+/gu) || [];
  for (const t of toks) {
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    if (/^[A-Za-z]+$/.test(t)) {
      if (t.length < 4) continue;
      if (_VN_OK.has(low) || _VN_SYL.test(low) || _isSoundEffect(low) || allow.has(low)) continue;
    } else {
      // Có dấu tiếng Việt: hợp lệ nếu là một âm tiết đúng cấu trúc. Chữ cái ngoài bảng chữ cái Việt (ü, ñ...) bỏ qua.
      if (t.length < 3 || !/^[\p{Script=Latin}]+$/u.test(t) || !_hasVnDiacritic(t)) continue;
      if (/[^a-zA-ZăâêôơưđĂÂÊÔƠƯĐàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ]/.test(t)) continue;
      if (_isValidVnSyllable(low) || _VN_OK.has(low) || allowExact.has(low) || allow.has(low.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))) continue;
    }
    seen.add(low); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// V12.20: tìm câu chứa từng từ lỗi để gửi AI sửa. Trả mảng { word, start, end, sentence, before } (không chồng lấn, theo thứ tự xuất hiện).
function locateWordSentences(text, words) {
  const src = String(text || ""); const found = [];
  const isL = (ch) => !!ch && /\p{L}/u.test(ch);
  for (const w of words || []) {
    let from = 0;
    while (from < src.length) {
      const i = src.indexOf(w, from); if (i < 0) break;
      from = i + w.length;
      if (isL(src[i - 1]) || isL(src[i + w.length])) continue;
      let a = i; while (a > 0 && !/[.!?…\n]/.test(src[a - 1])) a--;
      let b = i + w.length; while (b < src.length && !/[.!?…\n]/.test(src[b])) b++;
      while (b < src.length && /[.!?…”"’')]/.test(src[b]) && src[b] !== "\n") b++;
      const sentence = src.slice(a, b).replace(/^\s+/, ""); const start = b - sentence.length;
      found.push({ word: w, start, end: b, sentence, before: src.slice(Math.max(0, start - 160), start).replace(/\s+/g, " ").trim() });
      break; // mỗi từ lỗi xử lý lần xuất hiện đầu tiên; các lần sau sẽ được quét lại ở vòng kế
    }
  }
  found.sort((x, y) => x.start - y.start);
  const out = []; let lastEnd = -1;
  for (const f of found) { if (f.start < lastEnd) { out[out.length - 1].extra = (out[out.length - 1].extra || []).concat(f.word); continue; } out.push(f); lastEnd = f.end; }
  return out;
}

// V12.20: câu sửa của AI chỉ được nhận nếu bỏ từ lỗi, độ dài gần câu gốc, và giữ phần lớn các từ còn lại.
function acceptWordFix(orig, fixed, badWords) {
  const f = String(fixed || "").trim(), o = String(orig || "").trim();
  if (!f || f.length < 8) return false;
  for (const w of badWords || []) if (f.includes(w)) return false;
  if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0400-\u04FF]/.test(f)) return false;
  const ow = _normWords(o), fw = _normWords(f);
  if (Math.abs(ow.length - fw.length) > 6 || f.length > o.length * 1.5 + 20) return false;
  const bad = new Set((badWords || []).map(w => _normWords(w)[0]));
  const keep = ow.filter(w => !bad.has(w)); if (!keep.length) return true;
  const have = new Set(fw); let hit = 0; keep.forEach(w => { if (have.has(w)) hit++; });
  return hit / keep.length >= 0.7;
}

// V12.20: câu cuối đã kết thúc đúng cách chưa (. ! ? … có thể kèm ngoặc/nháy đóng).
function endsCleanly(text) {
  const t = String(text || "").replace(/[\s*_]+$/, "");
  if (!t) return true;
  return /[.!?…][”"’')\]）»]*$/.test(t) || /[—–]$/.test(t);
}
// V12.20: lùi về câu hoàn chỉnh gần nhất. Giữ lại ít nhất minRatio độ dài; nếu không có chỗ cắt hợp lý thì trả nguyên.
function trimToLastSentence(text, minRatio) {
  const t = String(text || "").replace(/\s+$/, "");
  if (endsCleanly(t)) return { text: t, cut: false };
  const re = /[.!?…][”"’')\]）»]*(?=\s|$)/g; let m, last = -1;
  while ((m = re.exec(t))) last = m.index + m[0].length;
  if (last < 0 || last < t.length * (minRatio || 0.6)) return { text: t, cut: false };
  return { text: t.slice(0, last).replace(/\s+$/, ""), cut: true };
}
// V12.20: lấy "cú chốt / kết chương" mà người dùng ghi trong gợi ý/mệnh lệnh (để nhắc AI dừng đúng chỗ và để khép chương khi bị cụt).
function extractClosingBeat(text) {
  const src = String(text || ""); if (!src.trim()) return "";
  const re = /(cú chốt|câu chốt|chốt chương|chốt cuối|kết thúc chương|kết chương|kết bằng|khép chương|cliffhanger)/i;
  const lines = src.split(/\n+/).map(x => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i].slice(0, 500);
  const sents = src.split(/(?<=[.!?…])\s+/);
  for (let i = sents.length - 1; i >= 0; i--) if (re.test(sents[i])) return sents.slice(i).join(" ").slice(0, 500);
  return "";
}

// ===== V12.17: Quality Gate — phần THUẦN (không gọi AI, không đụng DOM/state toàn cục) =====
// Client và worker cùng dùng các hàm này; phần gọi AI / dựng prompt vẫn nằm riêng ở từng nơi.
const GATE_MAX_ATTEMPTS = 3;          // tối đa số lần chấm (và sửa) cho một chương
const GATE_MAX_VERSIONS = 3;          // số bản gốc giữ lại trong chapter.versions
const GATE_MIN_REWRITE_RATIO = 0.6;   // bản sửa ngắn hơn 60% bản gốc bị từ chối

function gateItemText(x) { return typeof x === "string" ? x : ((x && (x.description || x.problem)) || JSON.stringify(x)); }

function gateMaxAttempts(v) { return Math.max(1, Math.min(GATE_MAX_ATTEMPTS, Number(v) || GATE_MAX_ATTEMPTS)); }

// Chuẩn hoá kết quả Auditor → review có verdict cuối cùng. Trả null nếu obj không phải object JSON.
// opts: { maxMainEvents, maxNamedCharacters, passScore, softFailScore, extraHard: string[], now }
function evaluateReview(obj, opts) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  opts = opts || {};
  const maxEv = Number(opts.maxMainEvents) || 3, maxCh = Number(opts.maxNamedCharacters) || 4;
  const passScore = Number(opts.passScore) || 90, softScore = Number(opts.softFailScore) || 75;
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const hard = arr(obj.hardFailures, 20);
  (opts.extraHard || []).forEach(m => hard.push(m));
  if (Number(obj.mainEventCount) > maxEv) hard.push("Vượt ngân sách sự kiện: " + obj.mainEventCount + " > " + maxEv);
  if (Number(obj.namedCharacterCount) > maxCh) hard.push("Vượt số nhân vật có tên: " + obj.namedCharacterCount + " > " + maxCh);
  if (obj.unauthorizedImportantCharacter) hard.push("Có nhân vật mới quan trọng không được outline/brief cho phép.");
  if (obj.knowledgeViolation) hard.push("Vi phạm Knowledge Ledger / nhân vật biết thông tin chưa thể biết.");
  if (obj.retcon) hard.push("Có dấu hiệu retcon canon đã xác nhận.");
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const verdict = hard.length ? "HARD_FAIL" : (score >= passScore ? "PASS" : (score >= softScore ? "SOFT_FAIL" : "HARD_FAIL"));
  return Object.assign({}, obj, {
    score, verdict, hardFailures: hard,
    dimensions: obj.dimensions && typeof obj.dimensions === "object" ? obj.dimensions : {},
    warnings: arr(obj.warnings, 20).concat(opts.extraWarnings || []), suggestions: arr(obj.suggestions, 20), rewriteInstructions: arr(obj.rewriteInstructions, 12),
    reviewedAt: opts.now || Date.now()
  });
}

// Hướng sửa gửi cho Writer: ưu tiên rewriteInstructions, nếu trống thì dùng hardFailures.
function rewriteInstructionsText(review) {
  review = review || {};
  const ins = (review.rewriteInstructions || []).join("\n");
  return ins || (review.hardFailures || []).map(gateItemText).join("\n");
}

// Bản sửa có được phép thay bản thảo không? (không rỗng, không ngắn bất thường)
function checkRewriteAcceptable(oldWc, newText, newWc) {
  if (!String(newText || "").trim() || newWc < Math.max(20, Math.floor(oldWc * GATE_MIN_REWRITE_RATIO)))
    return { ok: false, reason: "Bản sửa quá ngắn/rỗng (" + newWc + " từ so với " + oldWc + ")" };
  return { ok: true };
}

// Lưu bản gốc vào chapter.versions (mới nhất đứng đầu, giữ tối đa GATE_MAX_VERSIONS).
function backupBeforeRewrite(chapter, note) {
  if (!Array.isArray(chapter.versions)) chapter.versions = [];
  const oldText = String(chapter.text || "");
  chapter.versions.unshift({ timestamp: Date.now(), text: oldText, wordCount: countWords(oldText), modelUsed: chapter.modelUsed || null, isNsfw: !!chapter.isNsfw, polished: !!chapter.polished, note: note || "Trước khi Quality Gate sửa" });
  chapter.versions = chapter.versions.slice(0, GATE_MAX_VERSIONS);
}

// Mỗi lượt thay cảnh báo do AI cũ bằng cảnh báo mới (giữ cảnh báo khác nguồn), không cộng dồn.
function mergeAiContinuityWarnings(existing, incoming, cap) {
  const keep = (Array.isArray(existing) ? existing : []).filter(w => !(w && w.source === "ai"));
  const fresh = (Array.isArray(incoming) ? incoming : []).map(w => Object.assign({}, w, { source: "ai" }));
  return keep.concat(fresh).slice(-(cap || 20));
}

// ===== V12.17 (phần 2): Story Control, dựng prompt Gate, vòng lặp Gate, đánh dấu Sync =====

// --- Story Control: một nguồn duy nhất cho chuẩn hoá + prompt (trước đây client và worker viết khác nhau) ---
function normalizeStoryControl(st) {
  const sc = (st && st.storyControl && typeof st.storyControl === "object") ? st.storyControl : {};
  return {
    schemaVersion: Number(sc.schemaVersion) || 1,
    maxMainEvents: Math.max(1, Math.min(3, Number(sc.maxMainEvents) || 3)),
    maxNamedCharacters: Math.max(1, Math.min(6, Number(sc.maxNamedCharacters) || 4)),
    maxNewThreads: Math.max(0, Math.min(5, Number(sc.maxNewThreads) || 3)),
    noRetcon: sc.noRetcon !== false,
    lockedFields: Array.isArray(sc.lockedFields) ? sc.lockedFields : ["identity","age","background","canon","relationships","cultivation","abilities","importantItems","secrets","promises","worldRules"],
    agencyRequired: sc.agencyRequired !== false
  };
}
function storyControlPrompt(st) {
  const sc = normalizeStoryControl(st);
  return [
    "STORY CONTROL LAYER — BẮT BUỘC:",
    `- Ngân sách sự kiện: tối đa ${sc.maxMainEvents} sự kiện chính; không thêm biến cố lớn thứ ${sc.maxMainEvents + 1}.`,
    `- Nhân vật có tên xuất hiện trực tiếp: tối đa ${sc.maxNamedCharacters}; ưu tiên nhân vật đã tồn tại.`,
    `- Thread mới: tối đa ${sc.maxNewThreads}; không mở tuyến mới chỉ để kéo dài chương.`,
    "- Continuity: nguyên nhân → hành động → phản ứng → hậu quả phải nhất quán với trạng thái hiện tại.",
    sc.noRetcon ? "- NO RETCON: không tự sửa lịch sử, canon hoặc ký ức đã xác nhận. Nếu phát hiện mâu thuẫn, giữ nguyên dữ liệu cũ và đánh dấu xung đột để xử lý sau." : "",
    `- STATE LOCK: không tự ý thay đổi các trường canon/quan trọng (${sc.lockedFields.join(", ")}). Muốn thay đổi phải có sự kiện trong truyện làm bằng chứng và cập nhật trạng thái sau chương.`,
    sc.agencyRequired ? "- CHARACTER AGENCY: nhân vật quan trọng phải có mục tiêu, động cơ, phản ứng và lựa chọn riêng; không biến nhân vật thành công cụ của plot." : "",
    "- Không tự tạo nhân vật quan trọng mới nếu nhân vật hiện có có thể đảm nhiệm vai trò đó.",
    "- Không tạo năng lực, quy tắc thế giới hoặc vật phẩm quan trọng mới chỉ để giải quyết vấn đề tức thời.",
    "- Chapter Focus chỉ kiểm soát phạm vi chủ đề trưởng thành; không được dùng nó để mở rộng cốt truyện ngoài brief.",
    "- Nếu Directive/Story Bible/Current Status xung đột, không âm thầm sửa canon; ưu tiên dữ liệu canon và ghi nhận xung đột khi cần.",
    "- Mục tiêu là chiều sâu và tính liên tục, không phải nhồi thêm sự kiện."
  ].filter(Boolean).join("\n");
}

// --- Kiểm tra cứng xác định (không gọi AI). Hai ngân sách sự kiện/nhân vật do Auditor đếm, evaluateReview áp ngưỡng. ---
function gateHardChecks(chapter) {
  const text = String((chapter && chapter.text) || "");
  const warns = (chapter && chapter.continuityWarnings) || [];
  return [
    { id: "language", ok: !detectNonVietnamese(text), message: "Ngôn ngữ: tiếng Việt" },
    { id: "text_nonempty", ok: countWords(text) > 100, message: "Bản thảo có đủ nội dung" },
    { id: "duplicate", ok: !warns.some(x => x && (x.severity === "high" || x.severity === "critical")), message: "Không có lỗi continuity mức cao đã phát hiện" }
  ];
}
// Tên nhân vật đã biết (hồ sơ NV chính + danh sách NV) — dùng để đếm tự động bằng chứng cho Auditor.
function gateKnownNames(st) {
  const out = [], seen = new Set();
  const add = n => { n = String(n || "").trim(); if (n.length >= 2 && !seen.has(n)) { seen.add(n); out.push(n); } };
  add(st && st.mainCharProfile && st.mainCharProfile.name);
  ((st && st.characters) || []).forEach(c => add(c && c.name));
  return out;
}
// Những tên đã biết thật sự xuất hiện trong văn bản (khớp nguyên từ, phân biệt hoa/thường để tránh nhầm từ thường như "lan", "hoa").
function knownNameMentions(text, names) {
  const t = String(text || ""), found = [];
  (names || []).forEach(n => {
    const esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^\\p{L}\\p{N}])" + esc + "(?![\\p{L}\\p{N}])", "u").test(t)) found.push(n);
  });
  return found;
}

// --- Prompt Auditor: phần khung/quy tắc/schema dùng chung; ngữ cảnh do client/worker tự truyền vào ---
const GATE_REVIEW_SCHEMA = '{"score":0,"verdict":"PASS|SOFT_FAIL|HARD_FAIL","dimensions":{"continuity":0,"characterConsistency":0,"canonConsistency":0,"plotDiscipline":0,"worldRules":0,"outlineCompliance":0,"style":0,"pacing":0,"knowledgeConsistency":0},"mainEventCount":0,"namedCharacterCount":0,"unauthorizedImportantCharacter":false,"knowledgeViolation":false,"retcon":false,"outlineDeviation":false,"hardFailures":[],"warnings":[],"suggestions":[],"rewriteInstructions":[]}';
// p: { storyControl, contract, contractLabel, context, warnings, draft, hardChecks, knownNames, maxMainEvents, maxNamedCharacters }
function buildQualityReviewPrompt(p) {
  const evN = Number(p.maxMainEvents) || 3, chN = Number(p.maxNamedCharacters) || 4;
  const known = (p.knownNames || []);
  return [
    "Bạn là QUALITY AUDITOR cho tiểu thuyết dài kỳ.",
    "Mục tiêu: kiểm tra bản thảo so với Chapter Contract, Story Bible và continuity. KHÔNG viết lại chương.",
    "Trả DUY NHẤT JSON object theo schema cuối.",
    "STORY CONTROL:", p.storyControl || "",
    (p.contractLabel || "CHAPTER CONTRACT / OUTLINE") + ":", p.contract || "(không có)",
    "BỐI CẢNH/CANON TÓM LƯỢC:", String(p.context || "").slice(0, 18000),
    "CONTINUITY WARNINGS ĐÃ PHÁT HIỆN:", JSON.stringify(p.warnings || []).slice(0, 6000),
    p.prevEnding ? ("ĐOẠN KẾT CHƯƠNG TRƯỚC (để đối chiếu địa điểm/thời điểm/người có mặt ở cảnh mở đầu):\n" + String(p.prevEnding).slice(-1500)) : "",
    "BẢN THẢO CHƯƠNG:", String(p.draft || "").slice(0, 50000),
    "KIỂM TRA CỨNG ĐÃ CÓ:", JSON.stringify(p.hardChecks || []),
    known.length ? "TÊN NHÂN VẬT ĐÃ BIẾT XUẤT HIỆN TRONG VĂN BẢN (đếm tự động, chỉ để tham khảo khi đếm namedCharacterCount): " + known.join(", ") : "",
    "QUY TẮC:",
    "- mainEventCount phải là số sự kiện chính thực sự (tối đa " + evN + "), không đếm scene beat/hành động nhỏ.",
    "- namedCharacterCount chỉ đếm nhân vật có tên riêng xuất hiện trực tiếp; tối đa " + chN + ".",
    "- unauthorizedImportantCharacter=true nếu xuất hiện nhân vật mới quan trọng mà outline/brief không cho phép.",
    "- knowledgeViolation=true nếu nhân vật biết điều họ chưa thể biết.",
    "- retcon=true nếu mâu thuẫn canon đã xác nhận.",
    p.prevEnding ? "- ĐỊA ĐIỂM MỞ CHƯƠNG: nếu cảnh mở đầu của bản thảo KHÁC địa điểm/thời điểm/người có mặt so với ĐOẠN KẾT CHƯƠNG TRƯỚC mà không có đoạn chuyển cảnh hợp lý (ví dụ chương trước kết ở biệt thự của A nhưng chương này mở ở phòng trọ của B), phải ghi vào hardFailures (nêu rõ kết ở đâu, mở ở đâu) và đặt continuity thấp." : "",
    "- outlineDeviation=true nếu bỏ mốc bắt buộc hoặc mở tuyến lớn ngoài contract.",
    "- hardFailures phải chứa mọi lỗi chặn Sync. Nếu có hard failure thì verdict phải HARD_FAIL dù score cao.",
    "SCHEMA: " + GATE_REVIEW_SCHEMA
  ].filter(x => x !== "").join("\n\n");
}
// p: { chapterNumber, storyControl, contract, contractLabel, context, review, draft }
function buildRewritePrompt(p) {
  return [
    "SỬA LẠI BẢN THẢO CHƯƠNG " + p.chapterNumber + " THEO QUALITY REVIEW.",
    "Chỉ sửa đúng các lỗi được nêu; giữ nguyên các sự kiện hợp lệ, nhân vật hợp lệ, POV, xưng hô và giọng văn.",
    "TUYỆT ĐỐI không thêm sự kiện chính mới, không tạo nhân vật quan trọng mới, không mở thread mới chỉ để làm bản sửa dài hơn.",
    p.storyControl || "",
    (p.contractLabel || "OUTLINE/CONTRACT") + ":\n" + (p.contract || ""),
    p.context ? "CANON CONTEXT:\n" + String(p.context).slice(0, 15000) : "",
    "QUALITY REVIEW:\n" + JSON.stringify(p.review || {}),
    "HƯỚNG SỬA ƯU TIÊN:\n" + rewriteInstructionsText(p.review),
    "BẢN THẢO HIỆN TẠI:\n" + (p.draft || ""),
    "CHỈ TRẢ VỀ VĂN XUÔI CHƯƠNG ĐÃ SỬA, KHÔNG tiêu đề, không giải thích, không markdown."
  ].filter(Boolean).join("\n\n");
}

// --- Vòng lặp Gate dùng chung. Không gọi AI trực tiếp: client/worker truyền các hàm vào qua `deps`. ---
// deps: { review(attempt)→{ok,review|reason}, rewrite(review,attempt)→{ok,stopped,reason}, selfCheck?(attempt), onStatus?(msg), onChange?(), shouldStop?() }
// opts: { enabled, allowRewrite, maxAttempts }
function bypassReview() {
  return { status: "bypassed", score: null, verdict: "BYPASS", dimensions: {}, hardFailures: [], warnings: ["Quality Gate đang tắt"], suggestions: [], rewriteInstructions: [], attempt: 0, reviewedAt: Date.now() };
}
async function runGateLoop(chapter, deps, opts) {
  opts = opts || {}; deps = deps || {};
  const notify = () => { if (deps.onChange) deps.onChange(); };
  const stopped = () => !!(deps.shouldStop && deps.shouldStop());
  if (opts.enabled === false) { chapter.status = "APPROVED"; chapter.review = bypassReview(); notify(); return { approved: true }; }
  const maxAttempts = opts.allowRewrite === false ? 1 : gateMaxAttempts(opts.maxAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (stopped()) return { approved: false, stopped: true };
    if (deps.selfCheck) { chapter.status = "SELF_CHECKING"; notify(); await deps.selfCheck(attempt); }
    chapter.status = "REVIEWING"; chapter.review = Object.assign({}, chapter.review || {}, { attempt }); notify();
    const rr = await deps.review(attempt);
    if (!rr || !rr.ok) {
      const reason = (rr && rr.reason) || "review_error";
      chapter.review = Object.assign({}, chapter.review, { status: "error", verdict: "REVIEW_ERROR", warnings: ["Không đọc được kết quả Quality Review: " + reason] });
      chapter.status = "REVISION_REQUIRED"; notify();
      return { approved: false, error: reason };
    }
    chapter.review = Object.assign({}, chapter.review, rr.review, { status: "completed", attempt, reviewedAt: Date.now() });
    if (rr.review.verdict === "PASS") { chapter.status = "APPROVED"; notify(); return { approved: true, review: rr.review }; }
    chapter.status = "REVISION_REQUIRED"; notify();
    if (attempt >= maxAttempts) break;
    if (deps.onStatus) deps.onStatus("Quality Gate: " + rr.review.verdict + " — đang sửa lần " + (attempt + 1) + "/" + maxAttempts + "...");
    const rw = await deps.rewrite(rr.review, attempt);
    if (rw && rw.stopped) return { approved: false, stopped: true };
    if (!rw || !rw.ok) {
      chapter.review.warnings = (chapter.review.warnings || []).concat(["Bản sửa bị từ chối: " + ((rw && rw.reason) || "không rõ") + " — giữ nguyên bản thảo."]);
      notify(); break;
    }
  }
  chapter.status = "REVISION_REQUIRED";
  return { approved: false, review: chapter.review };
}

// --- Canon version / đánh dấu Sync / kết quả job nền ---
function nextCanonVersion(st) {
  const ex = Math.max(0, ...(((st && st.chapters) || []).map(c => Number(c && c.sync && c.sync.canonVersion) || 0)));
  return Math.max(ex, Number(st && st.canonVersion) || 0) + 1;
}
function applyCanonSync(st, chapter, now) {
  const cv = nextCanonVersion(st);
  st.canonVersion = cv; chapter.canonVersion = cv;
  const warn = !!(chapter.autoUpdateIssues && chapter.autoUpdateIssues.length);
  chapter.sync = Object.assign({ changes: [] }, chapter.sync || {}, { status: warn ? "SYNCED_WITH_WARNINGS" : "SYNCED", canonVersion: cv, syncedAt: now || Date.now() });
  chapter.status = chapter.sync.status;
  return cv;
}
function mergeCanonVersion(local, incoming) { return Math.max(Number(local) || 0, Number(incoming) || 0); }
// Kết quả job nền có phải "trượt Quality Gate" (chương nháp, chưa Sync) không?
function isGateFailedResult(d) {
  if (!d) return false;
  if (d.qualityGateFailed) return true;
  if (d.resultChapter && d.resultChapter.status === "REVISION_REQUIRED") return true;
  const chs = d.storyState && d.storyState.chapters;
  const last = Array.isArray(chs) && chs.length ? chs[chs.length - 1] : null;
  return !!(last && last.status === "REVISION_REQUIRED");
}

/* ===== V12.18 — NHÂN VẬT TRÙNG: nhận diện nhãn chung / tên ngắn, gộp an toàn (dùng chung client + worker) ===== */

const _GENERIC_MC_LABELS = ["nhan vat chinh", "nvc", "main character", "the main character", "protagonist", "the protagonist", "mc", "nhan vat chinh cua truyen"];
const _TIER_ORDER = ["background", "minor", "supporting", "important", "major"];
const _DUP_STOP = new Set(["ba", "ong", "co", "chu", "anh", "chi", "em", "me", "cha", "bo", "thay", "nguoi", "ke", "gia", "cau", "mo", "di", "duong"]);

/* "nhân vật chính", "main character", "protagonist", "nhân vật chính (tên chưa rõ)"... — nhãn chung, KHÔNG phải tên riêng. */
function isGenericMainLabel(name, mcName) {
  const n = normalizeName(name).replace(/[()\[\]{}"'“”‘’.,:;]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return false;
  if (_GENERIC_MC_LABELS.includes(n)) return true;
  const m = n.match(/^(nhan vat chinh|main character|protagonist)\s+(.+)$/);
  if (!m) return false;
  if (/^(ten chua ro|chua ro ten|chua dat ten|vo danh)$/.test(m[2])) return true;
  const mc = normalizeName(mcName || "");
  return !!mc && (m[2].includes(mc) || mc.includes(m[2]));
}

/* Tên (do AI trích xuất) trỏ tới đâu: hồ sơ Nhân Vật Chính / một nhân vật có sẵn (kể cả theo bí danh) / chưa có. */
function resolveCharacterTarget(state, name) {
  const n = normalizeName(name);
  if (!n) return { kind: "none" };
  const mc = state && state.mainCharProfile, mcName = (mc && mc.name) || "";
  if (mcName && normalizeName(mcName) === n) return { kind: "main" };
  if (mc && Array.isArray(mc.aliases) && mc.aliases.some(a => normalizeName(a) === n)) return { kind: "main", via: "alias" };
  if (mcName && isGenericMainLabel(name, mcName)) return { kind: "main", via: "generic" };
  const list = (state && state.characters) || [];
  let c = list.find(x => normalizeName(x.name) === n);
  if (c) return { kind: "character", character: c };
  c = list.find(x => Array.isArray(x.aliases) && x.aliases.some(a => normalizeName(a) === n));
  if (c) return { kind: "character", character: c, via: "alias" };
  return { kind: "new" };
}

/* AI báo thêm về nhân vật chính: chỉ cập nhật các trường trạng thái (không đụng hồ sơ do người dùng nhập). */
function applyMainCharUpdate(profile, u) {
  if (!profile || !u) return false;
  let changed = false;
  ["currentLocation", "physicalState", "mentalState", "secret"].forEach(k => { if (u[k] && String(u[k]).trim()) { profile[k] = u[k]; changed = true; } });
  return changed;
}

function mergeTextSegments(a, b, max) {
  max = max || 2500;
  const x = String(a || "").trim(), y = String(b || "").trim();
  if (!y) return x;
  if (!x) return y.slice(0, max);
  const nx = normalizeName(x), ny = normalizeName(y);
  if (nx === ny || nx.includes(ny)) return x;
  if (ny.includes(nx)) return y.slice(0, max);
  const fresh = y.split(/;\s*/).filter(seg => seg.trim() && !nx.includes(normalizeName(seg)));
  if (!fresh.length) return x;
  const parts = x.split(/;\s*/).concat(fresh);
  while (parts.length > 1 && parts.join("; ").length > max) parts.shift();
  return parts.join("; ").slice(-max);
}

/* Gộp hồ sơ `source` vào `target` (target là bản giữ lại). Không mất thông tin: trường trống thì điền, trường chữ thì nối ý mới. */
function mergeCharacterRecords(target, source) {
  const SKIP = ["id", "name", "relationships", "history", "aliases", "coreIdentity", "tier", "firstAppearance", "lastAppearance", "dead", "deathChapter", "locked", "coreLocked"];
  const TEXT = ["appearance", "personality", "goals", "secret", "weakness", "fear", "knowledge", "independentPlot", "speech", "strength", "role", "relevanceToMC"];
  Object.keys(source).forEach(k => {
    if (SKIP.includes(k)) return;
    const v = source[k];
    if (v == null || v === "") return;
    if (TEXT.includes(k)) target[k] = mergeTextSegments(target[k], v, (k === "role" || k === "relevanceToMC") ? 400 : 2500);
    else if (target[k] == null || target[k] === "") target[k] = v;
  });
  if (_TIER_ORDER.indexOf(source.tier) > _TIER_ORDER.indexOf(target.tier)) target.tier = source.tier;
  const nums = (p, q, pick) => { const a = target[p], b = source[q]; return a == null ? b : (b == null ? a : pick(a, b)); };
  target.firstAppearance = nums("firstAppearance", "firstAppearance", Math.min);
  target.lastAppearance = nums("lastAppearance", "lastAppearance", Math.max);
  if (source.dead && !target.dead) { target.dead = true; target.deathChapter = source.deathChapter != null ? source.deathChapter : target.deathChapter; }
  const seenRel = new Set(), rels = [];
  (target.relationships || []).concat(source.relationships || []).forEach(r => {
    const k = normalizeName(r && r.withName);
    if (!k || seenRel.has(k) || k === normalizeName(target.name)) return;
    seenRel.add(k); rels.push(r);
  });
  target.relationships = rels;
  target.history = (Array.isArray(target.history) ? target.history : []).concat(Array.isArray(source.history) ? source.history : []).slice(-100);
  const aliases = [];
  (target.aliases || []).concat(source.aliases || [], [source.name]).forEach(a => {
    const k = normalizeName(a);
    if (k && k !== normalizeName(target.name) && !aliases.some(x => normalizeName(x) === k)) aliases.push(String(a).trim());
  });
  target.aliases = aliases;
  return target;
}

/* Gợi ý các mục có thể trùng (CHỈ gợi ý — người dùng quyết định). state.ignoredDupPairs: các cặp "Giữ riêng". */
function findDuplicateCharacterGroups(state) {
  const out = [], seen = new Set();
  const chars = (state && state.characters) || [], mc = state && state.mainCharProfile, mcName = (mc && mc.name) || "";
  const mcN = normalizeName(mcName), ignored = new Set((state && state.ignoredDupPairs) || []);
  const push = (src, targetId, targetName, type, reason, confidence) => {
    const key = src.id + "|" + (targetId || "");
    if (seen.has(key) || ignored.has(key)) return;
    seen.add(key);
    out.push({ key, sourceId: src.id, sourceName: src.name, targetId: targetId || null, targetName: targetName || "", type, reason, confidence });
  };
  const cands = chars.filter(c => /protagonist|nhan vat chinh|nam chinh|nu chinh/.test(normalizeName(c.role)) && !isGenericMainLabel(c.name, mcName));
  const flagged = new Set();
  chars.forEach(c => {
    const n = normalizeName(c.name);
    if (!n) return;
    if (mcN && n === mcN) { push(c, "MAIN", mcName, "main_name", "Trùng tên với hồ sơ Nhân Vật Chính", "high"); flagged.add(c.id); return; }
    if (!isGenericMainLabel(c.name, mcName)) return;
    flagged.add(c.id);
    if (mcN) push(c, "MAIN", mcName, "main_generic", "Nhãn chung “nhân vật chính” — chính là " + mcName, "high");
    else if (cands.length === 1) push(c, cands[0].id, cands[0].name, "main_generic", "Nhãn chung “nhân vật chính” — có vẻ là " + cands[0].name, "medium");
    else push(c, null, "", "generic_unresolved", "Nhãn chung “nhân vật chính” nhưng chưa khai báo Nhân Vật Chính", "medium");
  });
  const toks = c => normalizeName(c.name).split(" ").filter(Boolean);
  chars.forEach(a => {
    if (flagged.has(a.id)) return;
    const ta = toks(a);
    if (!ta.length || (ta.length === 1 && (_DUP_STOP.has(ta[0]) || ta[0].length < 2))) return;
    if (mcN) {
      const tm = mcN.split(" ").filter(Boolean);
      if (ta.length < tm.length && ta.every(t => tm.includes(t))) { push(a, "MAIN", mcName, "alias", "Tên ngắn trùng một phần với nhân vật chính " + mcName, "medium"); return; }
    }
    const longer = chars.filter(b => b !== a && !flagged.has(b.id) && (() => { const tb = toks(b); return ta.length < tb.length && ta.every(t => tb.includes(t)); })());
    if (longer.length === 1) push(a, longer[0].id, longer[0].name, "alias", "“" + a.name + "” trùng một phần với “" + longer[0].name + "” — có thể cùng một người", "medium");
  });
  return out;
}

/* Gộp nhân vật `sourceId` vào `targetId` ("MAIN" = hồ sơ Nhân Vật Chính: chỉ điền ô còn trống, không ghi đè nội dung người dùng đã nhập). */
function mergeCharacterIntoState(state, sourceId, targetId) {
  const chars = state.characters || [], src = chars.find(c => c.id === sourceId);
  if (!src) return { ok: false, reason: "không thấy mục nguồn" };
  let targetName;
  if (targetId === "MAIN") {
    const p = state.mainCharProfile;
    if (!p || !String(p.name || "").trim()) return { ok: false, reason: "chưa khai báo Nhân Vật Chính" };
    Object.keys(src).forEach(k => {
      const pk = k === "strength" ? "skills" : k, v = src[k];
      if (typeof v !== "string" || !v.trim() || !(pk in p) || pk === "name") return;
      if (!String(p[pk] || "").trim()) p[pk] = v;
    });
    const al = Array.isArray(p.aliases) ? p.aliases.slice() : [];
    if (normalizeName(src.name) !== normalizeName(p.name) && !al.some(x => normalizeName(x) === normalizeName(src.name))) al.push(String(src.name).trim());
    p.aliases = al; targetName = p.name;
  } else {
    const tgt = chars.find(c => c.id === targetId && c.id !== sourceId);
    if (!tgt) return { ok: false, reason: "không thấy mục đích" };
    mergeCharacterRecords(tgt, src); targetName = tgt.name;
  }
  state.characters = chars.filter(c => c.id !== sourceId);
  const sn = normalizeName(src.name);
  state.characters.forEach(c => {
    if (!Array.isArray(c.relationships)) return;
    c.relationships.forEach(r => { if (r && normalizeName(r.withName) === sn) r.withName = targetName; });
    const seenR = new Set();
    c.relationships = c.relationships.filter(r => { const k = normalizeName(r && r.withName); if (!k || k === normalizeName(c.name) || seenR.has(k)) return false; seenR.add(k); return true; });
  });
  return { ok: true, from: src.name, into: targetName };
}
// <<SHARED-CORE:END>>
// V12.3: hard cap để mục tiêu 5.000 từ không biến thành 8.000+ từ.

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
  "Bạn là tiểu thuyết gia Việt Nam chuyên viết tiểu thuyết dài kỳ.",
  "Khi viết văn xuôi, ưu tiên tuyệt đối tiếng Việt tự nhiên, mạch câu mượt và nhất quán; không viết theo kiểu dịch máy.",
  "Giữ continuity: nhân vật, xưng hô, POV, thì kể, thời gian, địa điểm, kiến thức, quan hệ, vật phẩm, năng lực và nguyên nhân-hệ quả phải nhất quán.",
  "Ưu tiên cảnh cụ thể, hành động, giác quan, đối thoại tự nhiên và nội tâm thể hiện qua hành vi; tránh sáo ngữ, giải thích dài dòng, lặp cấu trúc câu và lặp tính từ.",
  "Không cố thay từ chỉ để tránh lặp khi việc lặp là tự nhiên. Tính tự nhiên của tiếng Việt quan trọng hơn việc né một từ.",
  "Không tự tạo biến cố/lore/nhân vật chỉ để kéo dài số chữ.",
  "CHARACTER DATABASE là nguồn sự thật: không tự đổi thân phận, vai trò, tính cách, quan hệ hoặc lịch sử đã được xác nhận; nếu chưa biết thì để mở thay vì bịa.",
  "Mệnh lệnh/gợi ý trực tiếp của người dùng cho chương hiện tại phải được triển khai đầy đủ; không thay thế bằng một tuyến truyện khác chỉ vì AI thấy tuyến đó thú vị hơn.",
  "Trước khi viết, phải lập kế hoạch nội bộ theo Story Control Layer: khóa canon, giới hạn 1–3 sự kiện, kiểm tra nhân vật và hậu quả; không xuất kế hoạch nội bộ ra văn bản.",

  "Khi viết tiếp, giữ đúng giọng, nhịp câu, POV, thì kể và xưng hô của phần trước; không đổi phong cách giữa chừng.",
  "BỐ CỤC BẮT BUỘC: chia thành nhiều đoạn ngắn 2–4 câu, các đoạn cách nhau một dòng trống; mỗi lượt thoại nằm trên một đoạn riêng (mở bằng dấu “ hoặc —); đổi cảnh/người nói thì xuống đoạn mới; không viết khối văn liền dài.",
  "Khi viết văn xuôi, chỉ trả tác phẩm, không nói về prompt, AI hay quy trình."
].join(" ");

const DESCRIPTION_PROMPTS = {
  light: "Miêu tả nhẹ, tập trung diễn biến.",
  balanced: "Miêu tả cân bằng, có giác quan và chi tiết vừa đủ.",
  rich: "Miêu tả phong phú, chú ý ngoại hình và không khí cảnh.",
  deep: "Miêu tả sâu, giàu giác quan nhưng không lặp."
};
// Đồng bộ nguyên văn với EXPLICIT_PROMPTS trong index.html (bản viết trực tiếp) để 2 luồng ra văn phong giống nhau.
// Đồng bộ nguyên khối EROTIC_STYLE_PROMPT từ index.html.
const EROTIC_STYLE_PROMPT = [
  "PHONG CÁCH REDQUILL / 18+ CỰC NẶNG (BẮT BUỘC khi cảnh nóng — đủ lớp, không bỏ):",
  "",
  "HAI LỚP (không trộn trong CÙNG MỘT CÂU):",
  "- Lớp văn/tâm lý: không khí, quyền lực, nội tâm, xã hội — có thể văn hơn.",
  "- Lớp erotic: khi đang sex/sỉ nhục/lên đỉnh → từ THÔ TỤC đường phố chiếm ưu thế (cặc, lồn, địt, nứng, nước lồn, tinh trùng, đĩ, nô lệ…). Không ẩn dụ hoa mỹ thay thế.",
  "",
  "4 LỚP MỖI ĐOẠN NÓNG:",
  "1) CƠ THỂ: kích thước/màu/hình thái theo hồ sơ NV (cặc, lồn, ngực, mông, mép, hạt le, dịch).",
  "2) CẢM GIÁC: căng, ướt, đau rát, no đầy, tê, run, nóng — trong da thịt, không chỉ nhìn từ ngoài.",
  "3) NỘI TÂM đa lớp: xấu hổ ↔ dục, kháng cự ↔ cơ thể phản bội, tự nhục ↔ nghiện (nữ); tính toán/chiếm hữu (nam nếu có).",
  "4) ÂM THANH + NHỊP: da đập, dịch, giường, thở, rên (ư, ahh, hah…), thoại van xin — đồng bộ nhịp đút.",
  "",
  "THOẠI (khi nhân vật đã quy phục / cảnh huấn luyện):",
  "- Tăng mật độ thoại: van xin thô tục, tự sỉ nhục, mô tả lồn/cặc đang nứng, cầu xin được địt/xuất.",
  "- Nam chính (nếu thống trị): thoại ngắn, lạnh, ra lệnh; nữ đáp dài hơn, thô hơn khi cao trào.",
  "- Thoại xen hành động + biểu cảm (mắt, môi, nước dãi, run).",
  "",
  "NHỊP CẢNH 3 PHẦN (BẮT BUỘC khi chương có cảnh nóng — KHÔNG chỉ dồn vào cao trào):",
  "- DẪN VÀO (~25% cảnh): dựng không khí và căng thẳng trước khi chạm nhau — ánh mắt, khoảng cách, lời nói/mệnh lệnh, nội tâm, từng bước cởi bỏ/áp sát, phản ứng cơ thể đầu tiên. Không nhảy thẳng vào quan hệ.",
  "- DIỄN BIẾN + CAO TRÀO (~50%): như các quy tắc trên.",
  "- SAU CẢNH (~25%): không cắt ngang ngay sau cao trào — hơi thở, cơ thể kiệt sức/dư chấn, dịch và dấu vết, cảm xúc sau đó (xấu hổ, thỏa mãn, hối hận, chiếm hữu), thoại sau cảnh, và hậu quả với quan hệ giữa hai người; rồi mới chuyển cảnh hoặc kết chương.",
  "- Mỗi phần phải có đoạn văn đầy đủ riêng (nhiều đoạn, không gói trong 1-2 câu).",
  "- NGOẠI LỆ: nếu gợi ý/mệnh lệnh của người dùng chỉ nêu 1–2 trong 3 phần (ví dụ chỉ dẫn vào, hoặc chỉ tới trước cao trào), CHỈ viết đúng các phần đó và dừng ở mốc kết chương người dùng đã ghi; tuyệt đối không tự thêm phần còn lại.",
  "",
  "KỸ THUẬT:",
  "- Chậm từng nhịp; không tóm tắt cao trào trong 1-2 câu.",
  "- Nhiều bộ phận cùng lúc (tay + miệng + cặc…).",
  "- 5 giác quan khi phù hợp; mùi/dịch/nhiệt độ.",
  "- Bám hồ sơ NV — cấm bịa số đo khác.",
  "- 100% tiếng Việt có dấu. Không meta, không spoiler chương sau."
].join("\n");

// v11 — Rào chắn tuổi (đồng bộ nguyên văn với index.html).

const EXPLICIT_PROMPTS = {
  subtle: "CẢNH 18+: Nhẹ nhàng — fade-to-black sau khi hôn, gợi ý chứ không tả. Cảm xúc chiếm ưu thế.",
  sensual: "CẢNH 18+: Gợi cảm — tả cảm xúc, hơi thở, ánh mắt, da chạm da; hạn chế tả bộ phận sinh dục chi tiết. Vẫn giàu sức gợi.",
  explicit: "CẢNH 18+: Rõ ràng — mô tả cơ thể và hành động cụ thể (hôn, sờ, cởi, tư thế). Có thể dùng từ trực tiếp khi cần. Show cảm giác qua da thịt và phản ứng.",
  strong: "CẢNH 18+: MẠNH — mỗi đoạn nóng cần: (1) bộ phận + hình thái/màu/số đo hồ sơ; (2) cảm giác thể xác cụ thể; (3) một nhịp nội tâm (xấu hổ/dục/kháng cự); (4) động tác + âm thanh. Ít ẩn dụ.",
  wild: "CẢNH 18+: CỰC MẠNH. Đủ 4 lớp (cơ thể+cảm giác+nội tâm+âm thanh/thoại). Không tóm tắt, không fade-to-black. Bám hồ sơ số đo."
};

/* ===== NSFW KEYWORD DETECT — đồng bộ với index.html, thay cho danh sách 6 từ cũ (quá hẹp) ===== */

// V12.14: khớp theo TỪ nguyên vẹn (Unicode), không khớp chuỗi con — tránh "cà phê", "cây bút", "phản kháng"... bị nhận nhầm là 18+.

/* v10.2.2: worker trước đây chỉ ép NSFW khi bắt được từ khóa trong directive/hint/tiêu đề —
 * không có bước "chấm nhiệt độ" như bản viết trực tiếp (index.html detectHeatLevel()).
 * Hệ quả: nếu cảnh nóng phát sinh tự nhiên từ mạch truyện (không có từ khóa tường minh
 * trong Mệnh lệnh/Định hướng), job nền âm thầm dùng model thường thay vì model NSFW dù
 * chế độ đang để "auto". Hàm dưới đây đồng bộ với client: chấm 0-10, so với ngưỡng đã cấu hình. */

function matureFocusPrompt(state) {
  const f = normalizeChapterMatureFocus(state && state.chapterMatureFocus);
  if (f === "primary") return "TRỌNG TÂM TRƯỞNG THÀNH: PRIMARY. Chủ đề trưởng thành là một trọng tâm được người dùng chỉ định cho chương này. Chỉ triển khai trong phạm vi brief/mạch truyện đã có; không tự mở tuyến mới.";
  if (f === "secondary") return "TRỌNG TÂM TRƯỞNG THÀNH: SECONDARY. Chỉ sử dụng nội dung trưởng thành khi brief hoặc diễn biến hiện tại yêu cầu rõ. Không biến nó thành trọng tâm và không tự chèn cảnh chỉ để tăng nhiệt.";
  return "TRỌNG TÂM TRƯỞNG THÀNH: NONE. Tuyệt đối không tự chèn hoặc kéo dài nội dung trưởng thành trong chương này, kể cả khi mạch truyện trước đó có nội dung trưởng thành.";
}

async function detectHeatLevel(job, tail, hint, directive) {
  try {
    const prompt = [
      "Bạn là bộ phân loại nhiệt độ cảnh cho tiểu thuyết.",
      "Chấm mức 18+ của CẢNH SẮP VIẾT theo thang 0-10:",
      "0-2 bình thường | 3-4 cảm xúc nhẹ | 5-6 hôn/ôm | 7-8 cởi đồ/sờ | 9-10 quan hệ",
      "CHỈ TRẢ VỀ 1 SỐ DUY NHẤT. KHÔNG giải thích.",
      "",
      matureFocusPrompt(job.storyState),
      "MỆNH LỆNH: " + (directive || "(không)"),
      "ĐỊNH HƯỚNG CHO CHƯƠNG NÀY: " + (hint || "(không)"),
      "DIỄN BIẾN GẦN:",
      (tail || "(chưa có)").slice(-2000)
    ].join("\n");
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: prompt }], maxTokens: 10, temperature: 0 }, 1);
    const m = String(r.text || "").match(/\d+/);
    return m ? Math.max(0, Math.min(10, parseInt(m[0], 10))) : 0;
  } catch (_) { return 0; }
}

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
        // V12.20: siết lấy mẫu khi viết văn để giảm từ lỗi ghép (mươititude, bănnton...). top_k chỉ gửi cho OpenRouter.
        creative ? { top_p: 0.88 } : {},
        (creative && /openrouter\.ai/i.test(endpoint || DEFAULT_ENDPOINT)) ? { top_k: 40 } : {},
        // Penalty chỉ dùng khi VIẾT VĂN. Với JSON, penalty làm model né lặp key/dấu ngoặc -> JSON hỏng.
        {} ,
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
  if (timeLeft() < 90000) return { ...p, repairedByAI: false }; // không đủ giờ cho 1 lượt gọi sửa JSON nữa
  const fixed = await repairJsonWithAI(job, raw, "array", null, 8000);
  const again = parseArray(fixed);
  return { ...again, repairedByAI: again.valid, method: again.valid ? "AI-repair" : "" };
}

async function parseObjectWithRepair(job, raw, keys) {
  const p = parseObjectDetailed(raw, keys);
  if (p.obj) return { obj: p.obj, method: p.method, repairedByAI: false };
  if (timeLeft() < 90000) return { obj: null, method: "", repairedByAI: false };
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
  if (state.femaleCharacterDefinition) p.push("ĐỊNH NGHĨA CHUNG NHÂN VẬT NỮ — ÁP DỤNG CHO MỌI NHÂN VẬT NỮ:\n" + String(state.femaleCharacterDefinition).trim() + "\nAI tự xây dựng từng nhân vật nữ theo diễn biến truyện; không gán nguyên xi một nhân vật cho nhân vật khác; không tự đổi thông tin đã được truyện xác nhận.");
  if (state.currentStatus) p.push("CURRENT STATUS:\n" + state.currentStatus);
  if (state.directive) p.push("MỆNH LỆNH:\n" + state.directive);
  if (state.nextChapterHint) p.push("KẾ HOẠCH CHƯƠNG NÀY (người dùng viết — bám đúng thứ tự, không thêm tuyến khác; ý cuối là điểm kết chương; nếu mâu thuẫn MỆNH LỆNH thì MỆNH LỆNH thắng):\n" + state.nextChapterHint);
  if (state.advancedRules) p.push("QUY TẮC:\n" + state.advancedRules);
  if (state.mainCharProfile?.name) p.push("NHÂN VẬT CHÍNH (BẮT BUỘC xuất hiện, là trung tâm mọi chương, không đổi tên/nhầm sang NV khác):\n" + JSON.stringify(state.mainCharProfile));
  else if (state.mainPlot || state.worldSetting) p.push("⚠ CHƯA khai báo Nhân Vật Chính. Nếu Cốt Truyện/Bối Cảnh có nhắc tên nhân vật chính, PHẢI dùng đúng tên đó xuyên suốt, không tự đặt tên khác.");
  const chars = (state.characters || []).filter(c => !c.dead).slice(0, 18);
  if (chars.length) {
    p.push("CHARACTER DATABASE — CANON + TRẠNG THÁI:\n" + chars.map(c => {
      const core = c.coreIdentity && Object.keys(c.coreIdentity).length ? Object.entries(c.coreIdentity).filter(([,v])=>String(v||"").trim()).map(([k,v])=>k+":"+String(v)).join(" | ") : "";
      return `- ${c.name} [${c.tier || "supporting"}] | CANON:${core || "chưa xác lập"} | vai trò:${c.role || ""} | ở:${c.currentLocation || "?"} | thể:${c.physicalState || ""} | tâm:${c.mentalState || ""} | biết:${c.knowledge || ""}`;
    }).join("\n"));
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

// Dành riêng cho bước viết văn (chương mới + viết tiếp): không được ăn hết ngân sách 13.5 phút,
// phải để lại thời gian cho NV/Thế giới/Status/Memory chạy sau đó — đây là nguyên nhân gốc của
// "7/7 lô không đọc được" + "Status/Memory bỏ qua vì hết thời gian" khi chương dài phải viết-tiếp nhiều lần.
// V12.2: không để hậu xử lý cắt ngắn lượt viết. Nhánh trưởng thành cần nhiều lượt
// continuation hơn; vẫn giữ một khoảng đệm tối thiểu cho việc lưu kết quả và cập nhật state.
const NORMAL_POST_PROCESS_RESERVE_MS = 5 * 60 * 1000;
// V12.9: 90s cũ quá ngắn -> NV/Thế giới ăn gần hết, khiến Status/Memory/Scene/Gợi ý
// chương sau bị "BỎ QUA vì hết thời gian" gần như mỗi lần với chương 18+. Nâng lên 210s.
const MATURE_POST_PROCESS_RESERVE_MS = 210 * 1000;
const writeTimeLeft = (isMature = false) => timeLeft() - (isMature ? MATURE_POST_PROCESS_RESERVE_MS : NORMAL_POST_PROCESS_RESERVE_MS);

// ===== V12 Writing Engine =====

/* V12.20 — Tự sửa từ lỗi ghép: gửi các CÂU chứa từ lỗi cho model, nhận lại câu đã sửa, chỉ nhận nếu bỏ từ lỗi và giữ phần lớn từ còn lại. */
async function fixStrayWordsWithAI(job, text, allowNames, model, isNsfw) {
  const res = { text, fixed: 0, samples: [] };
  try {
    let cur = String(text || "");
    for (let round = 0; round < 2; round++) {
      if (writeTimeLeft(isNsfw) < 45000) break;
      const stray = findStrayWords(cur, allowNames, 40).filter(w => _hasVnDiacritic(w) || w[0] === w[0].toLowerCase());
      if (!stray.length) break;
      const items = locateWordSentences(cur, stray).slice(0, 30);
      if (!items.length) break;
      const lines = items.map((it, i) => `${i + 1}) Từ lỗi: "${it.word}"${it.extra ? " + " + it.extra.map(x => '"' + x + '"').join(", ") : ""}\n   Ngay trước đó: ${it.before || "(đầu đoạn)"}\n   Câu lỗi: ${it.sentence.replace(/\n+/g, " ")}`);
      const prompt = [
        "Đây là các câu trong một truyện tiếng Việt. Mỗi câu có một từ bị LỖI SINH CHỮ (model ghép nhầm âm tiết tiếng Việt với chữ tiếng Anh/ký tự lạ, ví dụ \"mươititude\", \"bănnton\").",
        "NHIỆM VỤ: viết lại ĐÚNG câu đó, CHỈ thay từ lỗi bằng từ/cụm tiếng Việt tự nhiên đúng ý câu (suy từ ngữ cảnh). Giữ nguyên mọi chữ khác, tên riêng, dấu câu, giọng văn. Không thêm ý, không bỏ ý, không giải thích.",
        "Trả về mỗi câu một dòng đúng định dạng:  số|câu đã sửa   (một dòng cho mỗi câu, giữ nguyên số thứ tự).",
        "", lines.join("\n")
      ].join("\n");
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "user", content: prompt }], maxTokens: Math.min(4000, 400 + items.length * 220), temperature: 0.2 }, 1);
      const map = new Map();
      String(r.text || "").split(/\n+/).forEach(l => { const m = l.match(/^\s*(\d+)\s*[|)\]:.]\s*(.+)$/); if (m) map.set(Number(m[1]), m[2].trim()); });
      let out = cur, any = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i], fixed = map.get(i + 1);
        if (!fixed) continue;
        const bads = [it.word].concat(it.extra || []);
        if (!acceptWordFix(it.sentence, fixed, bads)) continue;
        out = out.slice(0, it.start) + fixed + out.slice(it.end);
        any++; res.fixed++; if (res.samples.length < 3) res.samples.push(it.word);
      }
      cur = out;
      if (!any) break;
    }
    res.text = cur;
  } catch (e) { /* sửa lỗi chữ là phần phụ: lỗi thì giữ nguyên văn bản */ }
  return res;
}


/* V12.20 — Mở rộng chương ngắn TẠI CHỖ, THEO TỪNG ĐOẠN: model không viết nổi 4500 từ trong một lần (thường dừng ~3000),
   nên chia chương thành các khối ~550 từ, mỗi khối có chỉ tiêu từ riêng (gốc x hệ số) và được viết lại song song (3 khối/lượt).
   Giữ nguyên sự kiện/thứ tự/cú chốt, chỉ làm dày miêu tả - nội tâm - thoại. Khối nào không dài hơn hoặc lệch nội dung thì giữ bản gốc. */
async function expandChapterInPlace(job, text, o) {
  const cur = countWords(text);
  if (writeTimeLeft(o.isNsfw) < 120000) return { ok: false, reason: "hết thời gian job" };
  const goal = Math.min(o.maxWords - 80, o.minWords);
  const factor = Math.min(2.2, goal / Math.max(1, cur));
  if (factor < 1.05) return { ok: false, reason: "đã đủ độ dài" };
  const st = o.state || {};
  const paras = String(text).split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const nChunks = Math.max(1, Math.min(8, Math.round(cur / 550)));
  const per = cur / nChunks; const chunks = []; let bufP = [], bufW = 0;
  paras.forEach((p, i) => {
    bufP.push(p); bufW += countWords(p);
    const left = paras.length - 1 - i;
    if ((bufW >= per && chunks.length < nChunks - 1) || left === 0) { chunks.push({ text: bufP.join("\n\n"), words: bufW }); bufP = []; bufW = 0; }
  });
  const brief = (st.directive || st.nextChapterHint) ? ("KẾ HOẠCH CỦA NGƯỜI DÙNG (để đối chiếu, KHÔNG thêm ngoài kế hoạch):\n" + [st.directive, st.nextChapterHint].filter(Boolean).map(x => String(x).trim()).join("\n")) : "";
  const lastPara = (t) => { const ps = String(t).split(/\n\s*\n|\n/).map(x => x.trim()).filter(Boolean); return ps[ps.length - 1] || ""; };
  const overlap = (a, b) => { const A = new Set(_normWords(a)), B = new Set(_normWords(b)); if (!A.size || !B.size) return 1; let h = 0; A.forEach(w => { if (B.has(w)) h++; }); return h / Math.min(A.size, B.size); };
  const doChunk = async (i) => {
    const c = chunks[i], tw = Math.round(c.words * factor), isFirst = i === 0, isLast = i === chunks.length - 1;
    const prompt = [
      `MỞ RỘNG ĐOẠN ${i + 1}/${chunks.length} của một chương truyện. Đoạn gốc dưới đây có ${c.words} từ. Hãy viết lại thành khoảng ${tw} từ (BẮT BUỘC dài hơn ít nhất ${Math.round(c.words * Math.min(factor, 1.6) * 0.9)} từ; không vượt ${Math.round(tw * 1.25)} từ).`,
      "CÁCH LÀM DÀI: đào sâu từng khoảnh khắc — miêu tả không gian/ánh sáng/âm thanh/mùi/xúc giác; ngôn ngữ cơ thể, ánh mắt, nhịp thở; nội tâm và suy nghĩ của nhân vật; nhịp thoại (ngập ngừng, im lặng, phản ứng nhỏ); chi tiết vật dụng; khoảnh khắc chuyển giữa các hành động. Mỗi hành động/lời thoại gốc phải được GIỮ và khai triển, không bỏ.",
      "CẤM: thêm sự kiện/biến cố/nhân vật/manh mối mới; thêm cảnh mới; tóm tắt; lặp ý cho đủ chữ; viết sang nội dung của đoạn trước/đoạn sau.",
      isFirst ? "Đây là ĐOẠN ĐẦU chương: giữ đúng cách mở chương (địa điểm, thời điểm, người có mặt)." : "",
      isLast ? ("Đây là ĐOẠN CUỐI chương: giữ nguyên câu/cảnh cuối làm điểm kết, KHÔNG viết thêm gì sau đó." + (o.closingBeat ? " Cú chốt: " + o.closingBeat : "") + " Câu cuối phải hoàn chỉnh, có dấu kết thúc.") : "",
      "Giữ nguyên giọng văn, ngôi kể, thì, xưng hô. 100% tiếng Việt có dấu. Chỉ trả văn xuôi của đoạn đã mở rộng, không tiêu đề/ghi chú.",
      brief,
      i > 0 ? ("ĐOẠN TRƯỚC (chỉ để nối mạch, KHÔNG viết lại):\n..." + chunks[i - 1].text.slice(-500)) : "",
      !isLast ? ("ĐOẠN SAU (chỉ để biết điều gì tới sau, KHÔNG viết):\n" + chunks[i + 1].text.slice(0, 350) + "...") : "",
      "===== ĐOẠN GỐC CẦN MỞ RỘNG =====", c.text, "===== HẾT ĐOẠN GỐC ====="
    ].filter(Boolean).join("\n\n");
    try {
      const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: o.model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
        maxTokens: Math.min(9000, Math.round(tw * 3) + 600), temperature: CREATIVE_TEMP, totalMs: Math.max(45000, Math.min(240000, writeTimeLeft(o.isNsfw) - 20000)), creative: true }, 1);
      let out = stripForeign(String(r.text || "").trim().replace(/^\s*(?:TIÊU ĐỀ|TITLE)\s*:\s*[^\n]+\n+/i, "").replace(/^\s*NỘI DUNG\s*:\s*/i, "").trim());
      if (r.finishReason === "length") return null;
      const nw = countWords(out);
      if (nw < c.words * 1.12) return null;
      if (overlap(c.text.slice(0, 500), out.slice(0, 900)) < 0.3) return null;               // mở đầu đoạn bị đổi/lạc đề
      if (isLast && overlap(lastPara(c.text), lastPara(out)) < 0.4) return null;              // đoạn kết bị đổi (bịa thêm)
      if (isLast && !endsCleanly(out)) return null;
      return { text: out, words: nw };
    } catch (e) { return null; }
  };
  const results = new Array(chunks.length).fill(null);
  for (let i = 0; i < chunks.length; i += 3) {
    if (writeTimeLeft(o.isNsfw) < 60000) break;
    const idx = [i, i + 1, i + 2].filter(k => k < chunks.length);
    const rs = await Promise.all(idx.map(k => doChunk(k)));
    idx.forEach((k, j) => { results[k] = rs[j]; });
  }
  // Ghép lại; không vượt maxWords: khối nào làm vượt thì giữ bản gốc
  let total = 0; const origRest = (from) => chunks.slice(from).reduce((a, c) => a + c.words, 0);
  const parts = []; let used = 0;
  chunks.forEach((c, i) => {
    const r = results[i];
    if (r && total + r.words + origRest(i + 1) <= o.maxWords) { parts.push(r.text); total += r.words; used++; }
    else { parts.push(c.text); total += c.words; }
  });
  const out = parts.join("\n\n"), nw = countWords(out);
  if (!used || nw < cur * 1.05) return { ok: false, reason: `chỉ ${used}/${chunks.length} đoạn mở rộng được (${nw}/${cur} từ)` };
  return { ok: true, text: out, used, total: chunks.length };
}

/* V12.20 — Khép câu cuối bị cụt: nhờ model viết nốt 1–3 câu; nếu không được thì lùi về câu hoàn chỉnh gần nhất. */
async function closeDanglingEnding(job, text, closingBeat, model, isNsfw) {
  const base = String(text || "").replace(/\s+$/, "");
  if (writeTimeLeft(isNsfw) > 40000) {
    try {
      const prompt = [
        "Đoạn cuối của chương truyện dưới đây bị CỤT giữa câu (hết dung lượng/đứt kết nối).",
        "Viết NỐT đúng từ chỗ cụt: bắt đầu bằng phần còn thiếu của chính câu đang dở (KHÔNG chép lại phần đã có), hoàn tất câu rồi khép chương trong tổng cộng 1–3 câu ngắn. Không thêm sự kiện, nhân vật hay cảnh mới; không tóm tắt; không giải thích.",
        closingBeat ? ("Người dùng muốn chương kết ở: " + closingBeat + "\n(Chỉ dùng nếu câu dở đang dẫn tới đó; nếu ý đó đã được viết rồi thì chỉ hoàn tất câu và dừng.)") : "",
        "ĐOẠN CUỐI:", base.slice(-1800),
        "Chỉ trả về phần viết nốt."
      ].filter(Boolean).join("\n\n");
      const r = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], maxTokens: 500, temperature: 0.5, totalMs: 60000, creative: true }, 1);
      let add = stripForeign(String(r.text || "").trim());
      add = add.replace(/^\s*(?:\.\.\.|…)\s*/, "").trim();
      if (add && add.length < 900 && !detectNonVietnamese(add)) {
        const sep = /\s$/.test(text) || /^[,.!?…;:”"’')]/.test(add) ? "" : " ";
        const joined = base + sep + add;
        if (endsCleanly(joined)) return { text: joined, how: "ai" };
        const tr = trimToLastSentence(joined, 0.6);
        if (tr.cut || endsCleanly(tr.text)) return { text: tr.text, how: "ai" };
      }
    } catch (_) {}
  }
  const tr = trimToLastSentence(base, 0.5);
  return { text: tr.text, how: tr.cut ? "trim" : "none" };
}

// V8-inspired prose path: temperature 0.82, no repetition penalties, prose-only output, style-lock continuation.
async function generateOneChapter(job) {
  const state = job.storyState;
  const chapters = Array.isArray(state.chapters) ? state.chapters : [];
  const chapterNumber = chapters.length + 1;
  const { target: minWords, hardMax: maxWords } = chapterWordLimits(state);
  const lastTail = ((chapters[chapters.length - 1] && chapters[chapters.length - 1].text) || "").slice(-1800);
  const nsfwSources = [
    state.directive || "",
    state.nextChapterHint || "",
    lastTail,
    (chapters[chapters.length - 1] && chapters[chapters.length - 1].title) || ""
  ].join("\n");
  const hotKeyword = textHasNsfwKeyword(nsfwSources);
  // V12.1 FIX: model NSFW là cấu hình job, không phụ thuộc việc client có giữ
  // modelNsfw trong storyState hay không. Điều này đặc biệt quan trọng với background job.
  const routingNsfwModel = String(job.modelNsfw || state.modelNsfw || "").trim();
  const matureFocus = normalizeChapterMatureFocus(state.chapterMatureFocus);
  // NONE luôn thắng mọi auto-detect: không được tự chèn nội dung trưởng thành.
  let isNsfw = matureFocus !== "none" && !!job.forceNsfw && !!routingNsfwModel;
  if (!isNsfw && matureFocus !== "none" && state.mature && state.nsfwMode !== "never" && routingNsfwModel && hotKeyword) {
    isNsfw = true;
  }
  // SECONDARY chỉ chuyển model khi có tín hiệu rõ từ brief/mệnh lệnh; PRIMARY mới dùng thêm heat detection.
  if (!isNsfw && matureFocus === "primary" && state.nsfwMode === "auto" && state.mature && routingNsfwModel && timeLeft() > 90000) {
    const heat = await detectHeatLevel(job, lastTail, state.nextChapterHint, state.directive);
    const threshold = Number(state.nsfwAutoThreshold) || 6;
    if (heat >= threshold) isNsfw = true;
  }
  const model = isNsfw ? (routingNsfwModel || job.model) : job.model;
  const hasBrief = !!(String(state.directive || "").trim() || String(state.nextChapterHint || "").trim());
  const closingBeat = extractClosingBeat(state.nextChapterHint) || extractClosingBeat(state.directive);
  const prompt = [
    `VIẾT CHƯƠNG ${chapterNumber}. Truyện đã có ${chapters.length} chương.`,
    hasBrief
      ? `MỤC TIÊU THAM KHẢO ${minWords} từ; GIỚI HẠN CỨNG ${maxWords} từ. CHƯƠNG NÀY CÓ KẾ HOẠCH CỦA NGƯỜI DÙNG: độ dài do kế hoạch quyết định. Triển khai ĐỦ mọi ý theo đúng thứ tự rồi DỪNG ở ý cuối. Nếu xong kế hoạch mà chưa đủ ${minWords} từ thì chấp nhận ngắn hơn — TUYỆT ĐỐI không bịa thêm cảnh/biến cố/nhân vật để cho đủ từ. Muốn dài hơn chỉ được mở rộng thoại, nội tâm, giác quan TRONG các ý đã có. ${DESCRIPTION_PROMPTS[state.descriptionLevel] || DESCRIPTION_PROMPTS.balanced}`
      : `MỤC TIÊU ${minWords} từ; GIỚI HẠN CỨNG ${maxWords} từ. Khi đạt khoảng ${minWords} từ và cảnh đã có điểm dừng tự nhiên thì phải kết thúc; tuyệt đối không kéo dài vượt ${maxWords} từ. ${DESCRIPTION_PROMPTS[state.descriptionLevel] || DESCRIPTION_PROMPTS.balanced}`,
    "Không mở đầu bằng tiêu đề, không giải thích ngoài truyện.",
    "Không lặp lại đoạn kết chương trước; phải tiếp nối nguyên nhân và hệ quả.",
    lastTail ? ("===== ĐOẠN KẾT CHƯƠNG TRƯỚC (PHẢI TIẾP NỐI) =====\n" + lastTail.slice(-1200) + "\n===== HẾT =====\n" + "ĐỊA ĐIỂM MỞ CHƯƠNG — KHÓA CỨNG: đoạn mở đầu PHẢI diễn ra ĐÚNG địa điểm, thời điểm và với đúng những người đang có mặt như trong đoạn kết chương trước (ví dụ chương trước kết ở biệt thự của A thì chương này vẫn bắt đầu ở biệt thự của A). Chỉ được chuyển địa điểm khi đoạn kết đã nói rõ nhân vật sắp rời đi/đến nơi khác, hoặc sau một câu chuyển cảnh rõ ràng (di chuyển + mốc thời gian). Tuyệt đối không nhảy sang nhà/phòng trọ/nơi ở của nhân vật khác ngay từ câu đầu.") : "",
    buildContext(state), recentContext(chapters),
    storyControlPrompt(state),
    matureFocusPrompt(state),
    isNsfw ? EROTIC_STYLE_PROMPT : "",
    isNsfw ? ("MỨC TRƯỞNG THÀNH: " + (EXPLICIT_PROMPTS[state.explicitLevel] || "")) : "",
    isNsfw ? ageGuardPrompt(state) : "",
    "NHẮC LẠI (bắt buộc, ưu tiên cao nhất — đọc kỹ trước khi viết):\n" +
      "- Chỉ 1–3 SỰ KIỆN CHÍNH trong chương này, không nhồi thêm biến cố.\n" +
      "- GIỚI HẠN CỨNG: TỐI ĐA 4 NHÂN VẬT CÓ TÊN RIÊNG xuất hiện trực tiếp (có thoại/hành động cụ thể) trong CẢ CHƯƠNG, tính cả nhân vật chính. Người qua đường/đám đông không tên không tính. Nếu là chương mở đầu, KHÔNG dồn hết dàn nhân vật vào chương 1 — chỉ ai trực tiếp tham gia 1-3 sự kiện chính của chương này, người còn lại để dành cho chương sau.\n" +
      "- Ưu tiên dùng nhân vật đã liệt kê ở mục NHÂN VẬT QUAN TRỌNG phía trên; chỉ tạo nhân vật mới khi thực sự cần và phải có lý do/vai trò rõ ràng.\n" +
      (((state.characters || []).filter(c => !c.dead).length === 0) ? "- CHƯA CÓ NHÂN VẬT PHỤ NÀO ĐƯỢC KHAI BÁO TRƯỚC. Nếu cần người ngoài nhân vật chính, ưu tiên nhân vật KHÔNG TÊN RIÊNG (chức danh chung chung). Chỉ đặt tên riêng nếu họ thực sự sẽ quay lại các chương sau.\n" : "") +
      (state.mainCharProfile?.name ? ("- NHÂN VẬT CHÍNH BẮT BUỘC LÀ TRUNG TÂM CHƯƠNG NÀY: " + state.mainCharProfile.name + ". TUYỆT ĐỐI không viết chương thiếu hẳn nhân vật này, không đổi tên/nhầm sang nhân vật khác.\n") : "") +
      (state.nextChapterHint ? ("- ĐỊNH HƯỚNG CHO CHƯƠNG NÀY (PHẢI triển khai đầy đủ các ý người dùng đã ghi; không tự thay bằng tuyến khác): " + String(state.nextChapterHint) + "\n") : "") +
      (state.directive ? ("- MỆNH LỆNH CHƯƠNG NÀY (GIỮ NGUYÊN TOÀN BỘ, KHÔNG RÚT GỌN): " + String(state.directive) + "\n") : ""),
    "QUY TẮC ĐẦU RA V12: Chỉ viết văn xuôi của chương. Không xuất TIÊU ĐỀ:, NỘI DUNG:, markdown, ghi chú hay lời giải thích. Tên chương do hệ thống quản lý riêng.",
    "VĂN PHONG V12: câu văn tự nhiên như tiểu thuyết tiếng Việt được biên tập bởi người Việt; thay đổi nhịp câu theo cảnh; không cố làm mọi câu hoa mỹ; không né từ tự nhiên chỉ vì sợ lặp.",
    "KẾT THÚC: nếu gần đủ độ dài và cảnh đã có điểm dừng tự nhiên, kết thúc gọn tại điểm đó; không thêm biến cố mới chỉ để đủ số từ.",
    // V12.20: khối khóa kế hoạch đặt CUỐI prompt (model chú ý nhất phần cuối)
    hasBrief ? [
      "===== KẾ HOẠCH CHƯƠNG — NGUỒN SỰ THẬT DUY NHẤT (NGƯỜI DÙNG VIẾT) =====",
      state.directive ? ("MỆNH LỆNH: " + String(state.directive).trim()) : "",
      state.nextChapterHint ? ("GỢI Ý: " + String(state.nextChapterHint).trim()) : "",
      "===== HẾT KẾ HOẠCH =====",
      "LUẬT BÁM KẾ HOẠCH: (1) Viết đúng thứ tự các ý ở trên. (2) Không thêm sự kiện, cảnh, nhân vật hay manh mối mà kế hoạch không nhắc. (3) Ý cuối cùng của kế hoạch là ĐIỂM KẾT CHƯƠNG: viết xong ý đó thì DỪNG HẲN, không viết thêm đoạn nào sau nó, không thêm cảnh kế tiếp, không tóm tắt, không dự báo.",
      closingBeat ? ("CÚ CHỐT BẮT BUỘC LÀ CÂU/CẢNH CUỐI CÙNG CỦA CHƯƠNG: " + closingBeat) : "",
      "Câu cuối chương phải là câu hoàn chỉnh, kết thúc bằng dấu câu."
    ].filter(Boolean).join("\n") : ""
  ].filter(Boolean).join("\n\n");

  // V12.2: nhánh trưởng thành có ngân sách output lớn hơn để không bị cụt sau một đoạn.
  const writeLeft = writeTimeLeft(isNsfw);
  const mainMaxTokens = isNsfw ? 24000 : 16000;
  const mainCallBudget = Math.max(60000, Math.min(480000, writeLeft - 15000));
  let result = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], maxTokens: mainMaxTokens, temperature: CREATIVE_TEMP, totalMs: mainCallBudget, creative: true }, 2);
  // V12: prose-only output; strip legacy labels if a model still emits them.
  let text = String(result.text || "").trim();
  text = text.replace(/^\s*(?:TIÊU ĐỀ|TITLE)\s*:\s*[^\n]+\n+/i, "");
  text = text.replace(/^\s*NỘI DUNG\s*:\s*/i, "").trim();

  // V12.3: nếu model chèn chữ Hán/Nhật/Hàn/Cyrillic, yêu cầu viết lại bằng tiếng Việt.
  if (detectNonVietnamese(text) && writeTimeLeft(isNsfw) > 60000) {
    try {
      const retry = await callWithRetry({
        endpoint: job.apiEndpoint, apiKey: job.apiKey, model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt + "\n\nCẢNH BÁO NGÔN NGỮ: Bản nháp vừa rồi có ngôn ngữ ngoài tiếng Việt. Viết lại toàn bộ, BẮT BUỘC 100% TIẾNG VIỆT CÓ DẤU; không dùng chữ Hán/Nhật/Hàn/Cyrillic; giữ nguyên cốt truyện và sự kiện." }],
        maxTokens: mainMaxTokens, temperature: 0.72, totalMs: Math.max(45000, Math.min(240000, writeTimeLeft(isNsfw) - 10000)), creative: true
      }, 1);
      if (retry.text && retry.text.trim()) text = String(retry.text).trim();
    } catch (_) {}
  }
  { const dd = dedupeRepeatedScene(text); if (dd.length < text.length) { text = dd; } }
  const initialCap = trimToWordLimit(text, maxWords);
  text = initialCap.text;
  const title = String(state.chapterTitle || state.currentChapterTitle || `Chương ${chapterNumber}`).trim() || `Chương ${chapterNumber}`;
  let truncated = result.finishReason === "length";
  const issues = [];
  let attempts = 0;
  const _sc = normalizeStoryControl(state);
  const control = { focus: matureFocus, maxMainEvents: _sc.maxMainEvents, maxNamedCharacters: _sc.maxNamedCharacters, noRetcon: _sc.noRetcon };

  // V12.2: nếu là nhánh trưởng thành, cho phép tối đa 8 lượt nối tiếp bất kể cấu hình cũ
  // chỉ đặt 4. Mỗi lượt vẫn dùng chính model đã route ở trên.
  const configuredAttempts = Number(state.autoContinueMax) || 4;
  const maxAttempts = isNsfw ? Math.max(4, Math.min(8, configuredAttempts)) : Math.max(0, Math.min(8, configuredAttempts));
  // V12.20: có gợi ý/mệnh lệnh thì CHỈ viết tiếp khi model bị cắt giữa chừng (hết token/đứt kết nối).
  // Trước đây bản nền thấy chưa đủ số từ là tự gọi "Viết TIẾP" không kèm gợi ý -> model hết ý nên bịa cảnh mới.
  while (countWords(text) < minWords && countWords(text) < maxWords && attempts < maxAttempts && (!hasBrief || truncated)) {
    if (writeTimeLeft(isNsfw) < 30000) { issues.push("Dừng viết tiếp vì hết ngân sách thời gian của job"); break; }
    attempts++;
    const current = countWords(text);
    const tail = text.slice(-5000);
    const need = Math.max(800, Math.min(minWords - current, maxWords - current));
    try {
      const cont = await callWithRetry({
        endpoint: job.apiEndpoint, apiKey: job.apiKey, model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: [
          `Viết TIẾP chương ${chapterNumber}. Hiện ${current} từ, cần thêm khoảng ${need} từ. Mục tiêu ${minWords} từ, tuyệt đối không vượt ${maxWords} từ. Khi đạt mục tiêu thì kết thúc tự nhiên.`,
          "Bắt đầu ngay sau câu cuối. Không tóm tắt, không mở chương mới, không lặp.",
          isNsfw
            ? "Đây là continuation của cùng một cảnh trưởng thành đã được chọn đúng model. Giữ nguyên mạch, nhịp, POV, xưng hô và trạng thái nhân vật; không tự chuyển sang cảnh mới chỉ vì đã viết được một đoạn. Tiếp tục cho đến khi đạt mục tiêu độ dài hoặc model thực sự hết output."
            : "Nếu diễn biến đã tự nhiên đi tới điểm dừng hợp lý gần đủ số từ, hãy kết thúc chương ở đó — KHÔNG cố nhồi thêm sự kiện/tình tiết mới chỉ để kéo dài.",
          storyControlPrompt(state),
          hasBrief ? ("KẾ HOẠCH CỦA NGƯỜI DÙNG (chỉ viết nốt các ý CHƯA được viết trong đoạn đã có, đúng thứ tự; ý cuối là điểm kết chương — viết xong thì DỪNG, không thêm gì sau đó):\n" + [state.directive ? ("MỆNH LỆNH: " + String(state.directive).trim()) : "", state.nextChapterHint ? ("GỢI Ý: " + String(state.nextChapterHint).trim()) : ""].filter(Boolean).join("\n") + (closingBeat ? ("\nCÚ CHỐT CUỐI CHƯƠNG: " + closingBeat) : "") + "\nNếu các ý trong kế hoạch đã được viết hết trong đoạn đã có thì chỉ khép chương bằng 1–2 câu rồi dừng.") : "",
          "ĐOẠN CUỐI (giữ giọng văn, nhịp câu, POV, thì kể, xưng hô của đoạn này):", tail,
          "Bắt đầu ngay sau câu cuối; TUYỆT ĐỐI không viết lại từ đầu chương và không nhắc lại phần đã viết. Nếu cảnh đã khép lại tự nhiên thì chỉ viết tiếp sang diễn biến kế tiếp, không chép lại.",
          "Chỉ trả văn xuôi tiếp theo."
        ].join("\n\n") }],
        maxTokens: isNsfw ? 12000 : 9000, temperature: CREATIVE_TEMP, totalMs: Math.max(45000, Math.min(420000, writeTimeLeft(isNsfw) - 12000)), creative: true
      }, 2);
      if (!cont.text || cont.text.trim().length < 50) { issues.push(`Viết tiếp #${attempts} quá ngắn`); break; }
      let contText = String(cont.text).trim();
      if (detectNonVietnamese(contText) && writeTimeLeft(isNsfw) > 60000) {
        try {
          const retry = await callWithRetry({
            endpoint: job.apiEndpoint, apiKey: job.apiKey, model,
            messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "Viết lại phần dưới đây bằng 100% tiếng Việt có dấu. Không dùng chữ Hán/Nhật/Hàn/Cyrillic. Giữ nguyên ý, không thêm sự kiện.\n\n" + contText }],
            maxTokens: Math.min(12000, Math.max(1800, Math.ceil(contText.length / 3))), temperature: 0.45, totalMs: Math.max(45000, Math.min(180000, writeTimeLeft(isNsfw) - 10000)), creative: true
          }, 1);
          if (retry.text && retry.text.trim()) contText = String(retry.text).trim();
        } catch (_) {}
      }
      const dedupedCont = dropRestartedContinuation(text, contText);
      if (!dedupedCont.trim() || countWords(dedupedCont) < 40) { issues.push(`Viết tiếp #${attempts} lặp lại phần đã có nên bị bỏ`); break; }
      if (dedupedCont.length < contText.length) issues.push(`Viết tiếp #${attempts}: đã lược đoạn lặp`);
      contText = dedupedCont;
      const remaining = maxWords - current;
      if (remaining <= 0) break;
      const capped = trimToWordLimit(contText, remaining);
      text = text.replace(/\s+$/, "") + "\n\n" + capped.text;
      truncated = cont.finishReason === "length" || capped.trimmed;
      if (capped.trimmed) break;
    } catch (e) { issues.push(`Viết tiếp #${attempts}: ${e.message}`); break; }
  }
  { const dd = dedupeRepeatedScene(text); if (dd.length < text.length) { text = dd; issues.push("Đã cắt phần chương bị viết lặp lại từ đầu"); } }
  // V12.20: chương có gợi ý mà còn ngắn -> MỞ RỘNG TẠI CHỖ (miêu tả/nội tâm/thoại) thay vì viết nối thêm cuối chương.
  if (hasBrief && !truncated && countWords(text) < minWords * 0.9) {
    for (let pass = 0; pass < 2 && countWords(text) < minWords * 0.9; pass++) {
      const ex = await expandChapterInPlace(job, text, { minWords, maxWords, closingBeat, model, isNsfw, state });
      if (!ex.ok) { issues.push("Mở rộng chương không đạt: " + ex.reason); break; }
      issues.push(`Đã mở rộng chương bằng miêu tả sâu hơn (${ex.used}/${ex.total} đoạn): ${countWords(text)} → ${countWords(ex.text)} từ`);
      text = ex.text;
    }
  }
  text = formatParagraphs(stripForeign(text));
  const _allowNames = (state.characters || []).map(x => x && x.name).filter(Boolean);
  // V12.20: tự sửa từ lỗi ghép (mươititude, bănnton, bọcampo...) bằng cách nhờ model chép lại ĐÚNG câu chứa từ đó.
  { const fx = await fixStrayWordsWithAI(job, text, _allowNames, model, isNsfw); text = fx.text; if (fx.fixed) issues.push(`Đã tự sửa ${fx.fixed} từ lỗi (vd: ${fx.samples.join(", ")})`); }
  { const stray = findStrayWords(text, _allowNames); if (stray.length) issues.push("Từ lạ cần kiểm tra: " + stray.slice(0, 8).join(", ")); }
  const finalCap = trimToWordLimit(text, maxWords);
  text = finalCap.text;
  if (finalCap.trimmed) issues.push(`Đã khóa độ dài: tối đa ${maxWords} từ`);
  // V12.20: câu cuối bị cụt giữa chừng -> nhờ model khép 1–3 câu; không được thì lùi về câu hoàn chỉnh gần nhất.
  if (!endsCleanly(text)) {
    const ce = await closeDanglingEnding(job, text, closingBeat, model, isNsfw);
    text = ce.text; truncated = false;
    issues.push(ce.how === "ai" ? "Câu cuối bị cụt — đã nhờ AI khép chương" : (ce.how === "trim" ? "Câu cuối bị cụt — đã lùi về câu hoàn chỉnh gần nhất" : "Câu cuối có thể còn cụt — hãy kiểm tra"));
  }
  const wordCount = countWords(text);
  if (wordCount < minWords * 0.9) issues.push(`Thiếu từ: ${wordCount}/${minWords}`);
  return { title, text, wordCount, truncated, plan: "", continuityWarnings: [], versions: [], modelUsed: model, isNsfw, routingModel: model, routingReason: job.forceNsfw ? "forced" : (hotKeyword ? "keyword" : (isNsfw ? "heat" : "normal")), polished: false, summary: "", versions: [], compressed: false, createdBy: "background-v12.3", createdAt: Date.now(), autoUpdateIssues: issues, minWordsTarget: minWords, control };
}

/* V12.10: chống tóm tắt bịa — kiểm tra tên/từ trong bản tóm tắt có thật trong chương không. */

function extractModelFor(job, chapter, state) {
  // V12.15: chương 18+ -> tóm tắt/gợi ý dùng model 18+ (model chính hay nói giảm nói tránh)
  const nm = String(job.modelNsfw || (state && state.modelNsfw) || "").trim();
  return (chapter && chapter.isNsfw && nm) ? nm : job.model;
}
async function generateSummary(job, chapter, n) {
  try {
    const full = String(chapter.text || "");
    const body = representativeText(full, 90000);
    const names = summaryNameList(full, (job.storyState && job.storyState.characters) || []);
    const _adult = !!chapter.isNsfw;
    const _mdl = extractModelFor(job, chapter, job.storyState);
    const fullPrompt = buildSummaryPrompt(body, n, names, _adult);
    const ask = async (content, temp, tries) => {
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: _mdl, messages: [{ role: "user", content }], maxTokens: 1400, temperature: temp }, tries);
      return (r.text || "").trim();
    };
    const looksMeta = s => !/\*\*Tóm tắt chương:?\*\*/i.test(s) || /^(Ngắn gọn|Súc tích|Đủ chi tiết|Cấu trúc rõ|Trung lập)\s*[:：]/im.test(s);
    let summary = await ask(fullPrompt, 0.2, 2);
    const g = summaryGrounded(summary, full);
    if (looksMeta(summary) || !g.ok) {
      try { const s2 = await ask(fullPrompt + summaryRetryNote(g), 0.1, 1); if (s2) summary = s2; } catch (_) {}
    }
    const _wc = t => (String(t).trim().match(/\S+/g) || []).length;
    if (_wc(summary) > 450) {
      try {
        const s3 = await ask("Rút gọn bản tóm tắt sau xuống 300-400 từ tiếng Việt. Giữ dòng mở đầu \"**Tóm tắt chương:**\", giữ trình tự thời gian, tên đầy đủ; bỏ chi tiết phụ; không thêm gì mới. Chỉ trả về bản đã rút gọn.\n\n" + summary, 0.15, 1);
        if (s3 && _wc(s3) < _wc(summary)) summary = s3;
      } catch (_) {}
      if (_wc(summary) > 450) {
        const words = summary.split(/\s+/).slice(0, 420).join(" ");
        const cut = Math.max(words.lastIndexOf(". "), words.lastIndexOf("! "), words.lastIndexOf("? "));
        summary = cut > words.length * 0.6 ? words.slice(0, cut + 1) : words;
      }
    }
    if (!summaryGrounded(summary, full).ok) summary = extractiveSummary(full) || summary;
    return summary;
  } catch (_) { return ""; }
}

/* Tự động đề xuất định hướng ngắn cho (các) chương SAU — chỉ tham khảo,
   không ép chương kế phải theo ngay. Người dùng có thể sửa tay trong app. */
const HINT_STYLES = {"normal": "Diễn tiến tự nhiên, tiếp nối mạch hiện tại.", "resist": "Nhân vật bị khống chế/yếu thế PHẢN KHÁNG rõ rệt trong chương này (hành động chống cự cụ thể); bên kia đáp trả và siết chặt hơn, hệ quả làm quan hệ quyền lực nặng thêm.", "twist": "Có một bước ngoặt/đảo chiều bất ngờ (lộ bí mật, lợi thế đổi bên, kế hoạch bị phá) nhưng vẫn hợp lý với thông tin đã có.", "escalate": "Leo thang: mức độ căng thẳng, rủi ro hoặc mức nóng cao hơn chương trước, có cú chốt gây hồi hộp.", "slow": "Nhịp chậm hơn: đào sâu nội tâm, quan hệ và hệ quả cảm xúc; ít biến cố mới."};
async function generateNextChapterHint(job, chapter, summary, n, state) {
  try {
    const openThreads = (state.threads || []).filter(t => !["paid_off", "abandoned", "completed"].includes(t.status)).slice(0, 8).map(t => "- " + t.desc).join("\n");
    const openForeshadowing = (state.foreshadowing || []).filter(f => !["paid_off", "abandoned", "resolved"].includes(f.status)).slice(-8).map(f => "- " + f.description).join("\n");
    const _adult = !!chapter.isNsfw;
    const _mdl = extractModelFor(job, chapter, state);
    const prompt = [
      `Bạn vừa đọc xong CHƯƠNG ${n} (tóm tắt bên dưới). Hãy viết GỢI Ý CHI TIẾT cho CHƯƠNG ${n + 1}.`,
      job.hintFormat === "beats"
        ? ("YÊU CẦU ĐỊNH DẠNG GỌN THEO NHỊP: mở đầu bằng dòng \"**Gợi ý ngắn Chương " + (n + 1) + ":**\", sau đó 1–3 đoạn ngắn kể lần lượt các nhịp chính theo đúng thứ tự diễn ra, mỗi nhịp 1–2 câu (ai làm gì, ở đâu, với đạo cụ/thiết lập nào, hệ quả). Câu cuối là dòng riêng bắt đầu bằng \"→ Kết chương ở:\" nêu rõ khoảnh khắc chương dừng lại. Tổng 150–260 từ, không gạch đầu dòng, không bình luận.")
        : ("YÊU CẦU ĐỊNH DẠNG: mở đầu bằng dòng \"**Gợi ý ngắn Chương " + (n + 1) + ":**\", sau đó 4-6 đoạn văn ngắn, mỗi đoạn là một cảnh/nhịp truyện theo đúng thứ tự diễn ra: (1) mở chương, (2) cảnh chính, (3) cảnh phát triển/căng thẳng, (4) cú chốt cuối chương."),
      "Mỗi đoạn phải dùng TÊN NHÂN VẬT cụ thể, nêu rõ hành động, địa điểm, xung đột, cảm xúc và hệ quả — KHÔNG nói chung chung kiểu \"nên khai thác thêm tuyến X\".",
      "Bám sát giọng điệu, thể loại, mức độ nóng/18+ và cách xưng hô mà chính truyện này đang dùng; tiếp nối trực tiếp các thread và foreshadowing đang mở, không tự mở tuyến mới lạc đề. Mở chương phải nối trực tiếp từ đoạn kết chương trước; các mốc đã hẹn (giờ họp, lệnh, hạn chót) phải được xử lý.",
      _adult ? "ĐỘ TRỰC DIỆN (truyện 18+): mạch chính đang có cảnh người lớn/khống chế nên hãy mô tả các nhịp đó THẲNG và CỤ THỂ đúng như cách chương vừa viết đã làm — nêu rõ hành động, đạo cụ, tư thế/vị trí và diễn biến bằng đúng từ ngữ của truyện. KHÔNG nói giảm nói tránh, không lược bỏ, không thay bằng cụm chung chung như \"cảnh nóng\"/\"cảnh thân mật\", không nhắc nhở hay bình luận đạo đức. Mọi nhân vật liên quan đều là người trưởng thành." : "",
      "ĐỊA ĐIỂM MỞ CHƯƠNG: nhịp mở chương PHẢI ở cùng địa điểm, thời điểm và với những người đang có mặt ở ĐOẠN KẾT CHƯƠNG (chương kết ở biệt thự của A thì chương sau vẫn mở ở biệt thự của A). Chỉ chuyển địa điểm nếu đoạn kết đã báo trước, và phải ghi rõ cách chuyển.",
      _adult ? "NHỊP CẢNH 18+: nếu chương sau có cảnh nóng, gợi ý PHẢI tách 3 phần và dành chỗ cho từng phần — (a) DẪN VÀO: không khí, lời nói/mệnh lệnh, từng bước áp sát và phản ứng đầu tiên; (b) DIỄN BIẾN + cao trào; (c) SAU CẢNH: dư chấn cơ thể, cảm xúc, thoại và hậu quả với quan hệ. Mỗi phần ít nhất 2–3 câu. Độ dài gợi ý có thể tăng thêm khoảng 50%." : "",
      "HƯỚNG CHƯƠNG SAU: " + (HINT_STYLES[job.hintStyle] || HINT_STYLES.normal),
      "ĐOẠN KẾT CHƯƠNG (để nối mạch):", String(chapter.text || "").slice(-1500),
      "TÓM TẮT:", summary || representativeText(chapter.text, 2000),
      openThreads ? ("THREADS ĐANG MỞ:\n" + openThreads) : "",
      openForeshadowing ? ("FORESHADOWING CHƯA GIẢI:\n" + openForeshadowing) : "",
      "Chỉ trả về nội dung gợi ý theo định dạng trên, tiếng Việt."
    ].filter(Boolean).join("\n\n");
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: _mdl, messages: [{ role: "user", content: prompt }], maxTokens: _adult ? 2200 : 1400, temperature: 0.7 }, 2);
    return (r.text || "").trim();
  } catch (_) { return ""; }
}

function compactCharacterList(state) {
  // V12.10: NV bị khóa hồ sơ gốc -> không đổi appearance/personality/goals; NV đã mở khóa -> kèm hồ sơ hiện tại để AI chỉ bổ sung điểm MỚI.
  return (state.characters || []).slice(0, 80).map(c => {
    const locked = c.coreLocked !== false;
    let line = `- ${c.name} [${c.tier || "supporting"}]${c.dead ? " [ĐÃ CHẾT]" : ""}${locked ? " [KHÓA HỒ SƠ GỐC]" : " [MỞ KHÓA: được cập nhật ngoại hình/tính cách/mục tiêu]"}`;
    if (!locked) {
      const cur = ["appearance","personality","goals"].map(k => c[k] ? `${k}: ${String(c[k]).slice(-260)}` : "").filter(Boolean).join(" | ");
      if (cur) line += `\n    hiện có -> ${cur}`;
    }
    const missingF = ["age","gender","role","occupation","appearance","personality","goals"].filter(k => !String(c[k] || "").trim());
    if (missingF.length) line += `\n    CHƯA CÓ (hãy điền nếu chương nêu rõ) -> ${missingF.join(", ")}`;
    const jobInfo = ["role","occupation","position","faction"].map(k => c[k] ? `${k}: ${String(c[k]).slice(0, 80)}` : "").filter(Boolean).join(" | ");
    if (jobInfo) line += `\n    nghề/chức vụ GỐC (giữ nguyên) -> ${jobInfo}`;
    return line;
  }).join("\n") || "(chưa có)";
}

function mergeTextField(oldValue, newValue, max = 2500) {
  const a = String(oldValue || "").trim(), b = String(newValue || "").trim();
  if (!b) return a;
  if (!a) return b.slice(0, max);
  if (normalizeName(a) === normalizeName(b) || normalizeName(a).includes(normalizeName(b))) return a;
  if (normalizeName(b).includes(normalizeName(a))) return b.slice(0, max);
  // V12.10: bỏ các đoạn đã có ý y hệt; khi vượt giới hạn thì bỏ đoạn CŨ NHẤT (không cắt mất phần mới ở cuối).
  const na = normalizeName(a);
  const fresh = b.split(/;\s*/).filter(seg => seg.trim() && !na.includes(normalizeName(seg)));
  if (!fresh.length) return a;
  const parts = a.split(/;\s*/).concat(fresh);
  while (parts.length > 1 && parts.join("; ").length > max) parts.shift();
  return parts.join("; ").slice(-max);
}

/* V12.19: các trường trước đây hiển thị trong UI nhưng AI không bao giờ cập nhật. */
const CHAR_EXTRA_ACCUM = ["independentPlot","strength","speech","sexualExperience","boundaries","taboos","preferences","attractionToMC","tensionWithMC","consentNotes"];
const CHAR_ADULT_ONLY = ["sexualExperience","boundaries","taboos","preferences","attractionToMC","tensionWithMC","consentNotes"];
const CHAR_STABLE_FILL = ["voice","scent","style","scars","tattoos"];
function applyCharExtras(c, u) {
  const age = parseAgeNum(c.age || u.age);
  CHAR_EXTRA_ACCUM.forEach(k => {
    if (!u[k] || !String(u[k]).trim()) return;
    if (CHAR_ADULT_ONLY.includes(k) && age !== null && age < 18) return; // khớp rào chắn tuổi
    c[k] = mergeTextField(c[k], u[k]);
  });
  CHAR_STABLE_FILL.forEach(k => { if (u[k] && !String(c[k] || "").trim()) c[k] = u[k]; });
  if (u.schedule && String(u.schedule).trim()) c.schedule = u.schedule;
}
function mergeCharacter(state, u, chapterNumber, sourceText) {
  if (!u?.name) return { created: false, updated: false };
  const name = String(u.name).trim();
  if (!name) return { created: false, updated: false };
  /* v12.18: tên trùng hồ sơ Nhân Vật Chính / nhãn chung "nhân vật chính" / bí danh → KHÔNG tạo mục mới */
  const rt = resolveCharacterTarget(state, name);
  if (rt.kind === "main") { applyMainCharUpdate(state.mainCharProfile, u); return { created: false, updated: true }; }
  let c = rt.kind === "character" ? rt.character : null;
  let created = false;
  if (!c) {
    c = {
      id: genId("c"), name, tier: u.tier || "supporting", age: u.age || "", gender: u.gender || "", position: u.position || "", speech: u.speech || "", height: u.height || "", bodyType: u.bodyType || "", hair: u.hair || "", eyes: u.eyes || "", skin: u.skin || "", role: u.role || "", relevanceToMC: u.relevanceToMC || "",
      appearance: u.appearance || "", personality: u.personality || "", occupation: u.occupation || "", faction: u.faction || "",
      goals: u.goals || "", secret: u.secret || "", weakness: u.weakness || "", fear: u.fear || "", knowledge: u.knowledge || "",
      currentLocation: u.currentLocation || "", physicalState: u.physicalState || "", mentalState: u.mentalState || "", independentPlot: u.independentPlot || "", strength: u.strength || "", voice: u.voice || "", scent: u.scent || "", style: u.style || "", scars: u.scars || "", tattoos: u.tattoos || "", schedule: u.schedule || "",
      relationships: [], firstAppearance: chapterNumber, lastAppearance: chapterNumber, locked: false, dead: !!u.isDead,
      deathChapter: u.isDead ? chapterNumber : null, history: []
    };
    if (!Array.isArray(state.characters)) state.characters = [];
    state.characters.push(c); created = true;
    applyCharExtras(c, u);
  } else {
    const coreLocked = c.coreLocked !== false;
    const coreFields = ["name","age","gender","appearance","personality","goals","role","position","occupation","faction"];
    const accum = ["appearance","personality","goals","secret","weakness","fear","knowledge"];
    if(!c.coreIdentity || typeof c.coreIdentity !== "object") c.coreIdentity={};
    if(coreLocked){
      coreFields.forEach(k=>{ if(c.coreIdentity[k] === undefined) c.coreIdentity[k] = c[k] || ""; });
    }
    /* V12.19: khóa hồ sơ gốc chỉ chặn GHI ĐÈ giá trị đã có; trường còn trống vẫn được điền. */
    accum.forEach(k => {
      if (!u[k]) return;
      const emptyNow = !String(c[k] || "").trim();
      if (coreLocked && coreFields.includes(k) && !emptyNow) return;
      c[k] = mergeTextField(c[k], u[k]);
      if (coreFields.includes(k) && (!coreLocked || emptyNow)) c.coreIdentity[k] = c[k];
    });
    ["age","gender","position","speech","height","bodyType","hair","eyes","skin"].forEach(k => {
      if (u[k] && !String(c[k] || "").trim()) { c[k] = u[k]; if (coreFields.includes(k)) c.coreIdentity[k] = c[k]; }
    });
    /* V12.19: nghề/chức vụ đã có chỉ đổi khi có sự kiện + bằng chứng trích đúng từ chương (kể cả NV đã mở khóa). */
    const explicitJobChange = u.explicitCoreChange === true && String(u.changeEvidence || "").trim().length >= 12 && (sourceText == null || evidenceInText(u.changeEvidence, sourceText));
    ["role","relevanceToMC","occupation","faction"].forEach(k => {
      if (!u[k]) return;
      const emptyNow = !String(c[k] || "").trim();
      if (coreLocked && coreFields.includes(k) && !explicitJobChange && !emptyNow) return;
      if (k !== "relevanceToMC" && !emptyNow && normalizeName(c[k]) !== normalizeName(u[k]) && !explicitJobChange) return;
      c[k] = u[k];
      if (coreFields.includes(k) && (emptyNow || explicitJobChange)) c.coreIdentity[k] = c[k];
    });
    ["currentLocation","physicalState","mentalState"].forEach(k => { if (u[k]) c[k] = u[k]; });
    applyCharExtras(c, u);
    if (u.tier && !c.locked) c.tier = u.tier;
    if (u.isDead === true && !c.dead) { c.dead = true; c.deathChapter = chapterNumber; }
    c.lastAppearance = chapterNumber;
  }
  if (!Array.isArray(c.relationships)) c.relationships = [];
  const _agR = parseAgeNum(c.age || u.age), minorAge = _agR !== null && _agR < 18;
  /* V12.19: quan hệ với nhân vật chính (bản chạy nền trước đây bỏ sót hoàn toàn). */
  if (u.relationshipWithMain && typeof u.relationshipWithMain === "object" && Object.values(u.relationshipWithMain).some(v => v)) {
    let rm = c.relationships.find(x => normalizeName(x.withName).includes("nhan vat chinh"));
    if (!rm) { rm = { withName: "Nhân vật chính", stage: "", trust: "", notes: "", history: [] }; c.relationships.push(rm); }
    Object.keys(u.relationshipWithMain).forEach(k => {
      const v = u.relationshipWithMain[k]; if (!v) return;
      if ((k === "attraction" || k === "boundaries") && minorAge) return;
      rm[k] = v;
    });
  }
  (Array.isArray(u.relationships) ? u.relationships : []).forEach(r => {
    if (!r?.withName) return;
    let rel = c.relationships.find(x => normalizeName(x.withName) === normalizeName(r.withName));
    if (!rel) { rel = { withName: r.withName, stage: "", trust: "", notes: "", history: [] }; c.relationships.push(rel); }
    ["stage","trust","respect","affection","attraction","suspicion","tension","boundaries","notes"].forEach(k => {
      if (!r[k]) return;
      if ((k === "attraction" || k === "boundaries") && minorAge) return; // khớp rào chắn tuổi
      rel[k] = r[k];
    });
    if (r.notes) { if (!Array.isArray(rel.history)) rel.history = []; rel.history.push({ chapter: chapterNumber, change: r.notes }); }
  });
  if (u.chapterEvent) { if (!Array.isArray(c.history)) c.history = []; c.history.push({ chapter: chapterNumber, event: u.chapterEvent }); }
  return { created, updated: true };
}

// v11.1 — chạy các lô trích xuất với độ song song giới hạn (mặc định 3). Merge vào state là ĐỒNG BỘ sau mỗi await
// nên an toàn; mergeCharacter/applyWorld gộp theo tên chuẩn hóa nên lô chạy song song không tạo trùng.
const EXTRACT_CONCURRENCY = Math.max(1, Math.min(6, parseInt(process.env.EXTRACT_CONCURRENCY, 10) || 3));
async function runPool(count, worker, limit = EXTRACT_CONCURRENCY) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, count) }, async () => {
    while (true) { const i = next++; if (i >= count) return; await worker(i); }
  });
  await Promise.all(runners);
}

async function updateCharacters(job, chapter, n, state) {
  if (!Array.isArray(state.characters)) state.characters = [];
  const chunks = chunkText(chapter.text, 9000, 700);
  const res = { ok: true, chunks: chunks.length, nNew: 0, nUpdated: 0, failed: 0, dropped: 0, cut: 0, notes: [], problems: [] };
  await runPool(chunks.length, async (i) => {
    const tag = `NV lô ${i + 1}/${chunks.length}`;
    if (timeLeft() < 150000) { res.failed++; res.notes.push(`${tag}: BỎ QUA vì sắp hết thời gian job (dành phần còn lại cho Status/Memory)`); return; }
    const prompt = [
      `CẬP NHẬT NHÂN VẬT — CHƯƠNG ${n}, PHẦN ${i + 1}/${chunks.length}.`,
      "Chỉ liệt kê nhân vật thực sự xuất hiện hoặc được nhắc tới có ý nghĩa trong PHẦN này. Không bịa.",
      (state.mainCharProfile && state.mainCharProfile.name) ? `Nhân vật chính tên là "${state.mainCharProfile.name}" — khi ghi nhân vật chính PHẢI dùng đúng tên này; KHÔNG tạo mục tên "nhân vật chính".` : "",
      "Tối đa 12 nhân vật; mỗi trường mô tả (appearance/personality/goals/knowledge) khoảng 30-60 từ, cụ thể (đặc điểm, hành vi, chi tiết mới lộ ra trong phần này); chỉ ghi điểm MỚI so với mục \"hiện có\", không lặp lại hồ sơ cũ; NV đang [KHÓA HỒ SƠ GỐC] thì để trống các trường ĐÃ CÓ giá trị (appearance/personality/goals...), nhưng trường nằm trong mục CHƯA CÓ thì phải điền nếu chương nêu rõ. Trường nằm trong mục \"CHƯA CÓ\" của nhân vật: hãy ĐIỀN nếu chương nêu rõ (ví dụ \"nữ thư ký\" → gender: nữ, occupation: thư ký; tuổi/chiều cao/tóc/mắt chỉ khi có con số hoặc mô tả trực tiếp). Trường đã có giá trị thì để trống, không ghi đè. Không đoán. Không dùng dấu \" bên trong giá trị chuỗi. Chỉ trả về JSON array.",
      "Nghề/chức vụ (role, occupation, position, faction) là DỮ LIỆU GỐC: KHÔNG đổi, KHÔNG suy diễn từ cách người khác xưng hô, từ việc nhân vật làm việc với giám đốc/sếp, hay từ cảnh nhân vật ngồi ghế/ở phòng của ai. Chỉ đổi khi chương KỂ RÕ một sự kiện thăng chức/bổ nhiệm/từ chức/đổi nghề đã xảy ra; khi đó đặt explicitCoreChange=true và changeEvidence phải TRÍCH NGUYÊN VĂN câu trong chương cho thấy sự kiện đó. Nếu không có, để trống role/occupation/position/faction.",
      "Giải thích thêm: speech = cách nói riêng (giọng, khẩu ngữ, câu cửa miệng); strength = điểm mạnh/kỹ năng thể hiện trong chương; independentPlot = TUYẾN TRUYỆN RIÊNG của NV (việc họ tự làm/âm mưu ngoài tuyến chính, chỉ ghi diễn biến MỚI); các trường 18+ (sexualExperience, boundaries, taboos, preferences, attractionToMC, tensionWithMC, consentNotes) CHỈ ghi khi chương thể hiện rõ về NV trưởng thành, nếu không thì để trống.",
      "Danh sách tên đã biết:", compactCharacterList(state),
      "NỘI DUNG PHẦN:", chunks[i],
      'JSON: [{"name":"","tier":"background|minor|supporting|important|major","age":"","gender":"","position":"","speech":"","height":"","bodyType":"","hair":"","eyes":"","skin":"","role":"","relevanceToMC":"","voice":"","scent":"","style":"","scars":"","tattoos":"","schedule":"","strength":"","independentPlot":"","sexualExperience":"","boundaries":"","taboos":"","preferences":"","attractionToMC":"","tensionWithMC":"","consentNotes":"","appearance":"","personality":"","occupation":"","faction":"","goals":"","secret":"","weakness":"","fear":"","knowledge":"","currentLocation":"","physicalState":"","mentalState":"","chapterEvent":"","relationshipWithMain":{"trust":"","respect":"","affection":"","attraction":"","suspicion":"","tension":"","boundaries":"","stage":"","notes":""},"relationships":[{"withName":"","stage":"","trust":"","respect":"","affection":"","attraction":"","suspicion":"","tension":"","boundaries":"","notes":""}],"isDead":false,"explicitCoreChange":false,"changeEvidence":""}]'
    ].join("\n\n");
    try {
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "system", content: "Bạn là bộ máy trích xuất dữ liệu nhân vật. Không được viết văn xuôi. Chỉ trả JSON hợp lệ." }, { role: "user", content: prompt }], maxTokens: 11500, temperature: 0.15 }, 2);
      const parsed = await parseArrayWithRepair(job, r.text);
      if (!parsed.valid) {
        res.failed++;
        res.notes.push(`${tag}: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`);
        return;
      }
      let created = 0, upd = 0, merr = 0;
      parsed.items.forEach(u => {
        try { const x = mergeCharacter(state, u, n, chunks[i]); if (x.created) created++; else if (x.updated) upd++; }
        catch (e) { merr++; }
      });
      res.nNew += created; res.nUpdated += upd; res.dropped += (parsed.dropped || 0) + merr;
      if (r.finishReason === "length" || parsed.truncated) res.cut++;
      res.notes.push(`${tag}: ${fin(r)}, parse=${parsed.method || "?"}, ${parsed.items.length} NV (+${created} mới, ${upd} cập nhật)${parsed.dropped ? `, ${parsed.dropped} object hỏng bị bỏ` : ""}${merr ? `, ${merr} lỗi merge` : ""}`);
    } catch (e) { res.failed++; res.notes.push(`${tag}: LỖI gọi model — ${sampleOf(e.message, 160)}`); }
  });
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
  await runPool(chunks.length, async (i) => {
    const tag = `Thế giới lô ${i + 1}/${chunks.length}`;
    if (timeLeft() < 150000) { res.failed++; res.notes.push(`${tag}: BỎ QUA vì sắp hết thời gian job (dành phần còn lại cho Status/Memory)`); return; }
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
      if (!parsed.obj) { res.failed++; res.notes.push(`${tag}: KHÔNG đọc được JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`); return; }
      const before = [state.locations.length, state.items.length, state.threads.length];
      applyWorld(parsed.obj, n, state);
      if (r.finishReason === "length") res.cut++;
      res.notes.push(`${tag}: ${fin(r)}, parse=${parsed.method || "?"}, +${state.locations.length - before[0]} địa điểm, +${state.items.length - before[1]} vật phẩm, +${state.threads.length - before[2]} thread`);
    } catch (e) { res.failed++; res.notes.push(`${tag}: LỖI — ${sampleOf(e.message, 160)}`); }
  });
  res.ok = res.failed < chunks.length;
  if (res.failed) res.problems.push(`Thế giới: ${res.failed}/${chunks.length} lô không đọc được`);
  if (res.cut) res.problems.push(`Thế giới: model bị cắt cụt ở ${res.cut} lô`);
  return res;
}

function normalizeStatusState(state, n) {
  const legacy = (state && state.statusState && typeof state.statusState === "object") ? state.statusState : {};
  const out = JSON.parse(JSON.stringify(legacy || {}));
  if (!out.schemaVersion) {
    out.schemaVersion = 2;
    if (state && state.currentStatus && !Object.keys(legacy || {}).length) out.legacyText = String(state.currentStatus);
  }
  if (!out.currentState || typeof out.currentState !== "object") out.currentState = {};
  if (!out.longTerm || typeof out.longTerm !== "object") out.longTerm = {};
  if (!Array.isArray(out.characterStates)) out.characterStates = [];
  if (!Array.isArray(out.changeLog)) out.changeLog = [];
  if (!Array.isArray(out.conflicts)) out.conflicts = [];
  if (!out.currentState.time && legacy.time) out.currentState.time = legacy.time;
  if (!out.currentState.situation && legacy.currentSituation) out.currentState.situation = legacy.currentSituation;
  if (!out.currentState.location && legacy.locations) out.currentState.location = legacy.locations;
  if (!out.currentState.mainCharacter && legacy.mainCharacter) out.currentState.mainCharacter = legacy.mainCharacter;
  if (!out.currentState.power && legacy.power) out.currentState.power = legacy.power;
  if (!out.currentState.relationships && legacy.relationships) out.currentState.relationships = legacy.relationships;
  if (!out.currentState.knowledge && legacy.knowledge) out.currentState.knowledge = legacy.knowledge;
  if (!out.currentState.unresolved && legacy.unresolved) out.currentState.unresolved = legacy.unresolved;
  if (!out.currentState.nextHooks && legacy.nextHooks) out.currentState.nextHooks = legacy.nextHooks;
  if (!out.longTerm.secrets && legacy.knowledge) out.longTerm.secrets = legacy.knowledge;
  return out;
}

function statusCharacterRoster(state) {
  const list = [];
  const seen = new Set();
  const add = (c, fallbackName = "") => {
    if (!c || typeof c !== "object") return;
    const name = String(c.name || fallbackName || "").trim();
    if (!name) return;
    const id = String(c.id || "name:" + normalizeName(name));
    if (seen.has(id)) return;
    seen.add(id);
    list.push({
      id, name,
      tier: c.tier || "",
      role: c.role || "",
      age: c.age || "",
      appearance: c.appearance || "",
      currentLocation: c.currentLocation || "",
      physicalState: c.physicalState || "",
      mentalState: c.mentalState || "",
      occupation: c.occupation || "",
      goals: c.goals || "",
      weakness: c.weakness || "",
      strength: c.strength || "",
      personality: c.personality || "",
      relationships: c.relationships || []
    });
  };
  add(state.mainCharProfile, "Nhân vật chính");
  (Array.isArray(state.characters) ? state.characters : []).forEach(c => add(c));
  return list;
}

function formatStatusV2(status, n) {
  const cs = status.currentState || {};
  const lt = status.longTerm || {};
  const lines = [`Current Status Update - Sau Chương ${n}`];
  const add = (label, value) => {
    if (value == null) return;
    if (Array.isArray(value)) value = value.map(x => typeof x === "string" ? x : JSON.stringify(x)).join("; ");
    if (typeof value === "object") value = JSON.stringify(value);
    if (String(value).trim()) lines.push(`- ${label}: ${String(value).trim()}`);
  };
  add("Thời điểm hiện tại", cs.time);
  add("Sự kiện chính vừa xảy ra", cs.mainEvent || cs.situation);
  add("Địa điểm", cs.location);
  add("Tình trạng tổng thể", cs.overall);
  add("Nhân vật chính", cs.mainCharacter);
  add("Phát triển mối quan hệ", cs.relationships);
  add("Tiến triển sức mạnh / tu vi / kỹ năng", cs.power);
  add("Quy tắc do nhân vật chính đặt ra", cs.rules);
  add("Điểm nhấn / xung đột mới", cs.conflict);
  add("Mục tiêu / hướng chương sau", cs.nextGoal || cs.nextHooks);
  add("Thông tin / kiến thức mới", cs.knowledge);
  add("Vấn đề chưa giải quyết", cs.unresolved);
  add("Bí mật / lời hứa / sự kiện dài hạn", lt.secrets);
  add("Quy tắc / thỏa thuận đặc biệt", lt.rules);
  add("Điểm yếu / rủi ro", lt.weaknesses);

  if (Array.isArray(status.characterStates) && status.characterStates.length) {
    lines.push("- Thông tin nhân vật cập nhật:");
    status.characterStates.forEach(c => {
      const label = c.name || c.characterId || "Nhân vật";
      if (c.status === "unchanged" && (!c.changes || !Object.keys(c.changes).length)) {
        lines.push(`  • ${label}: Không có thay đổi đáng kể`);
        return;
      }
      const changes = c.changes || {};
      const parts = Object.keys(changes).map(k => `${k}: ${typeof changes[k] === "object" ? JSON.stringify(changes[k]) : changes[k]}`).filter(Boolean);
      lines.push(`  • ${label}: ${parts.length ? parts.join(" | ") : "Không có thay đổi đáng kể"}`);
    });
  }
  if (status.legacyText) {
    lines.push("- Current Status trước khi nâng cấp:");
    lines.push(String(status.legacyText).trim());
  }
  if (Array.isArray(status.conflicts) && status.conflicts.length) {
    lines.push("- XUNG ĐỘT CẦN GIỮ LẠI, CHƯA TỰ Ý GHI ĐÈ:");
    status.conflicts.slice(-20).forEach(c => {
      lines.push(`  • ${c.characterName || c.field || "Status"}: ${c.description || c.newValue || ""}${c.evidence ? ` [Bằng chứng: ${c.evidence}]` : ""}`);
    });
  }
  return lines.join("\n");
}

function mergeStatusChanges(state, n, extraction) {
  const status = normalizeStatusState(state, n);
  const changes = extraction && extraction.changes && typeof extraction.changes === "object" ? extraction.changes : {};
  const setIfValid = (target, key, item) => {
    if (!item || typeof item !== "object") return false;
    const statusName = String(item.status || "").toLowerCase();
    const value = item.value;
    const evidence = String(item.evidence || "").trim();
    if (!evidence || !["updated", "added", "resolved"].includes(statusName)) return false;
    if (value == null || String(value).trim() === "") return false;
    target[key] = value;
    return true;
  };

  const fieldMap = {
    time: "time", situation: "situation", mainEvent: "mainEvent", location: "location",
    overall: "overall", mainCharacter: "mainCharacter", relationships: "relationships",
    power: "power", rules: "rules", conflict: "conflict", nextGoal: "nextGoal",
    knowledge: "knowledge", unresolved: "unresolved"
  };
  let applied = 0;
  Object.keys(fieldMap).forEach(k => {
    if (setIfValid(status.currentState, fieldMap[k], changes[k])) applied++;
  });

  const ltMap = {
    secrets: "secrets", rules: "rules", weaknesses: "weaknesses"
  };
  Object.keys(ltMap).forEach(k => {
    if (setIfValid(status.longTerm, ltMap[k], changes[k])) applied++;
  });

  const roster = statusCharacterRoster(state);
  const rosterById = new Map(roster.map(c => [c.id, c]));
  const incomingChars = Array.isArray(changes.characterChanges) ? changes.characterChanges : [];
  const normalizedChars = [];
  incomingChars.forEach(c => {
    if (!c || typeof c !== "object") return;
    const id = String(c.characterId || "");
    const name = String(c.characterName || c.name || "").trim();
    const known = (id && rosterById.get(id)) || roster.find(x => normalizeName(x.name) === normalizeName(name));
    if (!known) return; // Không cho AI tự tạo nhân vật mới trong Current Status.
    const cleanChanges = {};
    if (c.changes && typeof c.changes === "object") {
      Object.keys(c.changes).forEach(k => {
        const v = c.changes[k];
        if (v != null && String(v).trim() !== "") cleanChanges[k] = v;
      });
    }
    const evidence = String(c.evidence || "").trim();
    const accepted = Object.keys(cleanChanges).length && evidence && String(c.status || "updated").toLowerCase() === "updated";
    const item = {
      characterId: known.id,
      name: known.name,
      status: accepted ? "updated" : "unchanged",
      changes: accepted ? cleanChanges : {},
      evidence: accepted ? evidence : ""
    };
    normalizedChars.push(item);
    if (accepted) applied++;
  });

  // Bắt buộc kiểm kê tất cả nhân vật hiện có; nhân vật không đổi không bị xóa.
  const byId = new Map(normalizedChars.map(x => [x.characterId, x]));
  roster.forEach(c => {
    if (!byId.has(c.id)) normalizedChars.push({ characterId: c.id, name: c.name, status: "unchanged", changes: {}, evidence: "" });
  });
  status.characterStates = normalizedChars;

  const conflicts = Array.isArray(changes.conflicts) ? changes.conflicts : [];
  const validatedConflicts = conflicts.filter(c => c && typeof c === "object" && String(c.evidence || "").trim()).map(c => ({
    chapter: n,
    characterName: c.characterName || "",
    field: c.field || "",
    oldValue: c.oldValue || "",
    newValue: c.newValue || "",
    description: c.description || "",
    evidence: String(c.evidence).trim()
  }));
  if (validatedConflicts.length) status.conflicts.push(...validatedConflicts);

  const log = {
    chapter: n,
    appliedAt: Date.now(),
    appliedCount: applied,
    conflicts: validatedConflicts.length,
    changes: changes
  };
  status.changeLog.push(log);
  status.changeLog = status.changeLog.slice(-50);
  status.conflicts = status.conflicts.slice(-50);
  status.schemaVersion = 2;
  return { status, applied, conflicts: validatedConflicts.length };
}

function formatStatus(obj, n) {
  // Giữ hàm cũ để dữ liệu legacy vẫn đọc được; dữ liệu mới dùng formatStatusV2.
  if (obj && obj.schemaVersion >= 2 && obj.currentState) return formatStatusV2(obj, n);
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
  const roster = statusCharacterRoster(state);
  const rosterText = roster.length ? roster.map(c => `- ${c.id} | ${c.name} | vai trò:${c.role} | tier:${c.tier}`).join("\n") : "(chưa có danh sách nhân vật)";
  const source = [
    "CURRENT STATUS HIỆN TẠI:", previous,
    "",
    "DANH SÁCH NHÂN VẬT ĐÃ TỒN TẠI (KHÔNG ĐƯỢC TỰ TẠO NHÂN VẬT MỚI):", rosterText,
    "",
    "TÓM TẮT CHƯƠNG:", chapter.summary || "",
    "",
    "ĐOẠN CUỐI CHƯƠNG:", chapter.text.slice(-9000)
  ].join("\n");

  const keys = ["changes"];
  try {
    const r = await callExtract({
      endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model,
      messages: [{
        role: "user",
        content: [
          `CẬP NHẬT CURRENT STATUS SAU CHƯƠNG ${n} — CHỈ TRÍCH XUẤT THAY ĐỔI.`,
          "Đây là hệ thống CHANGE → VALIDATE → MERGE. TUYỆT ĐỐI không viết lại toàn bộ Current Status.",
          "1) Chỉ đánh dấu UPDATED/ADDED/RESOLVED khi chương có bằng chứng rõ ràng.",
          "2) Không được xóa dữ liệu cũ chỉ vì chương không nhắc lại.",
          "3) Không được tự tạo nhân vật mới. Chỉ cập nhật nhân vật có trong DANH SÁCH NHÂN VẬT.",
          "4) Mỗi thay đổi phải có evidence là mô tả ngắn, bám trực tiếp vào nội dung chương.",
          "5) Nếu thông tin mới mâu thuẫn với dữ liệu cũ mà chưa đủ căn cứ để ghi đè, đưa vào conflicts thay vì cập nhật.",
          "6) Nhân vật không thay đổi phải được ghi status=unchanged hoặc để hệ thống tự bổ sung; không xóa hồ sơ cũ.",
          "7) Tất cả output bằng TIẾNG VIỆT.",
          source,
          `Trả DUY NHẤT JSON theo schema:
{
  "changes": {
    "time":{"status":"updated|unchanged","value":"","evidence":""},
    "situation":{"status":"updated|unchanged","value":"","evidence":""},
    "mainEvent":{"status":"updated|unchanged","value":"","evidence":""},
    "location":{"status":"updated|unchanged","value":"","evidence":""},
    "overall":{"status":"updated|unchanged","value":"","evidence":""},
    "mainCharacter":{"status":"updated|unchanged","value":"","evidence":""},
    "relationships":{"status":"updated|unchanged","value":"","evidence":""},
    "power":{"status":"updated|unchanged","value":"","evidence":""},
    "rules":{"status":"added|updated|unchanged","value":"","evidence":""},
    "conflict":{"status":"added|updated|unchanged","value":"","evidence":""},
    "nextGoal":{"status":"updated|unchanged","value":"","evidence":""},
    "knowledge":{"status":"added|updated|unchanged","value":"","evidence":""},
    "unresolved":{"status":"added|resolved|updated|unchanged","value":"","evidence":""},
    "secrets":{"status":"added|resolved|updated|unchanged","value":"","evidence":""},
    "weaknesses":{"status":"added|updated|unchanged","value":"","evidence":""},
    "characterChanges":[
      {
        "characterId":"",
        "characterName":"",
        "status":"updated|unchanged",
        "changes":{"age":"","appearance":"","body":"","clothing":"","marks":"","cultivation":"","cultivationState":"","emotion":"","submission":"","ruleCompliance":"","socialStatus":"","occupation":"","residence":"","romance":"","weakness":"","goals":"","items":"","publicPersonality":"","privatePersonality":"","psychology":"","relationships":"","physicalState":"","mentalState":"","knowledge":""},
        "evidence":""
      }
    ],
    "conflicts":[
      {"characterName":"","field":"","oldValue":"","newValue":"","description":"","evidence":""}
    ]
  }
}`,
          "Không điền giá trị cho trường không thay đổi. Không dùng null cho thay đổi. Không markdown."
        ].join("\n\n")
      }],
      maxTokens: 7600, temperature: 0.12
    }, 2);

    const parsed = await parseObjectWithRepair(job, r.text, keys);
    const extraction = parsed.obj;
    if (!extraction || !extraction.changes || typeof extraction.changes !== "object") {
      res.notes.push(`Status: KHÔNG đọc được change JSON (${fin(r)}, đầu: "${sampleOf(r.text)}")`);
      res.problems.push("Status: change extraction lỗi; Status cũ được giữ nguyên");
      return res;
    }

    const merged = mergeStatusChanges(state, n, extraction);
    if (!merged.applied && !merged.conflicts) {
      // Không coi output rỗng là lý do để xóa/ghi đè Current Status.
      res.notes.push("Status: không có thay đổi có bằng chứng; giữ nguyên trạng thái cũ");
      state.statusState = merged.status;
      state.currentStatus = formatStatusV2(merged.status, n);
      state.lastStatusChapter = n;
      res.ok = true;
      return res;
    }

    state.statusState = merged.status;
    state.currentStatus = formatStatusV2(merged.status, n);
    state.lastStatusChapter = n;
    res.ok = true;
    res.notes.push(`Status: CHANGE→VALIDATE→MERGE, áp dụng ${merged.applied} thay đổi, ${merged.conflicts} xung đột; ${fin(r)}, parse=${parsed.method || "?"}`);
    if (r.finishReason === "length") res.problems.push("Status: model bị cắt cụt; chỉ merge thay đổi hợp lệ đã đọc được");
    return res;
  } catch (e) {
    res.notes.push(`Status: LỖI — ${sampleOf(e.message, 160)}`);
    res.problems.push("Status: lỗi gọi model; Status cũ được giữ nguyên");
    return res;
  }
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

/* ========== QUALITY GATE / CANON PIPELINE V12.16 ========== */
function qualityReviewPromptWorker(state, chapter, n) {
  const sc = normalizeStoryControl(state || {});
  const hardChecks = gateHardChecks(chapter);
  return buildQualityReviewPrompt({
    storyControl: storyControlPrompt(state),
    contract: String(state.directive || "") + "\n" + String(state.nextChapterHint || ""), contractLabel: "CHAPTER BRIEF",
    context: buildContext(state), warnings: chapter.continuityWarnings, draft: chapter.text, prevEnding: (((state.chapters || [])[n - 2] || {}).text || "").slice(-1500), hardChecks,
    knownNames: knownNameMentions(chapter.text, gateKnownNames(state)),
    maxMainEvents: sc.maxMainEvents, maxNamedCharacters: sc.maxNamedCharacters
  });
}
async function qualityReviewWorker(job, chapter, n) {
  const prompt = qualityReviewPromptWorker(job.storyState, chapter, n);
  try {
    const r = await callWithRetry({
      endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
      maxTokens: 2200, temperature: 0.1, totalMs: Math.max(30000, Math.min(180000, writeTimeLeft(false) - 10000)), creative: false
    }, 1);
    const parsed = parseJsonLoose(r.text, "{");
    const sc = normalizeStoryControl(job.storyState || {});
    const review = evaluateReview(parsed.value, { maxMainEvents: sc.maxMainEvents, maxNamedCharacters: sc.maxNamedCharacters, passScore: job.storyState.qualityPassScore, softFailScore: job.storyState.qualitySoftFailScore, extraHard: gateHardChecks(chapter).filter(x => !x.ok).map(x => x.message) });
    if (!review) return { ok: false, reason: "review_parse" };
    return { ok: true, review };
  } catch (e) { return { ok: false, reason: e.message }; }
}
async function rewriteWorkerDraft(job, chapter, n, review) {
  const oldText = String(chapter.text || ""), oldWc = countWords(oldText);
  const st = job.storyState;
  const prompt = buildRewritePrompt({
    chapterNumber: n, storyControl: storyControlPrompt(st),
    contract: String(st.directive || "") + "\n" + String(st.nextChapterHint || ""), contractLabel: "BRIEF",
    context: buildContext(st), review, draft: chapter.text
  });
  try {
    const r = await callWithRetry({
      endpoint: job.apiEndpoint, apiKey: job.apiKey, model: chapter.modelUsed || job.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
      maxTokens: 16000, temperature: 0.55, totalMs: Math.max(45000, Math.min(240000, writeTimeLeft(false) - 10000)), creative: true
    }, 1);
    let text = String(r.text || "").trim().replace(/^\s*(?:TIÊU ĐỀ|TITLE)\s*:\s*[^\n]+\n+/i, "").replace(/^\s*NỘI DUNG\s*:\s*/i, "").trim();
    text = formatParagraphs(stripForeign(dedupeRepeatedScene(text)));
    const cap = trimToWordLimit(text, chapterWordLimits(st).hardMax);
    const newWc = countWords(cap.text);
    const acc = checkRewriteAcceptable(oldWc, cap.text, newWc);
    if (!acc.ok) return acc;
    backupBeforeRewrite(chapter, "Trước khi Quality Gate sửa");
    { const tl = trimToLastSentence(cap.text, 0.8); if (tl.cut) { cap.text = tl.text; } }
    chapter.text = cap.text; chapter.wordCount = countWords(cap.text); chapter.truncated = chapter.truncated || cap.trimmed;
    return { ok: true };
  } catch (e) { return { ok: false, reason: (e && e.message) || "lỗi gọi AI" }; }
}
async function runWorkerQualityGate(job, chapter, n) {
  return runGateLoop(chapter, {
    review: () => qualityReviewWorker(job, chapter, n),
    rewrite: (review) => rewriteWorkerDraft(job, chapter, n, review),
    onStatus: (m) => { job.progress = m; }
  }, { enabled: job.storyState.qualityGateEnabled !== false, maxAttempts: job.storyState.qualityMaxAttempts });
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
    chapter.status = "DRAFTED";
    job.progress = "Đang chạy Quality Gate..."; job.updatedAt = Date.now(); await store.setJSON(jobId, cleanJobForStore(job));
    const gate = await runWorkerQualityGate(job, chapter, n);
    if (!gate.approved) {
      chapter.status = "REVISION_REQUIRED";
      chapter.review = chapter.review || { status: "error" };
      const failedState = JSON.parse(JSON.stringify(job.storyState));
      failedState.chapters.push(chapter);
      failedState.currentChapterIndex = failedState.chapters.length - 1;
      job.status = "completed";
      job.progress = "Quality Gate chưa đạt — bản nháp được giữ lại, chưa Sync Canon.";
      job.resultChapter = chapter;
      job.storyState = failedState;
      job.qualityGateFailed = true;
      job.error = gate.error || "Quality Gate chưa đạt";
      job.updatedAt = Date.now(); job.completedAt = Date.now();
      job.apiKey = null; job.apiKeyEncrypted = null;
      await store.setJSON(jobId, cleanJobForStore(job));
      return jsonResponse(200, { success: true, jobId, status: "completed", qualityGateFailed: true, chapterTitle: chapter.title, wordCount: chapter.wordCount });
    }
    job.progress = "Quality PASS — đang cập nhật Canon..."; job.updatedAt = Date.now(); await store.setJSON(jobId, cleanJobForStore(job));
    // Chỉ sau Quality PASS mới chạy summary/state/memory và Sync.
    const summaryP = generateSummary(job, chapter, n).then(s => { chapter.summary = s; return s; }).catch(() => { chapter.summary = chapter.summary || ""; return ""; });
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
      runPar("Thế giới", () => updateWorld(job, chapter, n, newState)),
      summaryP
    ]);
    await checkpoint("Đang cập nhật Status + Memory + Scene...");
    await Promise.all([
      runPar("Status", () => updateCurrentStatus(job, chapter, n, newState)),
      runPar("Memory", () => updateLongMemory(job, chapter, n, newState)),
      runPar("Scene", () => scanScenes(job, chapter, n, newState)),
      runPar("Gợi ý chương sau", async () => {
        const hint = await generateNextChapterHint(job, chapter, chapter.summary, n, newState);
        if (hint) newState.nextChapterHint = hint;
        return { ok: !!hint, notes: [hint ? "Gợi ý chương sau: đã cập nhật" : "Gợi ý chương sau: bỏ trống (lỗi hoặc rỗng)"], problems: [] };
      })
    ]);
    await checkpoint("Đang lưu kết quả...");
    applyCanonSync(newState, chapter);
    job.progress = "Đã Sync Canon v" + newState.canonVersion;

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
