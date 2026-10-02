const ENGINE_COMMIT = "a133e004a5466085bc5807891aa570e103c840f0";
const ENGINE_URL = `https://raw.githubusercontent.com/nhockwayn02-cloud/truyen-ai/${ENGINE_COMMIT}/netlify/functions/write-chapter-background.js`;
const SECURITY_URL = `https://raw.githubusercontent.com/nhockwayn02-cloud/truyen-ai/${ENGINE_COMMIT}/lib/security.js`;

function makeEvent(request, body) {
  const u = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  return {
    httpMethod: request.method,
    headers,
    queryStringParameters: Object.fromEntries(u.searchParams),
    body: JSON.stringify(body || {})
  };
}

async function loadEngine(env) {
  return env.LOADER.get(`background-${ENGINE_COMMIT}`, async () => {
    const [engineRes, securityRes] = await Promise.all([fetch(ENGINE_URL), fetch(SECURITY_URL)]);
    if (!engineRes.ok) throw new Error(`Không tải được Background Engine (${engineRes.status})`);
    if (!securityRes.ok) throw new Error(`Không tải được security.js (${securityRes.status})`);
    const engine = await engineRes.text();
    const security = await securityRes.text();

    const blobsShim = `
      function store(){
        if (!globalThis.__STORY_JOBS) throw new Error('STORY_JOBS binding chưa sẵn sàng');
        return globalThis.__STORY_JOBS;
      }
      function getStore(){
        const kv = store();
        return {
          async get(key, opts){
            if (opts && opts.type === 'json') return kv.get(key, {type:'json'});
            return kv.get(key);
          },
          async getJSON(key){ return kv.get(key, {type:'json'}); },
          async setJSON(key, value){ return kv.put(key, JSON.stringify(value)); },
          async set(key, value){ return kv.put(key, typeof value === 'string' ? value : JSON.stringify(value)); },
          async delete(key){ return kv.delete(key); },
          async list(opts){ return kv.list(opts || {}); }
        };
      }
      function connectLambda(){ return; }
      module.exports = { getStore, connectLambda };
    `;

    const wrapper = `
      const engine = require('./engine.js');
      function responseFromEvent(result){
        return new Response(result.body || '', {status: result.statusCode || 200, headers: result.headers || {'content-type':'application/json'}});
      }
      module.exports = {
        async fetch(request){
          const body = request.method === 'GET' ? {} : await request.json().catch(()=>({}));
          globalThis.__STORY_JOBS = globalThis.__STORY_JOBS_BINDING;
          const result = await engine.handler(${makeEvent.toString()}(request, body));
          return responseFromEvent(result);
        }
      };
    `;

    return {
      compatibilityDate: '2026-10-02',
      compatibilityFlags: ['nodejs_compat', 'nodejs_compat_populate_process_env'],
      mainModule: 'entry.js',
      modules: {
        'entry.js': wrapper,
        'engine.js': engine,
        'lib/security.js': security,
        'node_modules/@netlify/blobs/index.js': blobsShim
      }
    };
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return Response.json({ok:true, service:'truyen-ai-background', engineCommit:ENGINE_COMMIT});
    }
    const worker = await loadEngine(env);
    worker; // keep loader warm for health/HTTP debugging
    return new Response(JSON.stringify({ok:true, service:'truyen-ai-background', engineCommit:ENGINE_COMMIT}), {headers:{'content-type':'application/json'}});
  },

  async queue(batch, env) {
    const worker = await loadEngine(env);
    for (const msg of batch.messages) {
      const jobId = typeof msg.body === 'string' ? msg.body : msg.body?.jobId;
      if (!jobId) { msg.ack(); continue; }
      try {
        globalThis.__STORY_JOBS = env.STORY_JOBS;
        globalThis.__STORY_JOBS_BINDING = env.STORY_JOBS;
        const req = new Request('https://background.internal/run', {
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({jobId, workerToken: msg.body?.workerToken || ''})
        });
        await worker.getEntrypoint().fetch(req);
        msg.ack();
      } catch (err) {
        console.error('background queue error', jobId, err);
        msg.retry();
      }
    }
  }
};
