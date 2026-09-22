const { getStore, connectLambda } = require("@netlify/blobs");

function getJobStore(event) {
  // Bắt buộc với Netlify Functions (Lambda runtime)
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
      "Vào Netlify → Site settings → Environment variables, thêm NETLIFY_SITE_ID và NETLIFY_API_TOKEN. " +
      "Hoặc đảm bảo site đã deploy thành công trên Netlify."
    );
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const {
      storyState,
      apiKey,
      apiEndpoint = "https://openrouter.ai/api/v1/chat/completions",
      model = "deepseek/deepseek-v3.2",
      modelNsfw = "aion-labs/aion-2.0",
      forceNsfw = false
    } = body;

    if (!storyState || !apiKey) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Thiếu storyState hoặc apiKey" })
      };
    }

    const jobId = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const store = getJobStore(event);

    const job = {
      jobId,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      apiEndpoint,
      model,
      modelNsfw,
      forceNsfw: !!forceNsfw,
      apiKey: apiKey.trim(),
      storyState,
      resultChapter: null,
      error: null,
      progress: "Đang chờ bắt đầu..."
    };

    await store.setJSON(jobId, job);

    // Kích hoạt background
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "";
    if (siteUrl) {
      fetch(siteUrl + "/.netlify/functions/write-chapter-background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId })
      }).catch(err => console.error("Background trigger error:", err.message));
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        success: true,
        jobId,
        message: "Job đã được tạo. Bạn có thể tắt máy. Khi mở lại trang sẽ tự đồng bộ."
      })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: err.message || "Lỗi server" })
    };
  }
};
