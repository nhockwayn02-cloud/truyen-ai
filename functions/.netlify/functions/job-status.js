/* V13.1 Cloudflare compatibility alias for the legacy Netlify URL. */
export async function onRequest(context) {
  const req = context.request;
  const target = new URL('/api/bg/job-status', req.url);
  target.search = new URL(req.url).search;
  return fetch(target, new Request(req, { headers: req.headers }));
}
