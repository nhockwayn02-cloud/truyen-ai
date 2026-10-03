/* Legacy V13 endpoint compatibility on Cloudflare Pages. */
export async function onRequest(context) {
  const req = context.request;
  const target = new URL('/api/bg/create-job', req.url);
  return fetch(target, new Request(req, { headers: req.headers }));
}
