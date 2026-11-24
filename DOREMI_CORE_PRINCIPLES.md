# DOREMI — CORE DEVELOPMENT PRINCIPLES (MUSIC PLAYER FIRST)

Phiên bản tài liệu: `1.0` (Thiết lập tại **Phase 02**)  
Trạng thái: **Hiến pháp phát triển chính thức — Bắt buộc đối chiếu trước mọi thay đổi từ Phase 03 trở đi**  
Tài liệu nền tảng liên quan: [`DOREMI_CODEC_RECOVERY_STATUS.md`](./DOREMI_CODEC_RECOVERY_STATUS.md)

> **Tuyên ngôn cốt lõi:**  
> **Music is the priority · Technology is the foundation · Personalization is the identity · Simplicity is the experience · Performance is the discipline.**

---

## 1. Tầm nhìn chính thức của DoReMi

DoReMi là **ứng dụng nghe nhạc cá nhân chất lượng cao, hoạt động offline trên Windows**, với các công cụ âm thanh đóng vai trò hỗ trợ tùy chọn.

- **DoReMi LÀ**: một trình phát nhạc cá nhân gọn gàng, ổn định, trung thực về chất lượng âm thanh, đẹp và giàu khả năng cá nhân hóa, chạy nhẹ trên laptop phổ thông.
- **DoReMi KHÔNG PHẢI**: một phần mềm DAW, một trình chuyển đổi âm thanh chuyên dụng gắn thêm nút Play, hay một tập hợp công cụ kỹ thuật gây rối trải nghiệm nghe nhạc.
- **Quy tắc sử dụng tài liệu này**: Trước khi thiết kế, thêm tính năng, nối IPC, thêm UI hoặc chỉnh sửa hạ tầng kỹ thuật ở bất kỳ giai đoạn nào (Phase 03, 04, 05, 06 và sau này), kỹ sư phát triển **bắt buộc đọc và kiểm tra mức độ tuân thủ** với tài liệu này.

---

## 2. Thứ tự ưu tiên bắt buộc (Mandatory Priority Hierarchy)

Mọi quyết định kiến trúc, tối ưu tài nguyên, thiết kế giao diện và xử lý lỗi phải tuân theo thang ưu tiên bất biến sau:

| Mức độ | Trụ cột | Phạm vi cốt lõi |
| :--- | :--- | :--- |
| **Priority 0** | **Music Playback Stability** | Phát nhạc ổn định, không gián đoạn, không treo, không crash, không rớt tiếng. |
| **Priority 1** | **Audio Quality & Fidelity** | Giữ nguyên chất lượng nguồn gốc theo mặc định; minh bạch kỹ thuật tuyệt đối. |
| **Priority 2** | **Listening Experience & Personalization** | Trải nghiệm nghe nhạc tinh gọn, thẩm mỹ, Themes, Fonts, Artwork, Profile, Playlist Gallery. |
| **Priority 3** | **Music Library & Organization** | Quản lý thư viện SQLite bền vững, tìm kiếm tiếng Việt chuẩn, playlist, lịch sử, quản lý thư mục. |
| **Priority 4** | **Music Sources** | Nguồn nhạc cục bộ là mặc định (Local First); kết nối Server là phần mở rộng tùy chọn trong tương lai. |
| **Priority 5** | **Audio Infrastructure** | Native Codec Engine, Default Encoder Pack, FFmpeg/FFprobe, Decoder/Encoder services. |
| **Priority 6** | **Optional Audio Tools** | Audio Converter, Batch Converter, Audio Analyzer, Custom Codecs, Codec Update Manager. |

### Quy tắc giải quyết xung đột
Khi hai tầng xảy ra xung đột về CPU, RAM, Disk I/O, không gian giao diện, độ phức tạp kỹ thuật hoặc rủi ro ổn định:
1. **Tầng ưu tiên thấp hơn bắt buộc phải nhường, trì hoãn, giới hạn tài nguyên hoặc cô lập.**
2. **Không bao giờ** hy sinh Priority 0–2 để phục vụ Priority 5–6.
3. Nếu một tính năng ở Priority 5–6 gặp lỗi, thiếu binary hoặc không tương thích môi trường, Priority 0–3 phải tiếp tục hoạt động bình thường như chưa từng có lỗi đó xảy ra.

---

## 3. Chính sách bảo vệ Music Playback (Playback Protection Policy)

