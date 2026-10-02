/* Xưởng Truyện AI — Cloudflare Pages compatibility middleware
 *
 * The current v14 HTML was originally wired to call OpenRouter directly and
 * to use the old Netlify background-function path. The repository now runs
 * on Cloudflare Pages. This middleware keeps the large legacy index.html
 * intact while rewriting those two runtime endpoints at delivery time.
 *
 * Result:
 *   Browser -> /api/ai -> Cloudflare Pages Function -> OpenRouter
 *   Browser -> /api/bg/* -> Cloudflare Pages Function
 *
 * This is intentionally limited to HTML responses so API responses/assets
 * are not modified.
 */
export async function onRequest(context) {
  const response = await context.next();
  const type = response.headers.get("content-type") || "";
  if (!/text\/html/i.test(type)) return response;

  const html = await response.text();
  const patched = html
    .replaceAll("https://openrouter.ai/api/v1/chat/completions", "/api/ai")
    .replaceAll("const endpoint = state.apiEndpoint || apiEndpointInput.value.trim();", "const endpoint = '/api/ai';")
    .replaceAll('const BG_FUNCTIONS_BASE = "/.netlify/functions";', 'const BG_FUNCTIONS_BASE = "/api/bg";');

  if (patched === html) return response;

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}
