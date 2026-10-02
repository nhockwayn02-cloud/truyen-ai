import { handler } from "../../../netlify/functions/write-chapter-background.js";

globalThis.__STORY_JOBS = null;
function eventFor(jobId, workerToken) { return { httpMethod:"POST", headers:{"content-type":"application/json"}, queryStringParameters:{}, body:JSON.stringify({jobId,workerToken}) }; }
export default {
  async fetch(){ return Response.json({ok:true,service:"truyen-ai-background",engine:"v13.1-cloudflare"}); },
  async queue(batch,env){
    globalThis.__STORY_JOBS=env.STORY_JOBS;
    for(const message of batch.messages){
      const data=typeof message.body==="string"?{jobId:message.body}:(message.body||{});
      if(!data.jobId){message.ack();continue;}
      try{
        const result=await handler(eventFor(data.jobId,data.workerToken||""));
        if(result?.statusCode>=400){console.error("Background engine failed",data.jobId,result);message.retry();}
        else message.ack();
      }catch(error){console.error("Background queue exception",data.jobId,error);message.retry();}
    }
  }
};