### 3.1. Nguyên tắc bất khả xâm phạm
1. **Độc lập hoàn toàn**: Khả năng phát nhạc cục bộ không được phụ thuộc vào Default Encoder Pack, FFmpeg, FFprobe, Custom Codecs hay Server Connection.
2. **Ưu tiên tài nguyên tuyệt đối**: Khi đang phát nhạc, mọi tác vụ nền (convert, batch convert, analyze, quét thư mục, probe binary) phải nhường CPU và Disk I/O cho luồng phát nhạc.
3. **Không chặn UI điều khiển**: Các thao tác `Play`, `Pause`, `Seek`, `Next`, `Previous`, `Volume`, `Mute`, `Queue` phải phản hồi tức thì, không bao giờ bị đơ do tác vụ xử lý âm thanh nền.
4. **Không tự hạ chất lượng**: Không tự động giảm chất lượng âm thanh hoặc tự ý thay thế decoder/codec đang hoạt động ổn định.
5. **Cô lập lỗi triệt để**: Lỗi trong `CodecManager`, `AudioAnalyzerService`, `AudioProcessingService`, cập nhật codec hoặc tiến trình con không được phép làm dừng nhạc hay làm sập cửa sổ chính.
6. **Không mở rộng ngoài phạm vi yêu cầu**: Không ép buộc chuyển playback hiện tại sang FFmpeg; không tự ý triển khai WASAPI Exclusive, ASIO hay Gapless Engine mới khi chưa có đặc tả chính thức.

### 3.2. Vùng mã nguồn Playback được bảo vệ (Protected Playback Core)
Các tệp sau thuộc vùng bảo vệ trực tiếp — chỉ sửa khi có lỗi thực tế được chứng minh và phải có kiểm thử chống regression:
- `src/renderer/src/player/audio-engine.ts`
- `src/renderer/src/player/audio-dsp.ts`
- `src/renderer/src/stores/player-store.ts`
- `src/main/services/audio-protocol.ts`
- `src/main/services/audio-stream-handler.ts`
- `src/main/services/alac-decoder.ts`

---

## 4. Chính sách Chất lượng Âm thanh (Audio Quality First Policy)

1. **Bảo toàn nguyên bản theo mặc định**:
   - Không tự động resample, giảm bit depth, giảm bitrate, gộp kênh (downmix), bật normalize/ReplayGain, bật EQ/DSP, chuyển sang định dạng lossy hay transcode không cần thiết khi phát file cục bộ.
   - Mọi bộ lọc trong Audio Lab / EQ chỉ hoạt động khi người dùng chủ động bật.
2. **Minh bạch 4 tầng đường dẫn âm thanh (4-Stage Signal Transparency)**:
   Khi hiển thị thông số kỹ thuật âm thanh, hệ thống phải phân biệt rõ 4 tầng độc lập và không đánh tráo lẫn nhau:
   - **Stage 1 — Source**: Thông số thật đọc từ tệp nguồn (codec, container, sample rate, bit depth, channels, bitrate).
   - **Stage 2 — Decoded**: Dữ liệu PCM sau giải mã trong runtime.
   - **Stage 3 — Post-DSP**: Tín hiệu sau Audio Lab / EQ / Volume / Fade (nếu đang bật).
   - **Stage 4 — Device Output**: Đầu ra thực tế qua hệ điều hành / thiết bị phát.
3. **Trung thực kỹ thuật tuyệt đối**:
   - **Không** gắn nhãn `Bit-Perfect` hay `Hi-Res Certified` nếu chưa có cơ chế và kiểm chứng thực tế trên thiết bị đích.
   - **Không** khẳng định một tệp là `verified-lossless` (lossless gốc đích thực) chỉ dựa vào tên codec `FLAC` hoặc phần mở rộng tệp (một tệp FLAC có thể là bản transcode từ MP3 hoặc upsample; tệp WavPack có thể ở chế độ hybrid/lossy).
   - **Không** gây hiểu nhầm rằng cài đặt Default Encoder Pack sẽ tự động làm tăng chất lượng phát nhạc của file hiện có.

---

## 5. Chính sách Trải nghiệm & Cá nhân hóa (Personalization First Policy)

