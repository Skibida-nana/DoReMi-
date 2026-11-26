# NEXT_TASK.md — Bộ nhớ tiếp nối công việc

- **Last Updated**: 2026-11-26T09:49+07:00
- **Last Verified Checkpoint**: `PHASE-5.2.1-FINAL-UI-GUIDE-ABOUT-RC2-20261126`
- **Verification Scope**: Đã hoàn tất toàn bộ **Phase 5.2.1 (`5.2.1A → 5.2.1E`)**; phát hành bản **`1.0.0-rc.2`** tại `release/v1.0.0-rc.2/` cùng bộ QA 1-click `qa/*.cmd` và Hướng dẫn sử dụng 15 chương tích hợp.
- **Source References**: [`PHASE_5.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md), [`PHASE_5.2.1_UI_REFINEMENT_REPORT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2.1_UI_REFINEMENT_REPORT.md), [`PHASE_5.2.1_DOCUMENTATION_SYNC_REPORT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2.1_DOCUMENTATION_SYNC_REPORT.md)
- **Verification Status**: `RELEASE CANDIDATE - PENDING UAT`

---

## Việc cần làm tiếp theo
1. **Nghiệm thu Windows UAT RC2 bởi Người dùng (Không cần nhập lệnh Terminal)**:
   - Nhấp đúp [`qa/DoReMi-QA-SmokeTest.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-SmokeTest.cmd) hoặc [`release/v1.0.0-rc.2/DoReMi-1.0.0-rc.2-x64-portable.exe`](file:///G:/Source%20code%20DoReMi/release/v1.0.0-rc.2/DoReMi-1.0.0-rc.2-x64-portable.exe) và đối chiếu 7 hạng mục trong [`PHASE_5.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md) (bao gồm Back to Top, `+ Tạo playlist`, Unified Focus Sidebar, Trang Giới thiệu `kamisamao`, và 15 chương Hướng dẫn sử dụng).
2. **Chốt nhãn Stable `v1.0.0` (Chỉ khi người dùng duyệt PASS UAT)**:
   - Cập nhật `"version": "1.0.0"` trong `package.json`, chạy `npm.cmd run docs:sync`, test/build và đóng gói bản Stable chính thức nếu được yêu cầu.
3. **Phase 6 Tùy chọn (Chỉ khi có yêu cầu mới)**:
   - Tuân thủ kiến trúc bàn giao tại [`PHASE_6_HANDOFF.md`](file:///G:/Source%20code%20DoReMi/PHASE_6_HANDOFF.md).
