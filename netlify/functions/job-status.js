const { getStore, connectLambda } = require("@netlify/blobs");

function getJobStore(event) {
  if (event) {
    try { connectLambda(event); } catch (e) {}
  }
  try {
    return getStore("story-jobs");
  } catch (e1) {
    const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
    if (siteID && token) {
      return getStore({ name: "story-jobs", siteID, token });
    }
    throw new Error(
      "Netlify Blobs chưa cấu hình. " +
      "Vào Netlify → Site settings → Environment variables, thêm NETLIFY_SITE_ID và NETLIFY_API_TOKEN."
    );
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: ""
    };
  }

  const jobId = event.queryStringParameters?.jobId;
  if (!jobId) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Missing jobId" })
    };
  }

  try {
    const store = getJobStore(event);
    const job = await store.get(jobId, { type: "json" });

    if (!job) {
      return {
        statusCode: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Job not found" })
      };
    }

    const safe = {
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt || null,
      error: job.error || null,
      resultChapter: job.resultChapter || null,
      newChapterCount: job.storyState?.chapters?.length || 0
    };

    if (job.status === "completed" && job.storyState) {
      safe.storyState = job.storyState;
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(safe)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message })
    };
  }
};