### 5.1. Vùng giao diện & cá nhân hóa được bảo vệ (Protected UI Core)
Mọi giai đoạn phát triển tiếp theo phải giữ nguyên bản sắc thị giác và hành vi đã xác minh của các vùng sau:
- **Home** và **Giant / Editorial Background Typography**
- **Playlist Gallery (7 thẻ)** cùng **hoạt ảnh chuyển tiếp 2 chiều (Next / Prev)**
- **Mini Player**, **Now Playing**, **Library**, **Sidebar**, **Artwork Display**
- **Dark / Light Themes**, **Font System**, **Custom Fonts**, **Profile & Personalization**

### 5.2. Ràng buộc thiết kế & trạng thái phát
1. Mọi giao diện bổ sung ở các giai đoạn sau phải kế thừa đúng Design System hiện tại (typography, bảng màu, tỷ lệ không gian, chuyển động), không mang phong cách bảng điều khiển công nghiệp rối mắt.
2. Thay đổi Theme, Font, Custom Font, Artwork, ngôn ngữ hay Profile **tuyệt đối không được khởi động lại bài đang phát hoặc làm mất Playback Queue**.

---

## 6. Chính sách Đơn giản hóa & Progressive Disclosure (Simplicity First)

### 6.1. Cấu trúc 3 tầng hiển thị (Progressive Disclosure)
1. **Basic Mode (Mặc định)**: Gọn, rõ ràng, thân thiện với người nghe nhạc phổ thông; chỉ hiện các tùy chọn thiết yếu và preset an toàn.
2. **Advanced Mode (Người dùng chủ động mở)**: Cho phép xem/chỉnh thông số kỹ thuật sâu (tham số encoder, concurrency trong giới hạn an toàn, custom binary, chi tiết stream).
3. **Troubleshooting (Chẩn đoán)**: Kiểm tra trạng thái binary, phiên bản, đường dẫn, bản quyền và thông báo lỗi cụ thể khi người dùng cần xử lý sự cố.

### 6.2. Quy tắc đặt vị trí giao diện cho Phase 05 (UI Placement Rules)
- **Không** đưa chỉ báo kỹ thuật phức tạp, hàng đợi convert hay cảnh báo codec lên Home, Mini Player hoặc Now Playing.
- **Không** tạo thêm mục điều hướng chính trên Sidebar chỉ dành riêng cho Audio Tools.
- **Codec Manager**: Đặt trong `Settings -> Audio & Codecs`.
- **Audio Converter**: Truy cập qua context menu của Track / Album / Playlist (hoặc khu vực công cụ phụ).
- **Audio Analyzer**: Truy cập qua `Track Info` hoặc context menu bài hát, **chỉ chạy khi người dùng chủ động bấm**.
- **Batch Converter**: Dùng chung một hàng đợi gọn, hỗ trợ `Pause` / `Resume` / `Cancel`, không chiếm toàn bộ trải nghiệm nghe nhạc.
- **Thông điệp trung thực, không gây hoang mang**:
  - Thiếu Encoder Pack hoặc FFmpeg **không được hiển thị như lỗi nghiêm trọng (Critical Error)** nếu Music Player vẫn phát nhạc bình thường — chỉ hiển thị trạng thái trung tính ở phần công cụ tương ứng.
  - Phân biệt rõ môi trường **Web Preview** (không có Desktop Runtime) với **Windows Desktop**; không hiển thị trạng thái codec giả trong Web Preview.

---

## 7. Chính sách Hiệu năng & Tài nguyên Phần cứng (Performance First)

### 7.1. Phần cứng mục tiêu thực tế
DoReMi được tối ưu để chạy mượt hàng ngày trên:
- **CPU**: Laptop dòng U (Intel Core U / AMD Ryzen U tiết kiệm điện)
- **RAM**: 8GB DDR4 (khi người dùng mở cùng lúc trình duyệt và ứng dụng khác)
- **GPU**: Đồ họa tích hợp (iGPU)
- **Lưu trữ & nguồn**: SSD hoặc HDD, thường xuyên chạy bằng pin

### 7.2. Kỷ luật kỹ thuật bắt buộc
1. **Lazy Loading & On-Demand Execution**:
   - Không khởi tạo `CodecManager`, `AudioAnalyzerService`, `AudioProcessingService` lúc khởi động app.
   - Không chạy `--version`, không quét hàng loạt binary, không spawn FFmpeg/FFprobe khi người dùng chưa mở khu vực Codec/Tools.
