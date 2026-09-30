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

// V12.3: hard cap để mục tiêu 5.000 từ không biến thành 8.000+ từ.
function chapterWordLimits(state) {
  const target = Math.min(Math.max(Number(state?.minChapterWords) || 5000, 500), 6000);
  return { target, hardMax: Math.ceil(target * 1.15) };
}
function trimToWordLimit(text, maxWords) {
  const s = String(text || "").trim();
  if (!s || countWords(s) <= maxWords) return { text: s, trimmed: false };
  const words = s.split(/\s+/);
  let out = words.slice(0, maxWords).join(" ");
  const m = out.match(/^([\s\S]*[.!?…][”"’']?)(?:\s|$)/);
  if (m && countWords(m[1]) >= Math.max(1, maxWords - 180)) out = m[1];
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
  "KỸ THUẬT:",
  "- Chậm từng nhịp; không tóm tắt cao trào trong 1-2 câu.",
  "- Nhiều bộ phận cùng lúc (tay + miệng + cặc…).",
  "- 5 giác quan khi phù hợp; mùi/dịch/nhiệt độ.",
  "- Bám hồ sơ NV — cấm bịa số đo khác.",
  "- 100% tiếng Việt có dấu. Không meta, không spoiler chương sau."
].join("\n");

// v11 — Rào chắn tuổi (đồng bộ nguyên văn với index.html).
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

const EXPLICIT_PROMPTS = {
  subtle: "CẢNH 18+: Nhẹ nhàng — fade-to-black sau khi hôn, gợi ý chứ không tả. Cảm xúc chiếm ưu thế.",
  sensual: "CẢNH 18+: Gợi cảm — tả cảm xúc, hơi thở, ánh mắt, da chạm da; hạn chế tả bộ phận sinh dục chi tiết. Vẫn giàu sức gợi.",
  explicit: "CẢNH 18+: Rõ ràng — mô tả cơ thể và hành động cụ thể (hôn, sờ, cởi, tư thế). Có thể dùng từ trực tiếp khi cần. Show cảm giác qua da thịt và phản ứng.",
  strong: "CẢNH 18+: MẠNH — mỗi đoạn nóng cần: (1) bộ phận + hình thái/màu/số đo hồ sơ; (2) cảm giác thể xác cụ thể; (3) một nhịp nội tâm (xấu hổ/dục/kháng cự); (4) động tác + âm thanh. Ít ẩn dụ.",
  wild: "CẢNH 18+: CỰC MẠNH. Đủ 4 lớp (cơ thể+cảm giác+nội tâm+âm thanh/thoại). Không tóm tắt, không fade-to-black. Bám hồ sơ số đo."
};

/* ===== NSFW KEYWORD DETECT — đồng bộ với index.html, thay cho danh sách 6 từ cũ (quá hẹp) ===== */
const NSFW_KEYWORDS = [
  "cảnh nóng","cảnh sex","cảnh 18","cảnh 18+","quan hệ","làm tình","ân ái","giao hợp",
  "sex","sexx","sexy","nsfw","erotic","erotica","porn",
  "âu yếm","vuốt ve","mơn trớn","ve vuốt","hôn sâu","hôn môi","hôn cổ",
  "cởi đồ","cởi áo","cởi quần","không mặc","khỏa thân","trần truồng","nude",
  "sờ soạng","sờ ngực","sờ mông","nắn bóp","liếm","bú","thổi kèn",
  "dương vật","âm đạo","âm hộ","ngực","núm vú","mông","háng","cặc","lồn",
  "thúc","thúc mạnh","xuất tinh","orgasm","cao trào","khoái cảm",
  "doggy","missionary","cowgirl","oral","blowjob","handjob",
  "viết nóng","viết 18","tăng nhiệt","nóng hơn","cảnh ân ái","đêm tân hôn",
  "lần đầu","mất trinh","đoạt mất","chiếm đoạt cơ thể","ham muốn",
  "dục vọng","kích thích","nứng","phê","rên rỉ","rên la","rên ưỡn"
];
function textHasNsfwKeyword(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().normalize("NFC");
  return NSFW_KEYWORDS.some(k => t.includes(k));
}

/* v10.2.2: worker trước đây chỉ ép NSFW khi bắt được từ khóa trong directive/hint/tiêu đề —
 * không có bước "chấm nhiệt độ" như bản viết trực tiếp (index.html detectHeatLevel()).
 * Hệ quả: nếu cảnh nóng phát sinh tự nhiên từ mạch truyện (không có từ khóa tường minh
 * trong Mệnh lệnh/Định hướng), job nền âm thầm dùng model thường thay vì model NSFW dù
 * chế độ đang để "auto". Hàm dưới đây đồng bộ với client: chấm 0-10, so với ngưỡng đã cấu hình. */
function normalizeChapterMatureFocus(v) {
  const x = String(v || "none").toLowerCase();
  return x === "primary" || x === "secondary" ? x : "none";
}
function normalizeStoryControl(state) {
  const sc = (state && state.storyControl && typeof state.storyControl === "object") ? state.storyControl : {};
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
function storyControlPrompt(state) {
  const sc = normalizeStoryControl(state);
  return [
    "STORY CONTROL LAYER — BẮT BUỘC:",
    `- Ngân sách sự kiện: tối đa ${sc.maxMainEvents} sự kiện chính; không thêm biến cố lớn thứ ${sc.maxMainEvents + 1}.`,
    `- Nhân vật có tên xuất hiện trực tiếp: tối đa ${sc.maxNamedCharacters}; ưu tiên nhân vật đã tồn tại.`,
    `- Thread mới: tối đa ${sc.maxNewThreads}; không mở tuyến mới chỉ để kéo dài chương.`,
    "- Continuity: nguyên nhân → hành động → phản ứng → hậu quả phải nhất quán với trạng thái hiện tại.",
    sc.noRetcon ? "- NO RETCON: không tự sửa lịch sử, canon hoặc ký ức đã xác nhận. Nếu phát hiện mâu thuẫn, giữ nguyên dữ liệu cũ và đánh dấu xung đột để xử lý sau." : "",
    `- STATE LOCK: không tự ý thay đổi các trường canon/quan trọng (${sc.lockedFields.join(", ")}). Muốn thay đổi phải có sự kiện trong truyện làm bằng chứng và cập nhật trạng thái sau chương.`,
    sc.agencyRequired ? "- CHARACTER AGENCY: nhân vật quan trọng phải có mục tiêu, động cơ, phản ứng và lựa chọn riêng; không biến nhân vật thành công cụ của plot.": "",
    "- Không tự tạo nhân vật quan trọng mới nếu nhân vật hiện có có thể đảm nhiệm vai trò đó.",
    "- Không tạo năng lực, quy tắc thế giới hoặc vật phẩm quan trọng mới chỉ để giải quyết vấn đề tức thời.",
    "- Chapter Focus chỉ kiểm soát phạm vi chủ đề trưởng thành; không được dùng nó để mở rộng cốt truyện ngoài brief.",
    "- Nếu Directive/Story Bible/Current Status xung đột, không âm thầm sửa canon; ưu tiên dữ liệu canon và ghi nhận xung đột khi cần.",
    "- Mục tiêu là chiều sâu và tính liên tục, không phải nhồi thêm sự kiện."
  ].filter(Boolean).join("\n");
}

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
  if (state.nextChapterHint) p.push("ĐỊNH HƯỚNG CHO CHƯƠNG NÀY (nên bám theo, trừ khi mâu thuẫn với MỆNH LỆNH thì MỆNH LỆNH thắng):\n" + state.nextChapterHint);
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
  const prompt = [
    `VIẾT CHƯƠNG ${chapterNumber}. Truyện đã có ${chapters.length} chương.`,
    `MỤC TIÊU ${minWords} từ; GIỚI HẠN CỨNG ${maxWords} từ. Khi đạt khoảng ${minWords} từ và cảnh đã có điểm dừng tự nhiên thì phải kết thúc; tuyệt đối không kéo dài vượt ${maxWords} từ. ${DESCRIPTION_PROMPTS[state.descriptionLevel] || DESCRIPTION_PROMPTS.balanced}`,
    "Không mở đầu bằng tiêu đề, không giải thích ngoài truyện.",
    "Không lặp lại đoạn kết chương trước; phải tiếp nối nguyên nhân và hệ quả.",
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
    "KẾT THÚC: nếu gần đủ độ dài và cảnh đã có điểm dừng tự nhiên, kết thúc gọn tại điểm đó; không thêm biến cố mới chỉ để đủ số từ."
  ].filter(Boolean).join("\n\n");

  // V12.2: nhánh trưởng thành có ngân sách output lớn hơn để không bị cụt sau một đoạn.
  const writeLeft = writeTimeLeft(isNsfw);
  const mainMaxTokens = isNsfw ? 24000 : 16000;
  const mainCallBudget = Math.max(60000, Math.min(480000, writeLeft - 15000));
  let result = await callWithRetry({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], maxTokens: mainMaxTokens, temperature: 0.82, totalMs: mainCallBudget, creative: true }, 2);
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
  const initialCap = trimToWordLimit(text, maxWords);
  text = initialCap.text;
  const title = String(state.chapterTitle || state.currentChapterTitle || `Chương ${chapterNumber}`).trim() || `Chương ${chapterNumber}`;
  let truncated = result.finishReason === "length";
  const issues = [];
  let attempts = 0;
  chapter.control = { focus: matureFocus, maxMainEvents: normalizeStoryControl(state).maxMainEvents, maxNamedCharacters: normalizeStoryControl(state).maxNamedCharacters, noRetcon: normalizeStoryControl(state).noRetcon };

  // V12.2: nếu là nhánh trưởng thành, cho phép tối đa 8 lượt nối tiếp bất kể cấu hình cũ
  // chỉ đặt 4. Mỗi lượt vẫn dùng chính model đã route ở trên.
  const configuredAttempts = Number(state.autoContinueMax) || 4;
  const maxAttempts = isNsfw ? Math.max(4, Math.min(8, configuredAttempts)) : Math.max(0, Math.min(8, configuredAttempts));
  while (countWords(text) < minWords && countWords(text) < maxWords && attempts < maxAttempts) {
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
          "STYLE LOCK — PHẦN ĐẦU CHƯƠNG (chỉ dùng để giữ giọng, không lặp nội dung):", text.slice(0, 1800),
          "ĐOẠN CUỐI:", tail,
          "Giữ nguyên giọng văn, nhịp câu, POV, thì kể và xưng hô của STYLE LOCK + đoạn cuối. Bắt đầu ngay sau câu cuối; không nhắc lại phần đã viết.",
          "Chỉ trả văn xuôi tiếp theo."
        ].join("\n\n") }],
        maxTokens: isNsfw ? 12000 : 9000, temperature: 0.82, totalMs: Math.max(45000, Math.min(420000, writeTimeLeft(isNsfw) - 12000)), creative: true
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
      const remaining = maxWords - current;
      if (remaining <= 0) break;
      const capped = trimToWordLimit(contText, remaining);
      text = text.replace(/\s+$/, "") + "\n\n" + capped.text;
      truncated = cont.finishReason === "length" || capped.trimmed;
      if (capped.trimmed) break;
    } catch (e) { issues.push(`Viết tiếp #${attempts}: ${e.message}`); break; }
  }
  text = stripForeign(text);
  const finalCap = trimToWordLimit(text, maxWords);
  text = finalCap.text;
  if (finalCap.trimmed) issues.push(`Đã khóa độ dài: tối đa ${maxWords} từ`);
  const wordCount = countWords(text);
  if (wordCount < minWords * 0.9) issues.push(`Thiếu từ: ${wordCount}/${minWords}`);
  return { title, text, wordCount, truncated, plan: "", continuityWarnings: [], modelUsed: model, isNsfw, routingModel: model, routingReason: job.forceNsfw ? "forced" : (hotKeyword ? "keyword" : (isNsfw ? "heat" : "normal")), polished: false, summary: "", versions: [], compressed: false, createdBy: "background-v12.3", createdAt: Date.now(), autoUpdateIssues: issues, minWordsTarget: minWords };
}

