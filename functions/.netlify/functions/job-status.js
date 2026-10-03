/* Legacy V13 endpoint compatibility on Cloudflare Pages. */
export async function onRequest(context) {
  const req = context.request;
  const url = new URL('/api/bg/job-status', req.url);
  url.search = new URL(req.url).search;
  return fetch(url, new Request(req, { headers: req.headers }));
}