2. **Bounded Memory & Streaming Processing**:
   - Tính SHA-256 bằng stream (`fs.createReadStream`), tuyệt đối không dùng `fs.readFile` nạp cả tệp binary/nhạc lớn vào RAM.
   - Giới hạn kích thước bộ đệm `stdout`/`stderr`, giới hạn dung lượng phản hồi mạng khi kiểm tra manifest cập nhật.
3. **Limited Concurrency**:
   - Mặc định xử lý tuần tự (`concurrency = 1`) để giữ CPU mát, tránh giật nhạc và hạn chế nghẽn I/O trên HDD/SSD phổ thông.
4. **Resource Cleanup nghiêm ngặt**:
   - Dọn sạch toàn bộ tiến trình con và cây tiến trình (đặc biệt trên Windows khi hủy pipeline FFmpeg -> Native Encoder), xóa file tạm và backup tạm khi hoàn tất hoặc lỗi.
5. **Event-Driven, giảm thiểu nền**:
   - Tránh polling liên tục, tránh background daemon không cần thiết, không đưa xử lý nặng lên UI thread, hạn chế phụ thuộc nặng ngoài nhu cầu cốt lõi.

### 7.3. Chính sách Resource Modes (Áp dụng từ Phase 03+)
Khi triển khai tầng xử lý âm thanh nền ở Phase 03+, hệ thống phải hỗ trợ 3 chế độ tài nguyên thật (không phải UI trang trí):

| Chế độ | Trạng thái | Hành vi kiểm soát tài nguyên | Ràng buộc bắt buộc |
| :--- | :--- | :--- | :--- |
| **Power Saving** | **Mặc định** | `concurrency = 1`, giới hạn số luồng FFmpeg/encoder (ví dụ `-threads 1..2`), hạ độ ưu tiên tiến trình con khi có thể, nhường tài nguyên tối đa cho playback và pin. | Không giật nhạc, nhiệt độ thấp. |
| **Balanced** | Tùy chọn | `concurrency = 1..2` (tự giới hạn theo số nhân thực & trạng thái đang phát nhạc), giới hạn luồng vừa phải. | Vẫn bảo vệ Priority 0 khi đang phát nhạc. |
| **Performance** | Người dùng chủ động bật (`opt-in`) | Cho phép tăng thông lượng chuyển đổi nhưng vẫn có trần an toàn cứng (bounded cap) và tự hạ ưu tiên/giới hạn khi playback đang hoạt động. | Không làm treo UI, không làm rớt tiếng. |

> **Lưu ý quan trọng**: Resource Modes chỉ kiểm soát tốc độ và tài nguyên của tác vụ nền — **tuyệt đối không làm giảm chất lượng phát nhạc hay tự hạ chất lượng file đầu ra**.

---

## 8. Chính sách Offline First, Miễn phí & Quyền riêng tư

1. **100% Offline cho chức năng nghe nhạc**: Không yêu cầu Internet, không cần tài khoản/đăng nhập, không cần máy chủ trung gian để mở ứng dụng, quản lý thư viện hay phát nhạc.
2. **Miễn phí & không thương mại hóa gây phiền**: Không quảng cáo, không gói thuê bao, không paywall, không ép dùng cloud hay API tính phí.
3. **Tuân thủ bản quyền phần mềm minh bạch**:
   - Ưu tiên công cụ mã nguồn mở / miễn phí có giấy phép rõ ràng.
   - **Không đánh đồng freeware với quyền tự do phân phối lại (redistribution rights)** — luôn kiểm tra và lưu giữ đầy đủ tệp giấy phép (`*_license.txt`) tương ứng từng công cụ.
4. **Quyền sở hữu dữ liệu & Riêng tư**:
   - Thư viện, playlist, lịch sử nghe, thống kê và tùy biến cá nhân thuộc toàn quyền người dùng, lưu cục bộ.
   - Không tự ý tải tệp nhạc, metadata thư viện hay thông tin cá nhân lên Internet.

---

## 9. Chính sách Server Connection (Định hướng tương lai — Chưa triển khai)

Tính năng kết nối máy chủ cá nhân (như Navidrome/Subsonic/LAN server) **chưa được triển khai ở giai đoạn hiện tại**. Khi được thiết kế ở giai đoạn tương lai, phải tuân thủ:
1. Chỉ là nguồn nhạc **tùy chọn**; Local Playback phải luôn độc lập 100% khi không cấu hình hoặc mất kết nối server.
2. **Direct Play First** và **Original Quality First**; chỉ transcode khi thiết bị/mạng thực sự không thể phát trực tiếp.
3. Streaming có giới hạn bộ nhớ đệm (bounded memory), không tải tràn RAM.
4. Giao diện kết nối tối giản, ưu tiên trải nghiệm ghép nối nhanh (ví dụ mã ghép nối/QR nếu phù hợp).

