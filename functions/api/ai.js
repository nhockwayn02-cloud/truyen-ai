/* Xưởng Truyện AI — Cloudflare Pages AI proxy
 * Browser -> /api/ai -> OpenRouter
 *
 * The frontend keeps its existing OpenRouter-compatible request body and
 * Authorization header. This Function removes the browser-to-OpenRouter
 * CORS/deployment dependency and keeps the API hop inside Cloudflare.
 *
 * A server-side OPENROUTER_API_KEY may optionally be configured in
 * Cloudflare Pages. If present, it is used instead of the client key.
 */
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-App-Passcode",
    "Cache-Control": "no-store",
    ...extra
  };
}

export async function onRequest(context) {
  const req = context.request;
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "AI proxy chỉ nhận POST." }, { status: 405, headers: cors() });
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return Response.json({ error: "Request body không phải JSON hợp lệ." }, { status: 400, headers: cors() });
  }

  if (!body || !body.model || !Array.isArray(body.messages)) {
    return Response.json({ error: "Thiếu model hoặc messages." }, { status: 400, headers: cors() });
  }

  const clientAuth = req.headers.get("authorization") || "";
  const serverKey = String(context.env.OPENROUTER_API_KEY || "").trim();
  const auth = serverKey ? "Bearer " + serverKey : clientAuth;
  if (!auth) {
    return Response.json({ error: "Chưa có OpenRouter API key. Nhập API key trong ứng dụng hoặc cấu hình secret OPENROUTER_API_KEY trên Cloudflare Pages." }, { status: 401, headers: cors() });
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": auth,
    "HTTP-Referer": new URL(req.url).origin,
    "X-Title": "Xuong Truyen AI Pro Max v14"
  };

  try {
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const outHeaders = cors({
      "Content-Type": upstream.headers.get("content-type") || "application/json"
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders
    });
  } catch (err) {
    return Response.json({
      error: "Cloudflare không kết nối được OpenRouter: " + (err?.message || String(err))
    }, { status: 502, headers: cors() });
  }
}
