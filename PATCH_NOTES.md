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