---

## 10. Kiến trúc Mô-đun, Bảo mật Electron & Cô lập tính năng

1. **Tách ranh giới mô-đun rõ ràng**:
   - `Core Playback` (`audio-engine`, `player-store`, `audio-protocol`, `audio-stream-handler`, `alac-decoder`)
   - `Library & Persistence` (SQLite repositories, scanner, metadata)
   - `Audio Lab / DSP` (opt-in Web Audio DSP)
   - `Native Codec Engine` (hiện đang cô lập hoàn toàn khỏi runtime cho tới khi hoàn tất Phase 03 & nối lazy ở Phase 04)
2. **Tái sử dụng kiến trúc hiện hữu**: Tiếp tục phát triển trên `Electron Main / Preload / Renderer / Shared Types / Services / Stores`; không tự ý đổi framework hay sinh thêm tiến trình nền dư thừa.
3. **Ranh giới bảo mật Electron bất biến** (`src/main/windows/main-window.ts`):
   - `nodeIntegration: false`
   - `contextIsolation: true`
   - `sandbox: true`
   - `webSecurity: true`
   - Validate mọi đầu vào IPC; không chạy shell injection (`shell: false` khi `spawn`); chống path traversal (xác minh đường dẫn thực sau `fs.realpath`); chống SSRF / DNS rebinding khi có kết nối mạng tùy chọn.

---

## 11. Cổng kiểm soát chống phình tính năng (Feature Creep Prevention Gate)

Trước khi phê duyệt hoặc viết mã cho bất kỳ tính năng mới nào, phải trả lời đạt cả **9 câu hỏi kiểm soát** sau:

1. Tính năng này phục vụ trực tiếp việc nghe nhạc tốt hơn hay chỉ làm ứng dụng cồng kềnh thêm?
2. Nó có làm ảnh hưởng tới độ ổn định phát nhạc (**Priority 0**) không?
3. Nó có làm giảm hoặc can thiệp không mong muốn vào chất lượng âm thanh (**Priority 1**) không?
4. Nó có làm rối giao diện Home, Playlist Gallery, Mini Player hoặc Now Playing (**Priority 2**) không?
5. Nó có tốn thêm RAM/CPU/Disk I/O khi người dùng chỉ đang nghe nhạc bình thường không?
6. Nó có chạy mượt trên laptop dòng U với 8GB RAM và iGPU không?
7. Nó có ép người dùng phải kết nối Internet, đăng nhập hoặc cài thêm phần mềm bên thứ ba không?
8. Nếu tính năng này bị lỗi hoặc thiếu tài nguyên, trình phát nhạc cốt lõi có còn hoạt động 100% không?
9. Nó đã được cô lập mô-đun và áp dụng đúng nguyên tắc Progressive Disclosure (Basic / Advanced / Troubleshooting) chưa?

> Nếu bất kỳ câu hỏi nào vi phạm Priority 0–2 mà không có biện pháp cô lập/giảm thiểu triệt để, **tính năng đó phải được điều chỉnh lại hoặc từ chối**.

---

## 12. Nguyên tắc Build, Đóng gói & Phân phối (Windows)

1. **Định dạng phát hành**: Windows NSIS Setup EXE, Windows Portable ZIP/EXE và quy trình build tự động trên GitHub Actions.
2. **Trải nghiệm người dùng cuối hoàn toàn offline**: Người dùng Windows tải bản phát hành về phải nghe nhạc được ngay mà không cần cài Node.js, npm, foobar2000 hay FFmpeg thủ công.
3. **Quy trình tích hợp Encoder Pack trung thực (cho Phase 04)**:
   - Không yêu cầu tải tệp ZIP/EXE lên AI Studio; chuẩn bị và xác minh pack bằng script cục bộ/CI trên Windows.
   - Đồng bộ chính xác theo danh mục thực tế của **foobar2000 Free Encoder Pack 2026-03-13**:
     - Binaries & DLL: `fhgaacenc.exe`, `flac.exe`, `lame.exe`, `mpcenc.exe`, `nsutil.dll`, `oggenc2.exe`, `opusenc.exe`, `qaac64.exe`, `refalac64.exe`, `wavpack.exe`
     - License files: `fhgaacenc_license.txt`, `flac_license.txt`, `lame_license.txt`, `opusenc_license.txt`, `wavpack_license.txt`
   - Tách bạch rõ các binary thuộc pack với các công cụ tùy chọn/bổ sung bên ngoài (`ffmpeg`, `ffprobe`, `fdkaac`, `opusdec`, `wvunpack`, `mpcdec`, `tak`, `mac`).
