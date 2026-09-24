const fetch = require('node-fetch');

// ==========================================
// 0. CONFIG
// ==========================================
const CONFIG = {
  MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  MAX_TOKENS: 8192,           // tăng để tránh cắt cụt output
  TEMPERATURE: 0.7,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1500,
  BATCH_SIZE_NV: 2,
  BATCH_SIZE_WORLD: 2,
  CHAPTER_SLICE: 3000,        // ký tự chương đưa vào prompt NV/World
  MEMORY_OLD_SLICE: 1500,
  MEMORY_NEW_SLICE: 2000,
};

// ==========================================
// 1. SAFE JSON PARSE (ĐÃ SỬA LỖI REGEX HỎNG)
// ==========================================
function safeParseJSON(rawText) {
  if (!rawText) return null;

  // 1a. Parse trực tiếp
  try {
    return JSON.parse(rawText);
  } catch (e) {
    console.warn('[safeParseJSON] JSON lỗi/cắt cụt, đang phục hồi...');
  }

  let cleaned = String(rawText).trim();

  // 1b. Bóc khỏi markdown block nếu có
  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/i);
  if (fence && fence[1]) cleaned = fence[1].trim();

  // 1c. Cắt phần rác trước dấu { hoặc [ đầu tiên
  const firstBrace = cleaned.search(/[\{\[]/);
  if (firstBrace > 0) cleaned = cleaned.slice(firstBrace);

  // 1d. Bỏ dấu phẩy thừa ở cuối
  cleaned = cleaned.replace(/,\s*$/, '');

  // 1e. Bỏ chuỗi bị cắt cụt ở cuối (dấu " chưa đóng)
  //     Đếm số dấu " chưa escape — nếu lẻ thì cắt tới dấu " gần nhất
  const quoteCount = (cleaned.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    const lastQuote = cleaned.lastIndexOf('"');
    if (lastQuote > 0) cleaned = cleaned.slice(0, lastQuote);
    cleaned = cleaned.replace(/,\s*$/, '');
  }

  // 1f. Đóng ngoặc còn thiếu — ĐÃ SỬA (dòng gốc bị hỏng cú pháp)
  let openBraces = (cleaned.match(/\{/g) || []).length - (cleaned.match(/\}/g) || []).length;
  let openBrackets = (cleaned.match(/\[/g) || []).length - (cleaned.match(/\]/g) || []).length;

  while (openBraces > 0) { cleaned += '}'; openBraces--; }
  while (openBrackets > 0) { cleaned += ']'; openBrackets--; }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[safeParseJSON] Không thể phục hồi JSON:', err.message);
    return null;
  }
}

// ==========================================
// 2. GỌI AI VỚI RETRY + ÉP JSON
// ==========================================
async function callAIWithRetry(prompt, maxRetries = CONFIG.MAX_RETRIES) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error('[callAI] Thiếu OPENAI_API_KEY trong biến môi trường');
    return null;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: CONFIG.MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: CONFIG.MAX_TOKENS,
          response_format: { type: 'json_object' },
          temperature: CONFIG.TEMPERATURE,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} — ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      const finishReason = data.choices?.[0]?.finish_reason;

      const parsed = safeParseJSON(content);
      if (parsed) {
        if (finishReason === 'length') {
          console.warn('[callAI] Cảnh báo: output bị cắt do hết token (finish_reason=length)');
        }
        return parsed;
      }

      throw new Error('Response không parse được thành JSON');
    } catch (error) {
      console.error(`[callAI] Lỗi (lần ${attempt}/${maxRetries}):`, error.message);
      if (attempt === maxRetries) return null;
      await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
    }
  }
  return null;
}