/* V12.10: chống tóm tắt bịa — kiểm tra tên/từ trong bản tóm tắt có thật trong chương không. */
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
function buildSummaryPrompt(text, n, names){
  return [
    "Bạn là bộ máy tóm tắt. Chỉ được dựa vào văn bản trong thẻ <chuong>; không có kiến thức nào khác về truyện này.",
    "<chuong>", text, "</chuong>",
    "NHIỆM VỤ: tóm tắt CHƯƠNG "+n+" trên đây theo đúng trình tự diễn ra.",
    "1) Chỉ dùng nhân vật, địa điểm, đồ vật, giờ giấc, lời thoại CÓ trong <chuong>. Không thêm, không suy diễn. Nếu chương không nêu giờ giấc hay chức danh thì KHÔNG ghi.",
    names && names.length ? "2) Tên nhân vật xuất hiện trong chương (chỉ dùng đúng các tên này): "+names.join(", ")+"." : "2) Dùng đúng tên nhân vật như viết trong chương.",
    "3) Định dạng: mở đầu bằng dòng \"**Tóm tắt chương:**\", rồi 1 câu nêu mạch chính, sau đó 4-5 đoạn ngắn theo diễn biến (mỗi đoạn một cảnh/mốc). Không dùng nhãn Đầu/Giữa/Cuối, không gạch đầu dòng, không mô tả tiêu chí tóm tắt.",
    "4) Với cảnh nhạy cảm (18+/bạo lực/cưỡng ép): thuật lại ngắn gọn, trung lập ai làm gì với ai, câu nói/mệnh lệnh chính và hệ quả — không bỏ cảnh, không thêm chi tiết ngoài văn bản.",
    "5) Câu cuối: trạng thái cuối chương theo đúng văn bản.",
    "6) Độ dài 300-400 từ tiếng Việt, tối đa 400. Chỉ trả về bản tóm tắt."
  ].join("\n");
}
function summaryRetryNote(g){
  return "\n\nLỖI LẦN TRƯỚC: bản tóm tắt chứa nội dung KHÔNG có trong <chuong>"+(g.bad&&g.bad.length?" (tên không có trong chương, cấm dùng: "+g.bad.join(", ")+")":"")+". Viết lại: bắt đầu bằng \"**Tóm tắt chương:**\" rồi chỉ kể lại các sự kiện có thật trong <chuong>.";
}

