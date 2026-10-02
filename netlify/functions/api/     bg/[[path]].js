/*
 * Xưởng Truyện AI V14 — Cloudflare Pages proxy
 *
 * This proxy keeps the existing, battle-tested Netlify background engine.
 * The frontend on Cloudflare calls /api/bg/*; this Function forwards only
 * create-job and job-status to the Netlify backend configured by
 * BG_BACKEND_URL.
 *
 * Configure in Cloudflare Pages:
 *   BG_BACKEND_URL = https://YOUR-NETLIFY-SITE.netlify.app
 *
 * Do NOT put an API key here. The user's API key is sent only in the
 * authenticated create-job request and is handled by the existing backend.
 */
const ALLOWED = new Set(["create-job", "job-status"]);

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Passcode",
    "Cache-Control": "no-store",
    ...extra
  };
}

export async function onRequest(context) {
  const req = context.request;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

  const parts = context.params?.path;
  const path = Array.isArray(parts) ? parts.join("/") : String(parts || "");
  if (!ALLOWED.has(path)) {
    return Response.json({ error: "Cloudflare BG proxy: endpoint không được phép." }, { status: 404, headers: cors() });
  }

  const raw = String(context.env.BG_BACKEND_URL || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return Response.json({
      error: "Chưa cấu hình BG_BACKEND_URL trên Cloudflare Pages. Hãy đặt URL site Netlify đang chứa backend Viết nền."
    }, { status: 500, headers: cors() });
  }

  let base;
  try {
    base = new URL(raw);
    if (base.protocol !== "https:") throw new Error("BG_BACKEND_URL phải dùng https://");
  } catch (err) {
    return Response.json({ error: "BG_BACKEND_URL không hợp lệ: " + err.message }, { status: 500, headers: cors() });
  }

  const target = new URL(base.toString());
  target.pathname = `/ .netlify/functions/${path}`.replace("/ ", "/");
  target.search = new URL(req.url).search;

  const headers = new Headers();
  for (const name of ["content-type", "authorization", "x-app-passcode"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Accept", "application/json");

  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;

  try {
    const upstream = await fetch(target.toString(), init);
    const outHeaders = cors({ "Content-Type": upstream.headers.get("content-type") || "application/json" });
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  } catch (err) {
    return Response.json({ error: "Không kết nối được backend Viết nền: " + (err.message || err) }, { status: 502, headers: cors() });
  }
}