// ==========================================
// 3. MERGE THEO ID (THAY VÌ GHI ĐÈ BATCH)
// ==========================================
function mergeById(original, updated) {
  if (!Array.isArray(updated) || updated.length === 0) return original;
  const updatedMap = new Map();
  for (const item of updated) {
    if (item && item.id != null) updatedMap.set(String(item.id), item);
  }
  // Giữ nguyên thứ tự gốc, chỉ thay field của item có id khớp
  const merged = original.map(orig => {
    const up = updatedMap.get(String(orig.id));
    return up ? { ...orig, ...up } : orig;
  });
  // Item mới AI trả về mà không có trong gốc → thêm vào cuối
  for (const item of updated) {
    if (item && item.id != null && !original.some(o => String(o.id) === String(item.id))) {
      merged.push(item);
    }
  }
  return merged;
}

// ==========================================
// 4. XỬ LÝ THEO LÔ
// ==========================================
async function processBatches(items, batchSize, processFn, label = 'batch') {
  const results = [];
  const total = Math.ceil(items.length / batchSize);

  for (let i = 0; i < items.length; i += batchSize) {
    const batchIndex = Math.floor(i / batchSize) + 1;
    const batch = items.slice(i, i + batchSize);
    console.log(`[${label}] Đang xử lý lô ${batchIndex}/${total} (${batch.length} item)...`);

    const batchResult = await processFn(batch, batchIndex);

    if (batchResult) {
      if (Array.isArray(batchResult)) results.push(...batchResult);
      else results.push(batchResult);
    } else {
      console.warn(`[${label}] Lô ${batchIndex} thất bại — giữ nguyên dữ liệu gốc.`);
      results.push(...batch);
    }
  }
  return results;
}

// ==========================================
// 5. XỬ LÝ NHÂN VẬT
// ==========================================
async function processCharacters(characters, chapterContent) {
  if (!Array.isArray(characters) || characters.length === 0) return [];

  return processBatches(characters, CONFIG.BATCH_SIZE_NV, async (batch, idx) => {
    const prompt = `Bạn là trợ lý cập nhật trạng thái nhân vật cho truyện.

DANH SÁCH NHÂN VẬT CẦN CẬP NHẬT (JSON):
${JSON.stringify(batch, null, 2)}

NỘI DUNG CHƯƠNG MỚI:
${chapterContent.slice(0, CONFIG.CHAPTER_SLICE)}

YÊU CẦU:
- Cập nhật trạng thái, vị trí, quan hệ, kỹ năng... của TỪNG nhân vật dựa trên chương mới.
- GIỮ NGUYÊN "id" của từng nhân vật — không được đổi id.
- Nếu nhân vật không xuất hiện trong chương, trả về nguyên trạng dữ liệu cũ.
- Trả về ĐÚNG cấu trúc JSON sau, KHÔNG thêm chữ nào khác:
{"characters":[{"id":"<id gốc>","name":"...","status":"...","location":"...","relationships":"...","skills":"...","notes":"..."}]}

Chỉ trả về JSON. Bắt đầu ngay bằng dấu {.`;

    const res = await callAIWithRetry(prompt);
    const updated = res?.characters;

    if (!Array.isArray(updated)) {
      console.warn(`[NV] Lô ${idx}: AI không trả về mảng "characters" — giữ nguyên.`);
      return batch;
    }

    // Cảnh báo nếu AI trả thiếu item
    if (updated.length < batch.length) {
      console.warn(`[NV] Lô ${idx}: AI trả ${updated.length}/${batch.length} item — sẽ merge theo id.`);
    }

    const merged = mergeById(batch, updated);
    // Đối chiếu: nếu merge vẫn thiếu item so với batch gốc thì bổ sung
    return merged;
  }, 'NV');
}

