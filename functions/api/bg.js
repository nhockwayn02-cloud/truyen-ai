/* Cloudflare Pages compatibility alias for older V13 clients that POST to /api/bg. */
export async function onRequest(context) {
  const req = context.request;
  const target = new URL('/api/bg/create-job', req.url);
  return fetch(target, new Request(req, { headers: req.headers }));
}
