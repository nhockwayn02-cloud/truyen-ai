# V12 — Writing Engine Upgrade

V12 keeps the V11.1 story-state pipeline and upgrades prose generation using the smoother V8-style path: temperature 0.82, no repetition penalties, prose-only output, and continuation style-lock.

# v11.1.0 — Tăng tốc

| Hạng mục | File | Nội dung |
|---|---|---|
| Rà chính tả không chặn lưu | `index.html` | `polishPromise` chạy song song hậu xử lý; chỉ thay văn bản khi `chapterObj.text` chưa đổi và không đang gõ |
| Hậu xử lý theo pha | `index.html` | `runFastPostTasks()`; nhánh tuần tự cũ giữ nguyên khi tắt "Song song" |
| Streaming throttle | `index.html` | `renderStream` giới hạn 120ms |
| Nghỉ hàng đợi | `index.html` | `sleep(600)` → `sleep(250)` |
| Lô trích xuất song song | `write-chapter-background.js` | `runPool()` + `EXTRACT_CONCURRENCY` cho NV/Thế giới |
| Tóm tắt song song | `write-chapter-background.js` | `summaryP` chạy cùng NV/Thế giới; "Gợi ý chương sau" đợi ở pha 2 |
| Test | `tests/` | e2e 21, unit 12, integration worker |

**Đánh đổi cần biết:** Status/Memory vẫn đọc state sau NV/Thế giới (pha 2). Tóm tắt/NV/Thế giới giờ chạy khi bản rà chính tả chưa xong nên dùng văn bản gốc (lỗi chính tả không ảnh hưởng nội dung trích xuất). Chưa kiểm thử với model/Netlify/iOS thật.

---

# v11.0.0 — Tóm tắt thay đổi

| Hạng mục | File | Nội dung |
|---|---|---|
| Lưu ngay khi rời trang | `index.html` | `flushPersist()` gắn vào `visibilitychange`, `pagehide`, `beforeunload` |
| Bản lưu khẩn cấp | `index.html` | `writeEmergencyCopy / clearEmergencyCopy / readEmergencyRecord`; khôi phục ở `initIndexedDBStorage` và `loadStoryStateFromDiskAsync` |
| Dự phòng khi IndexedDB lỗi | `index.html` | `saveStoryStateToDisk` ghi localStorage khi `idbPut` reject (trước đây chỉ hiện toast) |
| Lưu trữ bền | `index.html` | `navigator.storage.persist()` lúc khởi động |
| Rào chắn tuổi 18+ | `index.html`, `write-chapter-background.js` | `underageNames()`, `ageGuardPrompt()` chèn vào prompt khi bật 18+; cảnh báo khi mở truyện |
| Đồng bộ phiên bản | `package.json`, `index.html` | 11.0.0 (trước đó package.json còn ghi 10.2.0, giao diện ghi 10.2.1) |
| Bộ test | `tests/` | `e2e.py` (17), `worker.test.js` (11) |

**Chưa kiểm thử được trong môi trường này:** chạy thật trên Netlify (Background Functions, Blobs), gọi model thật (OpenRouter), và iOS Safari thật. Test dùng API giả và Chromium.

---

# Patch v10.2.3 — Sửa gốc: "Viết chương nền" không tự chuyển NSFW + hết giờ hàng loạt

**Vấn đề báo cáo:** khi bấm "☁ Viết chương nền", (1) chương có cảnh nóng vẫn dùng model
thường thay vì model NSFW dù `nsfwMode = "auto"`; (2) log trả về
`NV: 7/7 lô không đọc được / Thế giới: 7/7 lô không đọc được / Status: bỏ qua vì hết thời
gian / Memory: bỏ qua vì hết thời gian`.

**Nguyên nhân gốc (trong `write-chapter-background.js`):**

