# Xưởng Truyện AI Pro Max v8 + Netlify Background Writing

## Tính năng mới: Viết chương nền (tắt máy được)

Sau khi bấm nút **☁ Viết chương nền (tắt máy được)**:

1. Frontend gửi toàn bộ state + API key lên Netlify Function
2. Server tạo job và bắt đầu viết 1 chương ở background
3. Bạn **có thể tắt máy / đóng trình duyệt** ngay
4. Khi mở lại trang → tự động kiểm tra job và đồng bộ chương mới nếu đã xong

## Cấu trúc file

```
├── index.html                          # Frontend (đã thêm nút + logic poll)
├── package.json
├── netlify.toml
└── netlify/functions/
    ├── create-job.js                   # Tạo job + lưu Blobs + kích hoạt background
    ├── write-chapter-background.js     # Viết 1 chương (Background Function)
    └── job-status.js                   # Frontend poll trạng thái
```

## Cách deploy lên Netlify

1. Tạo site mới trên Netlify (hoặc dùng site hiện có)
2. Kết nối Git repo chứa các file trên, **hoặc** kéo thả thư mục này
3. Netlify sẽ tự cài `@netlify/blobs` từ `package.json`
4. Deploy xong → mở trang, nhập API Key (OpenRouter)
5. Bấm nút **☁ Viết chương nền**

### Lưu ý quan trọng

- **API Key** được gửi kèm job và **tự xóa** sau khi viết xong (không lưu lâu dài trên Blobs).
- Model mặc định đã đổi thành:
  - Chính: `deepseek/deepseek-v3.2`
  - NSFW: `aion-labs/aion-2.0`
- Background chỉ viết **1 chương** rồi dừng (theo yêu cầu).
- Post-process đầy đủ (cập nhật nhân vật, status, scene…) hiện vẫn chạy tốt nhất trên frontend. Sau khi đồng bộ chương mới, bạn có thể bấm **Quét toàn truyện** hoặc **Rescan** nếu cần.

## Giới hạn Netlify Background

- Thời gian chạy tối đa khoảng **15 phút**.
- Với chương ~4000–6000 từ + 1–2 lần auto-continue thường đủ.
- Nếu chương rất dài / model chậm, có thể bị timeout → job sẽ báo `failed`.

## Kiểm tra local (tùy chọn)

```bash
npm install
npx netlify dev
```

Sau đó mở `http://localhost:8888`.

## 📖 Hướng dẫn sử dụng nhanh

1. **0.1 → 0.3**: điền Cốt truyện chính, Thế giới, Nhân vật chính, quy tắc xưng hô... — nền tảng để AI bám theo suốt truyện.
2. **☁ Viết chương nền**: gửi job lên server rồi có thể tắt máy — mở lại app sẽ tự đồng bộ chương khi xong (mục "Tính năng mới" ở trên).
3. **Character Database (0.3)**: mỗi nhân vật có hồ sơ đầy đủ — ngoại hình, tính cách, **vai trò/phân loại với truyện**, mục tiêu, bí mật, điểm yếu, quan hệ với từng nhân vật khác. AI tự cập nhật sau mỗi chương, bạn cũng sửa tay được.
4. **🕸️ Sơ đồ quan hệ nhân vật**: bấm nút ngay dưới danh sách nhân vật để xem sơ đồ trực quan — ai liên quan tới ai, giai đoạn quan hệ hiện tại.
5. **⚠ Khung cảnh báo trên thẻ chương**: nếu chương nào viết thiếu từ hoặc lỗi API, sẽ hiện cảnh báo ngay trên thẻ — không cần đoán mò.
6. **Rescan / Quét toàn truyện**: dùng khi nghi ngờ dữ liệu nhân vật/thế giới bị lệch — quét lại từng chương để đồng bộ.
7. **Xuất Toàn Bộ**: `.txt` / `.md` / `.doc` để đọc hoặc nộp bản thảo; **Xuất JSON** để backup toàn bộ state (nhân vật, chương, cấu hình) — **nên backup định kỳ** vì dữ liệu chỉ lưu trong trình duyệt (localStorage), xóa cache là mất.

## 🆚 So sánh nhanh với MuMuAINovel (xiamuceer-j)

