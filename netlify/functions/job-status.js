const { getStore } = require("@netlify/blobs");

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
    const store = getStore("story-jobs");
    const job = await store.get(jobId, { type: "json" });

    if (!job) {
      return {
        statusCode: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Job not found" })
      };
    }

    // Không trả apiKey về client
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

    // Khi completed → trả luôn toàn bộ storyState đã cập nhật (Character, Status, Scene...)
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
