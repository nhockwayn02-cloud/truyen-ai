/* V13.1 Cloudflare compatibility alias for the legacy Netlify URL. */
export async function onRequest(context) {
  const req = context.request;
  const target = new URL('/api/bg/create-job', req.url);
  return fetch(target, new Request(req, { headers: req.headers }));
}
