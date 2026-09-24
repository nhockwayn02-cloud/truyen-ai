# Xưởng Truyện AI Pro Max v9 — GitHub + Netlify + iPhone

Bản v9 giữ nguyên kiến trúc **1 file HTML + 3 Netlify Functions**, không cần React/Docker/PostgreSQL, phù hợp chạy bằng GitHub Pages/Netlify và sử dụng trên iPhone.

## v9 giải quyết các lỗi chính

### 1. JSON NV bị cắt giữa chừng
Không còn phụ thuộc vào một JSON array khổng lồ cho toàn chương.

- Chia chương thành nhiều lô nhỏ.
- Mỗi lô trích xuất NV riêng.
- Nếu model vẫn cắt JSON, `repairTruncatedArray()` cứu tất cả object hoàn chỉnh.
- Lô lỗi không làm mất dữ liệu của các lô trước.
- Có retry lần 2 với prompt JSON ngắn hơn.
- Merge NV theo tên chuẩn hóa.
- Trường hồ sơ tích lũy không bị ghi đè bằng bản ngắn hơn.
- Quan hệ có lịch sử thay đổi.

Ví dụ cảnh báo mới:

`NV: đã tự cứu JSON bị cắt ở 1 lô; không bỏ toàn bộ danh sách.`

Thay cho kiểu cảnh báo mơ hồ `JSON bị cắt... có thể sót vài NV cuối danh sách`.

### 2. Status không còn bị xóa khi AI lỗi
Status được tạo bằng JSON có cấu trúc. Nếu parse lỗi/rỗng:

- Status cũ được giữ nguyên.
- Chương vẫn được lưu.
- Thẻ chương nhận cảnh báo `Status`.

### 3. Background job an toàn hơn
Job v9 có:

- `accessToken` riêng để đọc trạng thái.
- `workerToken` riêng để kích hoạt worker.
- API key được mã hóa khi lưu Blobs nếu `JOB_SECRET` hoặc `NETLIFY_API_TOKEN` có sẵn.
- `job-status` không trả API key.
- Job có `baseChapterCount` để merge an toàn.
- Nếu bạn đã viết thêm chương local trong lúc background đang chạy, v9 không ghi đè toàn bộ truyện local.

### 4. Không còn gửi hai background job do đăng ký nút hai lần
v8 có cả `DOMContentLoaded` và listener trực tiếp cho nút background. v9 chỉ bind một lần.

### 5. Không chạy song song các post-process có cùng state
Character / World / Status / Memory / Scene / Continuity đều được xếp hàng tuần tự. Điều này tránh hai tác vụ cùng `persist()` rồi ghi đè dữ liệu của nhau trong localStorage.

## Memory Engine v9

State có thêm:

- `timeline[]` — sự kiện theo chương.
- `foreshadowing[]` —伏笔/điểm gieo và trạng thái.
- `knowledgeLedger[]` — nhân vật nào biết thông tin gì.
- `statusState{}` — Current Status có cấu trúc.
- `memoryEvents[]` — chỗ dành cho event memory mở rộng.
- `lastMemorySyncChapter`.

AI khi viết chương mới được đưa một phần Memory liên quan thay vì phải nhét toàn bộ truyện.

## Các lớp dữ liệu

```text
STORY BIBLE
    ↓
CURRENT STATUS
    ↓
CHARACTER STATE
    ↓
WORLD STATE
    ↓
TIMELINE
    ↓
FORESHADOWING
    ↓
KNOWLEDGE LEDGER
    ↓
PLOT THREADS
    ↓
RECENT CHAPTERS
    ↓
AI WRITING
```

## Background flow

```text
iPhone
  │
  ├── storyState + API key
  ↓
create-job
  │
  ├── lưu job
  ├── tạo accessToken
  ├── tạo workerToken
  └── kích hoạt background
          ↓
write-chapter-background
  │
  ├── viết chương
  ├── summary
  ├── NV theo nhiều lô
  ├── World theo nhiều lô
  ├── Current Status
  ├── Timeline/Foreshadowing/Knowledge
  └── Scene
          ↓
      completed
          ↓
iPhone mở lại
          ↓
job-status + accessToken
          ↓
merge an toàn
```

## Environment variables khuyến nghị

Trong Netlify → Site configuration → Environment variables:

- `JOB_SECRET` — bí mật dùng để mã hóa API key trong job. Nên đặt một chuỗi dài, ngẫu nhiên.
- `NETLIFY_SITE_ID` và `NETLIFY_API_TOKEN` — chỉ cần khi môi trường Netlify của bạn không tự cấp quyền Blobs.

Nếu đã có `NETLIFY_API_TOKEN` mà chưa đặt `JOB_SECRET`, v9 có thể dùng token đó làm khóa mã hóa. Tuy nhiên nên đặt `JOB_SECRET` riêng để dễ quản lý.

