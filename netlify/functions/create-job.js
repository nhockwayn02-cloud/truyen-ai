const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  // CORS preflight
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
      storyState,          // toàn bộ state hiện tại (không chứa apiKey)
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

    // Tạo jobId
    const jobId = "job_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

    const store = getStore("story-jobs");

    const job = {
      jobId,
      status: "pending",          // pending | running | completed | failed
      createdAt: Date.now(),
      updatedAt: Date.now(),
      apiEndpoint,
      model,
      modelNsfw,
      forceNsfw: !!forceNsfw,
      // Lưu key tạm thời (sẽ xóa sau khi xong)
      apiKey: apiKey.trim(),
      // Snapshot state
      storyState,
      // Kết quả
      resultChapter: null,
      error: null,
      progress: "Đang chờ bắt đầu..."
    };

    await store.setJSON(jobId, job);

    // Kích hoạt background function bằng cách gọi nội bộ
    // Netlify sẽ tự chạy background nếu tên function kết thúc bằng -background
    // Ở đây ta dùng cách invoke qua fetch nội bộ (đơn giản và ổn định)
    const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:8888";
    
    // Gọi background function (fire-and-forget)
    fetch(`${siteUrl}/.netlify/functions/write-chapter-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId })
    }).catch(err => {
      console.error("Không thể kích hoạt background:", err.message);
    });

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