4. **Cấm làm giả**: Tuyệt đối không tạo binary giả, không sinh checksum giả, không báo cáo đóng gói/chạy thử thành công khi chưa thực thi trên môi trường thật.

---

## 13. Chính sách Kiểm thử & Chống Regression

1. **Báo cáo trung thực tuyệt đối**:
   - Chỉ ghi `Passed` cho bài kiểm thử thực sự đã chạy sau lần sửa mã cuối cùng.
   - Phân tách rõ kết quả kiểm thử trong sandbox (`Unit tests`, `TypeScript`, `Build`, `Web Preview`) với các hạng mục cần xác minh trên máy thật (`Pending Desktop Verification`: Windows EXE, đầu ra âm thanh thật, binary native x64).
2. **Bảo vệ tính chính xác của bài test**:
   - Không tự ý sửa giá trị kỳ vọng (assertion) của bài test đang lỗi để làm xanh CI khi chưa xác minh nguyên nhân gốc và phạm vi nhiệm vụ.
   - Ví dụ cụ thể đang bảo lưu: **không tự ý sửa `tests/database.test.ts` từ `4` thành `5`** cho đến khi xác minh chính thức migration Phase 8 (`005_phase8_library_exclusions`).
3. **Ngưỡng bắt buộc trước khi kết thúc mỗi giai đoạn**:
   - `npm run lint` (`tsc --noEmit`): 0 lỗi.
   - `npm run build` (`electron-vite build`): thành công.
   - Toàn bộ nhóm test Music Player (38/38 trở lên): 100% Passed, không regression.

---

## 14. Baseline hiện tại, Backlog bảo lưu từ Phase 01 & Tiêu chuẩn chấp nhận Phase 03

### 14.1. Trạng thái Baseline đã xác minh (Cuối Phase 01 / Phase 02)
- **Codec Engine Isolation**: Toàn bộ các tệp Codec Engine (`codec-engine.ts`, `codec-registry.ts`, `codec-command-builder.ts`, `codec-manager.ts`, `audio-analyzer.ts`, `audio-processing-service.ts`) đang tồn tại nguyên vẹn nhưng **cô lập 100% khỏi runtime** (chưa import trong `src/main/index.ts`, `register-ipc.ts`, `preload/index.ts`, hay `src/renderer/`).
- **Bảo vệ đã áp dụng từ Phase 01**:
  - `src/shared/types/ipc.ts` dùng optional `?` cho các API chưa nối (21 Codec Engine APIs + 10 Phase 8 APIs), đảm bảo `tsc --noEmit` đạt 0 lỗi mà không cần mock giả.
  - `src/main/services/codec/audio-processing-service.ts` đã gia cố cơ chế ghi đè an toàn bằng backup tạm `.doremi-bak-*` và khôi phục khi `rename` thất bại.
- **Tồn đọng ngoài phạm vi Codec Engine (giữ tách biệt, không trộn vào Phase 03 nếu không có yêu cầu riêng)**:
  - `tests/database.test.ts:17` fail có sẵn từ Phase 8 (`5 !== 4` do `005_phase8_library_exclusions`).
  - 10 phương thức Phase 8 Library Management trong `src/shared/types/ipc.ts` chưa nối vào `register-ipc.ts` và `preload/index.ts`.

### 14.2. Danh mục kỹ thuật bắt buộc xử lý ở Phase 03 (20 hạng mục bảo lưu)

Phase 03 chỉ tập trung **Bug Fix, Security Hardening, Resource Modes & Unit Tests cho tầng Codec Engine** (chưa tải binary, chưa dựng UI Phase 05, vẫn giữ nguyên nguyên tắc không làm ảnh hưởng Music Player):

