import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const legacy=require('./write-chapter-background.cjs');

export class BackgroundJob {
  constructor(state, env){this.state=state;this.env=env;}
  async fetch(req){
    const url=new URL(req.url);
    if(url.pathname!=='/run')return new Response('Not found',{status:404});
    const body=await req.text();
    const env=this.env;
    this.state.waitUntil(this.runLegacy(body,env));
    return new Response(JSON.stringify({accepted:true}),{status:202,headers:{'content-type':'application/json'}});
  }
  async runLegacy(body,env){
    globalThis.__BG_ENV=env;
    if(!globalThis.process)globalThis.process={env:globalThis.__BG_ENV};else globalThis.process.env=globalThis.__BG_ENV;
    try{
      const result=await legacy.handler({httpMethod:'POST',body,headers:{'x-worker-token':JSON.parse(body).workerToken||''}});
      if(result?.statusCode>=400)console.error('Background legacy failed',result);
    }catch(e){console.error('Background runner error',e);throw e;}
  }
}