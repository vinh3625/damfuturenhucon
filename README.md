# BINGX SIGNAL BOT Dashboard

Bản web tĩnh miễn phí để hiển thị bot BingX theo style dark/neon đã chốt.

## File chính

- `index.html`: giao diện chính
- `style.css`: style dark fintech
- `app.js`: đọc dữ liệu và render 4 tab
- `public_dashboard.json`: dữ liệu mẫu công khai

## Cách chạy thử trên máy Mac

```bash
cd bingx_signal_dashboard
python3 -m http.server 8080
```

Mở trình duyệt:

```text
http://localhost:8080
```

## Quy tắc dữ liệu công khai

Không đưa vào `public_dashboard.json`:

- API key / secret key
- IP VPS
- đường dẫn file trên VPS
- số dư tài khoản thật
- khối lượng tiền thật mỗi lệnh
- log lỗi kỹ thuật sâu

Chỉ nên public:

- tín hiệu
- Entry / SL / TP
- trạng thái
- kết quả theo R
- win rate
- nhật ký đã lọc sạch


## Bản v2 sửa lỗi

- Đã bỏ phần giả lập thanh tab/thanh địa chỉ trình duyệt khỏi giao diện thật.
- Đã bỏ giới hạn khung 4:3 và `overflow: hidden` gây cắt nội dung.
- Trang thật hiện cuộn theo chiều dọc bình thường trên trình duyệt.