#### A. AudioProcessingService (Hàng đợi & Chuyển đổi an toàn)
1. Đặt mặc định `concurrency = 1` (theo `Power Saving` mặc định) và tích hợp cơ chế Resource Mode (`Power Saving` / `Balanced` / `Performance`) có nhường tài nguyên khi đang phát nhạc.
2. Bổ sung đầy đủ `Pause Queue` và `Resume Queue` hoạt động thực chất trên hàng đợi tác vụ.
3. Khắc phục nguy cơ `retryFailedJobs()` khởi chạy lại tác vụ vừa hủy khi tiến trình con cũ chưa kết thúc/dọn xong.
4. Bổ sung cơ chế timeout có kiểm soát cho mỗi tác vụ chuyển đổi để chống treo tiến trình vĩnh viễn.
5. Nâng cấp bước xác minh đầu ra (output verification): không chỉ kiểm tra `size > 0`, mà kiểm tra cấu trúc/header hoặc stream hợp lệ khi có `ffprobe` và báo rõ mức độ xác minh.
6. Bổ sung cơ chế khóa / chống xung đột đường dẫn đích (`outputPath` lock/dedup) khi nhiều tác vụ trong cùng batch trỏ về cùng một tệp đích.
7. Hoàn thiện cơ chế dọn dẹp toàn bộ process tree khi hủy/timeout (đặc biệt trên Windows đối với pipeline FFmpeg -> Encoder).
8. Sửa logic hiển thị tiến trình khởi tạo (bỏ gán cứng `progressPercent = 2`, phản ánh đúng trạng thái chuẩn bị/đang chạy).

#### B. AudioAnalyzerService (Phân tích trung thực, không ngộ nhận)
9. Loại bỏ việc gắn nhãn `verified-lossless` chỉ dựa vào tên codec; phân biệt rõ `lossless-codec-container` với kiểm chứng phổ/nguồn thực tế.
10. Sửa phân loại **WavPack**: không kết luận mặc định là lossless khi chưa kiểm tra chế độ hybrid/lossy (ví dụ tệp `.wv` có kèm `.wvc` hoặc thuộc tính lossy/hybrid).
11. Loại bỏ hoặc gắn nhãn rõ ràng khi fallback đoán codec từ phần mở rộng file thay vì từ luồng dữ liệu thật.
12. Không tự gán mặc định `channels = 2` và `bitDepth = 16` để suy đoán PCM bitrate như dữ liệu thật khi chưa đọc được thông số thực tế.
13. Sửa phân tách giữa `R128_TRACK_GAIN` (RFC 7845 / Opus gain) và `Integrated LUFS` để tránh báo sai chỉ số loudness.
14. Chuẩn hóa `decoderStrategy` theo khả năng giải mã thực tế đã biết thay vì suy đoán đơn thuần theo đuôi file, đồng thời phân biệt lỗi **"chưa cài FFprobe"** với **"FFprobe đã cài nhưng thực thi thất bại"**.

#### C. CodecManager (Bảo mật, Streaming & Quản lý gói tin cậy)
15. Chuyển `computeFileSha256` sang **streaming hash (`fs.createReadStream`)** thay vì đọc toàn bộ file binary vào RAM (`fs.readFile`), và hỗ trợ đối chiếu SHA-256 với bảng checksum tham chiếu tin cậy.
16. Nâng cấp xác thực binary: kiểm tra kiến trúc CPU (PE header `x64` vs `x86`/`ARM64` trên Windows), kiểm tra dependency DLL đi kèm (`nsutil.dll`...), không thực thi `--version` trước khi hoàn tất xác thực sơ bộ an toàn, và không đánh dấu `ready` khi exit code khác `0`.
17. Thay `Promise.all` probe hàng loạt trong `getInventory` bằng cơ chế **lazy probe + giới hạn concurrency**; đổi mặc định `allowSystemPathLookup` sang `false` (chỉ bật khi người dùng chủ động cho phép); bổ sung fallback sang pack/bundled nếu Custom Codec bị lỗi.
18. Gia cố `importCustomBinary`, `importEncoderPackFromFolder` và `rollbackPack`: dùng cơ chế staging atomic (không xóa bản cũ trước khi sao chép & xác minh thành công bản mới), bảo toàn đầy đủ tệp bản quyền `*_license.txt`, và khôi phục trọn vẹn metadata phiên bản/ngày cài đặt trong `codec-state.json`.
19. Gia cố `validateSafeUpdateManifestUrl` và luồng tải manifest cập nhật: chặn SSRF/redirect sang private/loopback/link-local IP, phòng DNS rebinding, giới hạn dung lượng phản hồi tối đa, timeout chặt và xác thực schema JSON nghiêm ngặt.

