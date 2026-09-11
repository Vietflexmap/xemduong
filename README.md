# Vietflex Street View

Trình xem 360° hai màn hình cho `Vietflexmap/xemduong`:

- màn hình trên: Google Street View 360°;
- màn hình dưới: Google Earth 3D qua Maps JavaScript API `maps3d`, có fallback Google Maps vệ tinh;
- kéo marker vòng tròn đồng tâm + dấu cộng để đổi điểm xem;
- kéo bản đồ hoặc di chuyển trong Street View thì tọa độ, marker, Earth và ảnh 360° đồng bộ;
- cửa sổ tra cứu phường/xã/đặc khu ở bên phải, lấy dữ liệu chuẩn từ `sapnhap` và không che khuất vùng xem trên desktop;
- backend tối giản `/api/config` và `/api/admin`, cache dữ liệu hành chính 15 phút.

## API Google

Google Maps JavaScript API bắt buộc phải được tải trong trình duyệt nên browser key không thể được coi là bí mật. Khóa phải được giới hạn bằng **HTTP referrer** và API restrictions trong Google Cloud Console. Tối thiểu nên cho phép:

- `Maps JavaScript API`;
- `Street View`/dịch vụ cần dùng;
- `Maps 3D` nếu tài khoản đã được bật tính năng này.

`config.js` có sẵn browser key của bản nguồn cũ để chạy trực tiếp trên GitHub Pages. Khi đưa lên miền chính thức, thay bằng key đã giới hạn domain. Khi chạy backend, đặt biến môi trường `GOOGLE_MAPS_BROWSER_KEY`; `/api/config` sẽ được ưu tiên hơn giá trị tĩnh.

## Chạy local

```bash
GOOGLE_MAPS_BROWSER_KEY="your-browser-key" npm start
```

Mở `http://localhost:8787`. Nếu không đặt biến môi trường, ứng dụng dùng fallback trong `config.js`.

## Triển khai

- GitHub Pages: dùng `index.html`, `styles.css`, `app.js`, `config.js` và workflow trong `.github/workflows/pages.yml`.
- Vercel/Node: dùng `api/`, `server/`, `package.json` và đặt `GOOGLE_MAPS_BROWSER_KEY` trong Environment Variables.
- Có thể đổi nguồn dữ liệu bằng `ADMIN_DATA_URL`; mặc định là `https://vietflexmap.github.io/sapnhap/data/admin.json`.

Không proxy tile Google qua backend. Cách này giảm chi phí và độ trễ; backend chỉ cấp cấu hình public và cache/lọc dữ liệu hành chính.

Thiết kế: **Long Ngo** · Vietflex Map