// ==========================================
// 6. XỬ LÝ THẾ GIỚI
// ==========================================
async function processWorld(worldItems, chapterContent) {
  if (!Array.isArray(worldItems) || worldItems.length === 0) return [];

  return processBatches(worldItems, CONFIG.BATCH_SIZE_WORLD, async (batch, idx) => {
    const prompt = `Bạn là trợ lý cập nhật thiết lập thế giới cho truyện.

DANH SÁCH THIẾT LẬP CẦN CẬP NHẬT (JSON):
${JSON.stringify(batch, null, 2)}

NỘI DUNG CHƯƠNG MỚI:
${chapterContent.slice(0, CONFIG.CHAPTER_SLICE)}

YÊU CẦU:
- Cập nhật thông tin (mô tả, trạng thái, mức độ ảnh hưởng...) của TỪNG mục dựa trên chương mới.
- GIỮ NGUYÊN "id" của từng mục — không được đổi id.
- Nếu mục không xuất hiện trong chương, trả về nguyên trạng dữ liệu cũ.
- Trả về ĐÚNG cấu trúc JSON sau, KHÔNG thêm chữ nào khác:
{"world":[{"id":"<id gốc>","name":"...","type":"...","description":"...","status":"...","notes":"..."}]}

Chỉ trả về JSON. Bắt đầu ngay bằng dấu {.`;

    const res = await callAIWithRetry(prompt);
    const updated = res?.world;

    if (!Array.isArray(updated)) {
      console.warn(`[World] Lô ${idx}: AI không trả về mảng "world" — giữ nguyên.`);
      return batch;
    }

    if (updated.length < batch.length) {
      console.warn(`[World] Lô ${idx}: AI trả ${updated.length}/${batch.length} item — sẽ merge theo id.`);
    }

    return mergeById(batch, updated);
  }, 'World');
}

// ==========================================
// 7. XỬ LÝ MEMORY
// ==========================================
async function processMemory(memory, chapterContent) {
  const oldMemory = (memory || '').slice(-CONFIG.MEMORY_OLD_SLICE);
  const newChapter = (chapterContent || '').slice(-CONFIG.MEMORY_NEW_SLICE);

  const prompt = `Bạn là trợ lý tóm tắt diễn biến truyện.

BỘ NHỚ CŨ:
${oldMemory || '(trống)'}

CHƯƠNG MỚI:
${newChapter}

YÊU CẦU:
- Viết bản tóm tắt diễn biến ngắn gọn (dưới 500 từ), giữ lại các sự kiện quan trọng.
- Gộp thông tin từ bộ nhớ cũ và chương mới thành MỘT đoạn liền mạch.
- Trả về ĐÚNG cấu trúc JSON sau, KHÔNG thêm chữ nào khác:
{"updated_memory":"<nội dung tóm tắt>"}

Chỉ trả về JSON. Bắt đầu ngay bằng dấu {.`;

  const res = await callAIWithRetry(prompt);
  const updated = res?.updated_memory;

  if (typeof updated !== 'string' || updated.trim().length === 0) {
    console.warn('[Memory] AI không trả về updated_memory hợp lệ — giữ nguyên memory cũ.');
    return memory;
  }

  return updated;
}

// ==========================================
// 8. MAIN HANDLER
// ==========================================
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Body không phải JSON hợp lệ' }) };
    }

    const {
      characters = [],
      worldItems = [],
      memory = '',
      chapterContent = '',
    } = payload;

    if (!chapterContent) {
      return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Thiếu chapterContent' }) };
    }

    console.log(`[Job] Bắt đầu: ${characters.length} NV, ${worldItems.length} world item`);

    const [processedCharacters, processedWorld, updatedMemory] = await Promise.all([
      processCharacters(characters, chapterContent),
      processWorld(worldItems, chapterContent),
      processMemory(memory, chapterContent),
    ]);

    // Kiểm tra toàn vẹn: số lượng item không được giảm
    if (processedCharacters.length < characters.length) {
      console.error(`[Job] Mất NV: ${characters.length} → ${processedCharacters.length}`);
    }
    if (processedWorld.length < worldItems.length) {
      console.error(`[Job] Mất world item: ${worldItems.length} → ${processedWorld.length}`);
    }

    console.log(`[Job] Hoàn tất: NV ${processedCharacters.length}, World ${processedWorld.length}, Memory ${updatedMemory === memory ? 'giữ nguyên' : 'đã cập nhật'}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        data: {
          characters: processedCharacters,
          worldItems: processedWorld,
          memory: updatedMemory,
        },
      }),
    };
  } catch (error) {
    console.error('[Job] Lỗi Background:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};