#### D. Codec Command Builder (Chính xác, an toàn đường dẫn & giữ metadata)
20. Chuẩn hóa `codec-command-builder.ts`:
    - `normalizeConvertOptions` dùng `concurrency = 1` mặc định và hỗ trợ giới hạn `-threads` theo Resource Mode.
    - Xử lý chính xác `bitDepth = 'source'` (không ép cứng `pcm_s24le` hay WAV 24-bit sai nguồn) và áp dụng đồng nhất bit depth cho từng encoder.
    - Truyền đầy đủ cờ metadata và artwork cho các Native Encoder (`flac`, `lame`, `opusenc`, `oggenc2`, `wavpack`, `qaac`) khi phù hợp, và phân biệt rõ `attached_pic` với video stream thông thường thay vì `-map 0:v?` chung chung.
    - Kiểm tra encoder thực sự có sẵn trong bản FFmpeg trước khi fallback sang FFmpeg; bỏ giới hạn cưỡng bức 2 kênh trên preset `lan-lossless-flac` cho nguồn đa kênh hợp lệ.
    - Nâng cấp `isPathStrictlyWithinDirectory` để xử lý symlink/junction bằng `fs.realpath` (có fallback an toàn cho tệp chưa tồn tại thông qua thư mục cha thực tế).

### 14.3. Tiêu chuẩn chấp nhận bắt buộc của Phase 03 (Phase 03 Acceptance Criteria)
Phase 03 chỉ được coi là **Completed** khi đạt đủ toàn bộ tiêu chí sau:
1. Tất cả 20 hạng mục ở mục 14.2 được triển khai sạch, đúng thực chất (không vá tạm, không mock giả, không hạ tiêu chuẩn bảo mật).
2. `Resource Modes` (`Power Saving` mặc định, `Balanced`, `Performance`) hoạt động thực tế trong tầng `Codec Engine` và `AudioProcessingService` với giới hạn concurrency/thread rõ ràng.
3. Có bộ unit test tự động chuyên biệt cho Codec Engine (`tests/codec-engine.test.ts` hoặc tương đương) kiểm chứng các lỗi đã sửa, kịch bản bảo mật, đường dẫn symlink, streaming SHA-256, Resource Modes, Pause/Resume/Cancel, output path dedup và phân tích trung thực — toàn bộ chạy bằng `node:test` và **100% Passed**.
4. **Zero Regression**:
   - `npm run lint` (`tsc --noEmit`): **0 lỗi**.
   - `npm run build` (`electron-vite build`): **Passed**.
   - Nhóm kiểm thử Music Player (38/38+): **100% Passed**.
   - Không làm thay đổi bất kỳ tệp nào trong Protected Playback Core hoặc Protected UI Core trừ khi có lý do bắt buộc được giải trình.
5. Báo cáo kết quả trung thực, phân biệt rõ những phần đã chạy trong sandbox và những phần `Pending Desktop Verification` trên Windows thật.

---

## 15. Lộ trình phân kỳ chính thức (Official Roadmap)

- **Phase 01**: Recovery & Source Code Audit *(Completed)*.
- **Phase 02**: Music Player First & Core Development Principles *(Completed)*.
- **Phase 03A**: Codec Manager, Security & Registry *(Completed)*.
- **Phase 03B**: Audio Quality, Processing Stability & Resource Management *(Completed)*.
- **Phase 03.5**: AI Project Memory System *(Kế tiếp — tài liệu hóa trí nhớ dự án riêng)*.
- **Phase 04**: Complete Native Audio Integration & UI *(Kết hợp Native Audio Integration + UI tối giản theo Progressive Disclosure)*.
- **Phase 05**: Personal Stable Release *(Đóng gói & kiểm thử ổn định Windows EXE + Portable ZIP)*.
- **Phase 06**: Server Connection *(Kết nối máy chủ âm nhạc cá nhân)*.
- **Phase 07**: Advanced Listening Experience *(Trải nghiệm nghe nhạc nâng cao)*.
- **Phase 08**: Comprehensive Optimization *(Tối ưu hiệu suất toàn diện)*.
- **Phase 09**: Final Release *(Phát hành hoàn thiện)*.
