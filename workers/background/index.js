export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      const job = message.body;
      try {
        if (!job?.jobId) throw new Error('Invalid background job');
        const current = await env.STORY_JOBS.get(job.jobId, 'json');
        if (!current) throw new Error('Job not found');
        current.status = 'processing';
        current.updatedAt = new Date().toISOString();
        await env.STORY_JOBS.put(job.jobId, JSON.stringify(current), { expirationTtl: 86400 });
        // V14 background engine is invoked here once its canonical module is exported.
        // Keep the queue consumer alive and observable until the V14 engine is wired.
        current.status = 'error';
        current.error = 'V14 background engine is not exported as a queue-consumer module yet.';
        current.updatedAt = new Date().toISOString();
        await env.STORY_JOBS.put(job.jobId, JSON.stringify(current), { expirationTtl: 86400 });
        message.ack();
      } catch (err) {
        try { message.retry(); } catch {}
      }
    }
  }
};