1. `generateOneChapter()` chỉ ép NSFW khi bắt được **từ khóa cứng** trong 3 nguồn hạn hẹp
   (Mệnh lệnh, Định hướng chương sau, tiêu đề chương trước) — không có bước **chấm nhiệt độ
   0–10** như bản viết trực tiếp trên client (`detectHeatLevel` trong `index.html`). Cảnh nóng
   phát sinh tự nhiên từ mạch truyện (không có từ khóa tường minh) sẽ bị bỏ qua, job lặng lẽ
   dùng model chính (đây là lý do bạn thấy nó "dùng mode thường" thay vì NSFW).
2. Bước viết chương + "viết tiếp" (`generateOneChapter`) không giới hạn ngân sách thời gian
   riêng — với chương dài (`minChapterWords` lớn) hoặc model trả lời chậm, bước này có thể ăn
   gần hết 13.5 phút của Netlify Background Function, khiến các bước sau (NV, Thế giới,
   Status, Memory) chạy dồn dập trong thời gian rất ngắn còn lại: các lệnh gọi trích xuất JSON
   bị cắt ngang do hết giờ → JSON hỏng → "không đọc được"; Status/Memory thậm chí không kịp
   bắt đầu → "bỏ qua vì hết thời gian".

**Đã sửa:**

- Thêm `detectHeatLevel()` trong worker, đồng bộ với client: nếu không bắt được từ khóa nhưng
  `nsfwMode = "auto"`, chấm nhiệt độ cảnh sắp viết và so với `nsfwAutoThreshold` đã cấu hình.
- Mở rộng nguồn quét từ khóa: thêm đoạn cuối chương trước (giống `tail` ở client), không chỉ
  Mệnh lệnh/Định hướng/tiêu đề.
- Dành riêng **5 phút dự trữ** (`POST_PROCESS_RESERVE_MS`) cho NV/Thế giới/Status/Memory: bước
  viết chương + viết tiếp giờ tự giới hạn `totalMs` và dừng sớm nếu sắp lấn vào phần dự trữ này.
- Nâng ngưỡng "bỏ qua vì hết thời gian" ở từng lô NV/Thế giới từ 60s lên 150s còn lại, để
  Status/Memory (chạy sau) chắc chắn còn cơ hội thay vì luôn bị hết giờ.
- Bỏ qua bước "sửa JSON bằng AI" (tốn thêm 1 lượt gọi model) khi còn dưới 90 giây, tránh vừa
  tốn thời gian vừa vẫn thất bại.

**Lưu ý còn lại:** nếu sau khi cập nhật vẫn thấy NV/Thế giới báo "không đọc được JSON" ngay cả
khi còn nhiều thời gian (không phải do hết giờ), rất có thể do model bạn chọn cho trường
"Model chính" trả lời bằng văn xuôi thay vì JSON thuần (thường gặp ở các model "reasoning" khi
endpoint không phải OpenRouter nên worker không tắt được chế độ suy luận). Trường hợp đó cần
xem đúng đoạn model trả về (mục "Chi tiết cập nhật nền" trong app) để xác định model có tuân
thủ yêu cầu "chỉ trả JSON" hay không.

# Patch v10.2.2 — Sửa lỗi mất dữ liệu IndexedDB

## Lỗi đã sửa
`index.html`, hàm `openStoryDB()` (dòng ~1142):

```js
// Trước (lỗi):
req.onsuccess = e => { idb = e.target.result; resolve(db); };   // `db` không tồn tại → ReferenceError

// Sau (đã sửa):
req.onsuccess = e => { idb = e.target.result; resolve(idb); };
```

## Ảnh hưởng của lỗi
- Biến `db` chưa từng được khai báo trong toàn bộ file, nên mỗi lần mở IndexedDB
  đều ném `ReferenceError: db is not defined`.
- Promise `openStoryDB()` bị cache (`idbReady`) nên **reject vĩnh viễn cho cả phiên làm việc**
  ngay từ lần gọi đầu tiên.
