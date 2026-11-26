# DOREMI — PHASE 5.2H: RELEASE CANDIDATE & DOCUMENTATION REPORT

**Nhãn phát hành**: `1.0.0-rc.1`  
**Trạng thái**: **`RELEASE CANDIDATE - PENDING UAT`** *(Chưa gắn nhãn `v1.0.0` Stable cho tới khi người dùng hoàn tất nghiệm thu Windows Desktop UAT và xác nhận phê duyệt version chính thức).*

---

## 1. Tài liệu phát hành & Bàn giao đã hoàn thiện

- [`RELEASE_NOTES.md`](file:///g:/Source%20code%20DoReMi/RELEASE_NOTES.md): Tóm tắt tính năng & cải tiến cho `1.0.0-rc.1`.
- [`CHANGELOG.md`](file:///g:/Source%20code%20DoReMi/CHANGELOG.md): Lịch sử thay đổi chi tiết Phase 1 → Phase 5.2.
- [`SYSTEM_REQUIREMENTS.md`](file:///g:/Source%20code%20DoReMi/SYSTEM_REQUIREMENTS.md): Cấu hình tối thiểu (Intel Core dòng U + 8GB RAM + iGPU) & khuyến nghị.
- [`WINDOWS_INSTALLATION_GUIDE.md`](file:///g:/Source%20code%20DoReMi/WINDOWS_INSTALLATION_GUIDE.md): Hướng dẫn Portable EXE, Portable ZIP, NSIS Setup, SmartScreen, SHA-256 & One-Click QA.
- [`USER_DATA_AND_BACKUP.md`](file:///g:/Source%20code%20DoReMi/USER_DATA_AND_BACKUP.md): Đường dẫn `%APPDATA%\Lossless Player`, cấu trúc WAL/Backup và cách sao lưu thủ công an toàn.
- [`THIRD_PARTY_NOTICES.md`](file:///g:/Source%20code%20DoReMi/THIRD_PARTY_NOTICES.md): Danh sách giấy phép MIT / ISC / OFL-1.1 / Public Domain / Chromium BSD xác minh từ `node_modules/*/package.json`.
- [`PHASE_6_HANDOFF.md`](file:///g:/Source%20code%20DoReMi/PHASE_6_HANDOFF.md): Ranh giới bàn giao sạch cho Phase 6 Server tùy chọn (0 code server hiện tại).
- [`docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md`](file:///g:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md) & [`docs/phase-5.2/PHASE_5.2_KNOWN_ISSUES.md`](file:///g:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_KNOWN_ISSUES.md).

## 2. Bộ One-Click QA Launchers (`qa/`)

- [`qa/DoReMi-QA-Launch.cmd`](file:///g:/Source%20code%20DoReMi/qa/DoReMi-QA-Launch.cmd): Mở RC1 mặc định dùng profile cô lập `%TEMP%\DoReMi-QA-UserData` (tùy chọn profile thật có cảnh báo rõ).
- [`qa/DoReMi-QA-SmokeTest.cmd`](file:///g:/Source%20code%20DoReMi/qa/DoReMi-QA-SmokeTest.cmd): Chạy `doctor`, `codecs:verify`, `lint`, `verify:build`, `smoke:electron` unpacked & packaged.
- [`qa/DoReMi-QA-Performance.cmd`](file:///g:/Source%20code%20DoReMi/qa/DoReMi-QA-Performance.cmd): Chạy benchmark cô lập `100..50,000` bài + `30×` soak test.
- [`qa/DoReMi-QA-SoakTest.cmd`](file:///g:/Source%20code%20DoReMi/qa/DoReMi-QA-SoakTest.cmd): Chạy toàn bộ `test:electron` + stress soak benchmark.
