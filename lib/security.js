// Tiện ích bảo mật dùng chung cho create-job / job-status (esbuild sẽ bundle khi deploy).
const crypto = require("crypto");

const sha = (v) => crypto.createHash("sha256").update(String(v == null ? "" : v)).digest();
function timingEqual(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); } // so sánh băm 32 byte -> luôn cùng độ dài

// ---- Khóa truy cập (tuỳ chọn): đặt biến môi trường APP_PASSCODE trên Netlify ----
function checkPasscode(event, body, env = process.env) {
  const need = env.APP_PASSCODE;
  if (!need) return { ok: true, enforced: false };
  const h = (event && event.headers) || {};
  const given = h["x-app-passcode"] || h["X-App-Passcode"] || (body && body.passcode) || "";
  return { ok: timingEqual(given, need), enforced: true };
}

// ---- Kiểm tra endpoint API: chặn SSRF, chỉ https, có thể giới hạn theo ALLOWED_API_HOSTS ----
function isPrivateHost(h) {
  h = String(h).toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}
function validateEndpoint(raw, env = process.env) {
  let u;
  try { u = new URL(String(raw || "")); } catch (_) { return { ok: false, error: "Endpoint API không hợp lệ." }; }
  const allowInsecure = env.ALLOW_INSECURE_ENDPOINT === "1";
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) return { ok: false, error: "Endpoint API phải dùng https." };
  if (u.username || u.password) return { ok: false, error: "Endpoint API không được chứa user/password." };
  if (!allowInsecure && isPrivateHost(u.hostname)) return { ok: false, error: "Endpoint API trỏ tới địa chỉ nội bộ — bị chặn." };
  const list = String(env.ALLOWED_API_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) {
    const host = u.hostname.toLowerCase();
    if (!list.some((a) => host === a || host.endsWith("." + a))) return { ok: false, error: "Endpoint API không nằm trong danh sách được phép (ALLOWED_API_HOSTS)." };
  }
  return { ok: true, url: u.toString() };
}

// ---- Dọn job cũ: jobId = "job_<base36 timestamp>_<hex>" nên tuổi job đọc được ngay từ key ----
function jobAgeMs(jobId, now = Date.now()) {
  const m = /^job_([0-9a-z]+)_/.exec(String(jobId || ""));
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  return Number.isFinite(ts) ? now - ts : null;
}
function jobTtlMs(env = process.env) {
  const h = Number(env.JOB_TTL_HOURS);
  return Math.max(1, Number.isFinite(h) && h > 0 ? h : 48) * 3600 * 1000;
}
async function purgeOldJobs(store, { ttlMs = jobTtlMs(), now = Date.now(), max = 50 } = {}) {
  let deleted = 0;
  try {
    const listing = await store.list();
    const blobs = (listing && listing.blobs) || [];
    for (const b of blobs) {
      if (deleted >= max) break;
      const age = jobAgeMs(b.key, now);
      if (age !== null && age > ttlMs) { try { await store.delete(b.key); deleted++; } catch (_) {} }
    }
  } catch (_) { /* dọn dẹp là best-effort, không được làm hỏng luồng chính */ }
  return deleted;
}

// ---- Cảnh báo cấu hình để hiện cho người dùng ----
function securityWarnings(env = process.env) {
  const w = [];
  if (!(env.JOB_SECRET || env.NETLIFY_JOB_SECRET || env.NETLIFY_API_TOKEN)) w.push("Chưa đặt JOB_SECRET trên Netlify: API key đang lưu KHÔNG mã hóa trong Blobs cho tới khi job xong.");
  if (!env.APP_PASSCODE) w.push("Chưa đặt APP_PASSCODE trên Netlify: bất kỳ ai biết địa chỉ site đều có thể tạo job (tốn tài nguyên của bạn).");
  return w;
}

module.exports = { timingEqual, checkPasscode, isPrivateHost, validateEndpoint, jobAgeMs, jobTtlMs, purgeOldJobs, securityWarnings };