- Mọi thao tác `idbPut/idbGet/idbDelete/idbGetAll` — tức toàn bộ việc lưu/tải truyện,
  snapshot chương, draft khi streaming — đều thất bại âm thầm (bị `.catch(()=>{})` nuốt lỗi).
- Vì `saveStoryStateToDisk()` không có phương án dự phòng ghi vào `localStorage`,
  dữ liệu chỉ tồn tại trong bộ nhớ RAM của tab đang mở. Đóng tab / tắt màn hình iPhone
  (đúng kịch bản chính mà README v10.2 mô tả) sẽ **mất toàn bộ truyện chưa export**.

## Đã kiểm tra lại sau khi vá
- `node --check` cho cả 3 Netlify Functions và toàn bộ script trong `index.html`: hợp lệ.
- Chạy thử bằng trình duyệt headless (Playwright): tạo truyện mới → không còn lỗi console,
  và bản ghi truyện xuất hiện thật trong object store `stories` của IndexedDB (trước đó luôn là 0).

---

# Patch v10.2.3 — Sửa lỗi job nền bị "treo" vĩnh viễn

## Lỗi đã sửa
Hàm `checkPendingBackgroundJob()` (dùng để tự động kiểm tra lại job nền còn dang dở
mỗi khi mở lại trang) được định nghĩa nhưng **không bao giờ được gọi** trong `bootV102()`.

## Ảnh hưởng của lỗi
- Nếu đóng tab / mất mạng / tắt máy trong lúc job nền đang chạy, việc polling
  (kiểm tra tiến độ mỗi 12 giây) dừng hẳn.
- Mở lại trang: cờ "đang có job" vẫn còn trong `localStorage`, nhưng không có gì
  chạy lại để xác nhận job đã xong/lỗi → **job bị coi là đang chạy vĩnh viễn**,
  chặn mọi job mới ("Đã có job nền đang theo dõi..."), dù job thật trên server
  có thể đã xong hoặc lỗi từ lâu.

## Cách sửa
Thêm 1 dòng gọi hàm vào cuối `bootV102()`:
```js
checkForRecoverableDraft();
checkPendingBackgroundJob();   // ← dòng mới
```

## Đã kiểm tra lại sau khi vá
Giả lập 1 job cũ còn sót trong `localStorage` rồi tải lại trang bằng trình duyệt headless:
app tự hiện "☁ Phát hiện job nền đang chờ đồng bộ..." và tiếp tục polling ngay khi boot,
thay vì im lặng bỏ qua như trước.

## Khuyến nghị tiếp theo (chưa phải lỗi, nhưng nên làm trước khi phát hành)
1. Test thủ công đầy đủ luồng: viết chương → tắt/mở lại trình duyệt → kiểm tra truyện còn nguyên.
2. Cân nhắc thêm fallback ghi `localStorage` ngay trong `saveStoryStateToDisk()` phòng khi
   IndexedDB lỗi ở môi trường khác (Safari riêng tư, dung lượng đầy, trình duyệt cũ...),
   thay vì chỉ hiện toast cảnh báo.
3. Xác nhận gói Netlify đang dùng hỗ trợ Background Functions (cần gói Pro trở lên) nếu
   muốn dùng tính năng "☁ Viết chương nền".
4. Đặt biến môi trường `JOB_SECRET` trên Netlify để mã hóa API key khi lưu job Blobs.


## V12.2 — Background continuation length fix
- Mature/NSFW writing branch gets a larger initial output budget (24k tokens) and continuation budget (12k).
- Mature branch can use up to 8 continuation passes (minimum 4 when auto-continuation is enabled).
- Mature branch reserves 90s instead of 5 minutes for post-processing, reducing premature truncation.
- Every continuation reuses the exact routed model selected for the chapter; it does not fall back to the primary model.
- Mature continuation prompt explicitly continues the same scene/momentum instead of ending early.
- Normal writing behavior remains unchanged.