MuMuAINovel là một web-app đầy đủ (FastAPI + React + PostgreSQL/SQLite, chạy Docker, hỗ trợ nhiều người dùng/đăng nhập). App của bạn đi theo hướng khác — **1 file HTML tự chứa + Netlify Functions**, không cần server riêng, không cần đăng nhập, dữ liệu nằm ngay trên máy bạn. Đây là đánh đổi có chủ đích: đơn giản, miễn phí deploy, dễ tự sửa — đổi lại không có multi-user/đăng nhập và một số UI trực quan họ có sẵn (đội ngũ dev + React) mà bạn phải tự thêm dần.

Những gì đã mang được về từ ý tưởng của MuMuAINovel trong lần cập nhật này:
- ✅ **Sơ đồ quan hệ nhân vật trực quan** (họ gọi là "人物关系可视化管理") — đã thêm bản SVG đơn giản, không cần thư viện ngoài.
- ✅ **Phân loại vai trò nhân vật + mức liên quan tới nhân vật chính** — tương đương phần character classification của họ.

Những gì họ có mà app của bạn **chưa có và có thể cân nhắc thêm dần** (không làm ngay vì tốn công sức lớn, cần đánh giá có thực sự cần không):
- **Giao diện chỉnh Prompt template trực quan** (hiện app đã có nút xem "Prompt cuối cùng đã gửi" để tham khảo, nhưng chưa cho sửa trực tiếp).
- **Sơ đồ chuỗi chương / quan hệ logic giữa các chương** (họ gọi "章节关系图谱") — khác với sơ đồ nhân vật, đây là sơ đồ diễn biến cốt truyện.
- **"Phân tích rồi viết lại 1 chạm"** — app hiện có nút "Viết lại" nhưng chưa có bước AI tự phân tích lỗi rồi đề xuất trước khi viết lại.
- Đăng nhập/đa người dùng — không cần thiết cho nhu cầu dùng cá nhân.

## 📝 Nhật ký các bản sửa trong phiên làm việc này

1. Sửa luồng "Viết chương nền" gọi sai (Background Function không trả jobId về client) → đổi sang gọi qua `create-job`.
2. Sửa việc kích hoạt background function kiểu "bắn rồi bỏ" có thể bị huỷ giữa chừng → đổi thành có `await`.
3. Sửa mất cấu hình "số từ tối thiểu/chương", mức miêu tả... do bị lọc nhầm khi gửi lên server.
4. Tăng giới hạn token + cho phép lặp lại nhiều lần viết-tiếp cho tới khi đạt đủ số từ mục tiêu (tối đa 4 lần), thay vì chỉ 1 lần như trước.
5. Thêm cảnh báo chẩn đoán (⚠) ngay trên thẻ chương khi có lỗi/thiếu từ, để không phải đoán mò.
6. Sửa việc tóm tắt chương và cập nhật nhân vật/thế giới bị cắt mất đoạn giữa/cuối chương dài → gửi toàn bộ nội dung chương.
7. Sửa cách cập nhật nhân vật từ "ghi đè toàn bộ" sang "gộp, giữ thông tin cũ, chỉ bổ sung/sửa khi có bằng chứng rõ".
8. Thêm quy tắc miêu tả cụ thể (số đo/so sánh, cấm tính từ mơ hồ như "to lớn" đứng một mình).
9. Sửa lỗi biến `CHAR_JSON_FORMAT_HINT` bị thiếu (khiến cập nhật nhân vật ở luồng viết thường bị lỗi hoàn toàn).
10. Thêm trường phân loại vai trò (`role`) + mức liên quan tới nhân vật chính (`relevanceToMC`), theo dõi mục tiêu/bí mật/điểm yếu/kiến thức từng nhân vật, quan hệ với nhiều nhân vật khác (không chỉ nhân vật chính).
11. Thêm sơ đồ quan hệ nhân vật trực quan (SVG).

## Các endpoint

| Endpoint                                      | Mô tả                          |
|-----------------------------------------------|--------------------------------|
| `POST /.netlify/functions/create-job`         | Tạo job viết chương            |
| `GET  /.netlify/functions/job-status?jobId=…` | Lấy trạng thái job             |
| `POST /.netlify/functions/write-chapter-background` | Chạy nền (nội bộ)         |