## 3 Functions

| Endpoint | Chức năng |
|---|---|
| `POST /.netlify/functions/create-job` | Tạo job, tạo token, lưu state, kích hoạt background |
| `GET /.netlify/functions/job-status?jobId=...&token=...` | Theo dõi job và nhận state khi hoàn thành |
| `POST /.netlify/functions/write-chapter-background` | Worker nội bộ viết + cập nhật memory |

## Giới hạn thực tế

- Background vẫn là **1 chương/job** để tránh một job chạy quá lâu.
- Nếu chương rất dài hoặc model quá chậm, job có thể timeout. v9 có checkpoint nhưng không thể làm Netlify chạy vô hạn.
- localStorage vẫn là nơi lưu state chính của trình duyệt. Vì vậy vẫn phải backup JSON định kỳ.
- v9 không biến một model thành model có context vô hạn; Memory Engine chỉ giúp chọn thông tin quan trọng.

## Cách dùng trên iPhone

1. Push repo lên GitHub.
2. Kết nối repo với Netlify.
3. Deploy.
4. Mở URL Netlify trên iPhone.
5. Nhập API endpoint/key/model.
6. Viết bình thường hoặc bấm `☁ Viết chương nền`.
7. Có thể đóng trình duyệt/tắt màn hình.
8. Mở lại → v9 tự đọc job token và đồng bộ.

## Backup

Vẫn nên dùng `Xuất JSON` định kỳ. Backup chứa:

- Story Bible
- Character Database
- Current Status
- Chapters
- Locations
- Items
- Threads
- Scenes
- Timeline
- Foreshadowing
- Knowledge Ledger
- cấu hình truyện

API key không được xuất nếu `includeKeyOnExport` đang tắt.


## v9.1 — JSON pipeline hardening
- JSON parser tìm mọi ứng viên object/array cân bằng thay vì chỉ thử ứng viên đầu tiên.
- Có lớp AI JSON repair khi model trả JSON lỗi/markdown/truncated.
- `[]` hợp lệ được coi là kết quả thành công (không còn báo lỗi giả cho Scene/NV).
- NV/Thế giới/Status/Memory/Scene đều dùng cùng lớp parse + repair.

## v9.2 — Sửa lỗi "This operation was aborted"
- Gọi model bằng **streaming** + idle-timeout (60s không có token mới mới ngắt) thay vì abort cứng sau 170s.
- Nếu bị ngắt giữa chừng nhưng đã có >800 ký tự, giữ phần đã viết và để vòng "viết tiếp" nối tiếp.
- Lỗi mạng/abort được retry đúng cách (bản cũ retry sai điều kiện).

## v9.3 — Sửa gốc lỗi "không cập nhật NV/Thế giới/Status/Memory"
1. **Penalty làm hỏng JSON**: `frequency_penalty/presence_penalty` bị gửi cả khi trích xuất JSON → model né lặp key/ngoặc. Nay chỉ dùng khi viết văn (worker + `callAI` ở client với temperature ≤ 0.3).
2. **Đổi “ ” thành " toàn cục** làm hỏng JSON hợp lệ có thoại → bỏ; chỉ dùng làm phương án cuối.
3. **Parser rơi vào mảng/object con** khi phần ngoài bị hỏng/cắt (vd. trả `relationships:[]` và coi là thành công) → chỉ xét ứng viên ngoài cùng.
4. **Không kiểm tra cấu trúc** → JSON đúng cú pháp nhưng sai khóa bị coi là thành công (không cập nhật gì, không báo). Nay bắt buộc có khóa mong đợi.
5. Sửa lỗi cú pháp nhẹ (xuống dòng thô, phẩy thừa, dấu " lồng nhau) + cứu JSON bị cắt bằng cách đóng ngoặc.
6. **Client không hợp nhất Timeline/Foreshadowing/Knowledge Ledger** từ job nền → nay đã hợp nhất, và chụp snapshot chương.
7. Có ngân sách thời gian 13,5 phút (giới hạn 15 phút của Netlify): bước nào không kịp sẽ báo rõ thay vì treo job.
8. Mỗi chương nền lưu `updateDiagnostics` (finish_reason, cách parse, số NV/địa điểm/... thêm được) — xem trong mục "Snapshot chương" → "🔍 Chi tiết cập nhật nền".

## v9.4 — Tăng ngân sách token cho bước trích xuất
- NV 10000, Thế giới 8000, Memory 8000, Status 5000, Scene 4000, Tóm tắt 2500, sửa JSON 6000-7000 token.
- Nếu output rỗng hoặc bị cắt (`finish=length`) → tự gọi lại 1 lần với ngân sách gấp đôi (tối đa 16000).
- Client (Rescan/viết thủ công): NV 8000, Thế giới/Memory 6000, retry 5000, mục 2500→4000.
