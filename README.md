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

## Các endpoint

| Endpoint                                      | Mô tả                          |
|-----------------------------------------------|--------------------------------|
| `POST /.netlify/functions/create-job`         | Tạo job viết chương            |
| `GET  /.netlify/functions/job-status?jobId=…` | Lấy trạng thái job             |
| `POST /.netlify/functions/write-chapter-background` | Chạy nền (nội bộ)         |