async function generateSummary(job, chapter, n) {
  try {
    const full = String(chapter.text || "");
    const body = representativeText(full, 90000);
    const names = summaryNameList(full, (job.storyState && job.storyState.characters) || []);
    const fullPrompt = buildSummaryPrompt(body, n, names);
    const ask = async (content, temp, tries) => {
      const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content }], maxTokens: 1400, temperature: temp }, tries);
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
    const prompt = [
      `Bạn vừa đọc xong CHƯƠNG ${n} (tóm tắt bên dưới). Hãy viết GỢI Ý CHI TIẾT cho CHƯƠNG ${n + 1}.`,
      "YÊU CẦU ĐỊNH DẠNG: mở đầu bằng dòng \"**Gợi ý ngắn Chương " + (n + 1) + ":**\", sau đó 4-6 đoạn văn ngắn, mỗi đoạn là một cảnh/nhịp truyện theo đúng thứ tự diễn ra: (1) mở chương, (2) cảnh chính, (3) cảnh phát triển/căng thẳng, (4) cú chốt cuối chương.",
      "Mỗi đoạn phải dùng TÊN NHÂN VẬT cụ thể, nêu rõ hành động, địa điểm, xung đột, cảm xúc và hệ quả — KHÔNG nói chung chung kiểu \"nên khai thác thêm tuyến X\".",
      "Bám sát giọng điệu, thể loại, mức độ nóng/18+ và cách xưng hô mà chính truyện này đang dùng; tiếp nối trực tiếp các thread và foreshadowing đang mở, không tự mở tuyến mới lạc đề. Mở chương phải nối trực tiếp từ đoạn kết chương trước; các mốc đã hẹn (giờ họp, lệnh, hạn chót) phải được xử lý.",
      "HƯỚNG CHƯƠNG SAU: " + (HINT_STYLES[job.hintStyle] || HINT_STYLES.normal),
      "ĐOẠN KẾT CHƯƠNG (để nối mạch):", String(chapter.text || "").slice(-1500),
      "TÓM TẮT:", summary || representativeText(chapter.text, 2000),
      openThreads ? ("THREADS ĐANG MỞ:\n" + openThreads) : "",
      openForeshadowing ? ("FORESHADOWING CHƯA GIẢI:\n" + openForeshadowing) : "",
      "Chỉ trả về nội dung gợi ý theo định dạng trên, tiếng Việt."
    ].filter(Boolean).join("\n\n");
    const r = await callExtract({ endpoint: job.apiEndpoint, apiKey: job.apiKey, model: job.model, messages: [{ role: "user", content: prompt }], maxTokens: 1400, temperature: 0.7 }, 2);
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
    const coreLocked = c.coreLocked !== false;
    const coreFields = ["name","age","gender","appearance","personality","goals","role","position","occupation","faction"];
    const accum = ["appearance","personality","goals","secret","weakness","fear","knowledge"];
    if(!c.coreIdentity || typeof c.coreIdentity !== "object") c.coreIdentity={};
    if(coreLocked){
      coreFields.forEach(k=>{ if(c.coreIdentity[k] === undefined) c.coreIdentity[k] = c[k] || ""; });
    }
    accum.forEach(k => { if (u[k] && (!coreLocked || !coreFields.includes(k))) { c[k] = mergeTextField(c[k], u[k]); if (!coreLocked && coreFields.includes(k)) c.coreIdentity[k] = c[k]; } });
    ["role","relevanceToMC","occupation","faction"].forEach(k => { if (u[k] && (!coreLocked || !coreFields.includes(k))) c[k] = u[k]; });
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
      "Tối đa 12 nhân vật; mỗi trường mô tả (appearance/personality/goals/knowledge) khoảng 30-60 từ, cụ thể (đặc điểm, hành vi, chi tiết mới lộ ra trong phần này); chỉ ghi điểm MỚI so với mục \"hiện có\", không lặp lại hồ sơ cũ; NV đang [KHÓA HỒ SƠ GỐC] thì để trống appearance/personality/goals. Không dùng dấu \" bên trong giá trị chuỗi. Chỉ trả về JSON array.",
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
        return;
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
    job.progress = "Đang tạo tóm tắt + cập nhật..."; job.updatedAt = Date.now(); await store.setJSON(jobId, cleanJobForStore(job));
    // v11.1: tóm tắt chạy song song với NV/Thế giới (chỉ bước "Gợi ý chương sau" cần summary nên đợi ở pha 2).
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
