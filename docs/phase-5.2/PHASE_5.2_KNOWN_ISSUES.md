# DOREMI — PHASE 5.2: KNOWN ISSUES & OBSERVATIONS

| ID | Hạng mục | Trạng thái | Chi tiết thực tế & Hướng xử lý |
|---|---|---|---|
| **OBS-51-01** | Double-click điều hướng sang `Library` thoáng gặp lỗi hiển thị cuối Phase 5.1 | `INTERMITTENT - NOT REPRODUCED` | Không tái hiện lại được trong kiểm thử sau đó. Không chỉnh sửa router theo suy đoán. Đã kiểm thử hồi quy biên `0..50,000` trong Phase 5.2D và gia cố clamping scroll offset tại `computeQueueWindowSlice`. |
| **ENV-NODE-NAPI** | Host Node `v22.12.0` (`napi=9`) khi chạy `npm test` thuần ngoài Electron | `BY DESIGN / DOCUMENTED` | Prebuild `better-sqlite3@13.2.0` dùng N-API 10. Bản chạy thật & `npm run test:electron` dùng Electron `45.4.1` (N-API 10) hoạt động bình thường. |
| **AUD-DEV-EB** | `npm audit --json` báo 6 cảnh báo `moderate` ở `devDependencies` | `DEV-ONLY / LOW IMPACT` | Thuộc chuỗi đóng gói build-time `electron-builder` (`@electron/universal` / `minimatch`), không có trong `dependencies` runtime (`23` prod deps = **`0` lỗ hổng**). |
| **SIG-UNSIGNED** | Bản cài đặt Windows chưa ký chứng thư số EV | `EXPECTED OFFLINE RC` | Windows SmartScreen có thể hiện cảnh báo "Unknown publisher" khi nhấp đúp lần đầu (`More info -> Run anyway`). |
| **IPC-BACKUP-UI** | Các kênh IPC `BACKUP_CREATE` / `BACKUP_VALIDATE` / `BACKUP_RESTORE` | `CORE READY / UI DEFERRED` | Lõi WAL-safe `db.backup()` + restore verification đã hoàn thiện trong [`src/main/database/integrity.ts`](file:///g:/Source%20code%20DoReMi/src/main/database/integrity.ts); chưa gắn thêm UI mới để giữ nguyên giao diện Settings Phase 5.2. |
| **DOC-UAT-PENDING** | Đo GPU FPS Blur 60fps & RAM Task Manager trực tiếp trên máy người dùng | `PENDING UAT` | Cần bạn nghiệm thu trực tiếp trên cửa sổ GUI thật ngoài sandbox để quyết định nâng nhãn lên `v1.0.0 Stable`. |
