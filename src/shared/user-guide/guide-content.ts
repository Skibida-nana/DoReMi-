import type { UserGuideChapter } from './guide-types';

export const USER_GUIDE_VERSION_NOTE =
  'Tài liệu hướng dẫn sử dụng ngoại tuyến đồng bộ cùng phiên bản ứng dụng DoReMi Desktop (Windows).';

export const USER_GUIDE_CHAPTERS: readonly UserGuideChapter[] = [
  {
    id: 'ch-01-gioi-thieu',
    number: '01',
    title: 'Giới thiệu DoReMi',
    summary:
      'Ứng dụng nghe nhạc Offline Hi-Res dành cho Windows, tập trung vào chất lượng âm thanh, thẩm mỹ tối giản và toàn quyền kiểm soát dữ liệu cục bộ.',
    keywords: ['gioi thieu', 'offline', 'hi-res', 'kamisamao', 'lossless', 'sqlite'],
    sections: [
      {
        id: 'ch-01-overview',
        heading: 'Triết lý & định hướng sản phẩm',
        paragraphs: [
          'DoReMi là trình phát nhạc Lossless & Hi-Res hoàn toàn ngoại tuyến (Offline First) trên Windows, được thiết kế và phát triển bởi kamisamao.',
          'Ứng dụng không quảng cáo, không theo dõi người dùng (zero telemetry), không yêu cầu đăng nhập tài khoản hay kết nối Internet để phát nhạc.',
        ],
        bullets: [
          'Hỗ trợ phát nhạc chất lượng cao trực tiếp từ ổ cứng cục bộ (FLAC, ALAC .m4a, WAV, MP3, AAC, OGG, Opus).',
          'Lưu trữ thư viện, playlist, yêu thích, metadata tùy chỉnh và lịch sử nghe bằng SQLite cục bộ.',
          'Tối ưu cho cả phần cứng phổ thông nhờ danh sách ảo hóa (virtualization) và chế độ tiết kiệm tài nguyên.',
        ],
      },
      {
        id: 'ch-01-storage',
        heading: 'Không gian dữ liệu người dùng',
        paragraphs: [
          'Toàn bộ dữ liệu ứng dụng được tách biệt hoàn toàn khỏi thư mục cài đặt phần mềm và lưu trong thư mục userData mặc định tại %APPDATA%\\Lossless Player.',
          'Việc cập nhật hoặc gỡ cài đặt bản Windows Installer không làm mất thư viện hay file nhạc gốc của bạn.',
        ],
      },
    ],
  },
  {
    id: 'ch-02-cai-dat-khoi-chay',
    number: '02',
    title: 'Cài đặt & Khởi chạy trên Windows',
    summary:
      'Ba hình thức phát hành trên Windows 10/11 (Portable EXE, Portable ZIP, NSIS Installer) và cách mở file nhạc trực tiếp từ File Explorer.',
    keywords: ['cai dat', 'windows', 'portable', 'installer', 'nsis', 'open with'],
    sections: [
      {
        id: 'ch-02-packages',
        heading: 'Các gói phân phối hỗ trợ',
        paragraphs: [
          'DoReMi hỗ trợ ba định dạng phát hành dành cho Windows x64:',
        ],
        bullets: [
          'NSIS Installer (-setup.exe): Cài đặt chuẩn vào hệ thống, tạo lối tắt Start Menu/Desktop và đăng ký gỡ cài đặt sạch sẽ (giữ nguyên AppData).',
          'Portable EXE (-portable.exe): Tệp thực thi đơn lẻ, chạy trực tiếp không cần cài đặt.',
          'Portable ZIP (-portable.zip): Giải nén ra thư mục win-unpacked và chạy DoReMi.exe.',
        ],
      },
      {
        id: 'ch-02-explorer',
        heading: 'Mở file nhạc từ Windows Explorer',
        paragraphs: [
          'Bạn có thể mở trực tiếp tệp âm thanh vào DoReMi thông qua tùy chọn Open With hoặc kéo thả/mở qua dòng lệnh.',
          'Mọi đường dẫn truyền vào đều được kiểm tra hợp lệ trước khi phát qua giao thức nội bộ an toàn.',
        ],
      },
    ],
  },
  {
    id: 'ch-03-giao-dien-dieu-huong',
    number: '03',
    title: 'Giao diện chính & Điều hướng',
    summary:
      'Bố cục thanh điều hướng trái (Sidebar), Trang chủ Playlist Gallery, thanh MiniPlayer đáy màn hình và ngăn xếp Queue.',
    keywords: ['giao dien', 'sidebar', 'miniplayer', 'queue', 'dieu huong', 'home'],
    sections: [
      {
        id: 'ch-03-layout',
        heading: 'Các khu vực chính',
        paragraphs: [
          'DoReMi giữ bố cục gọn gàng với 4 thành phần cố định trực quan:',
        ],
        bullets: [
          'Thanh Sidebar trái (76px): Chuyển nhanh giữa Trang chủ (Playlist Gallery), Thư viện, Tìm kiếm, Yêu thích, Thống kê, Audio Lab, Máy chủ cá nhân (DoReMi Connect), Màn hình đang phát và Cài đặt.',
          'Avatar Hồ sơ (góc trên trái Sidebar): Mở nhanh trung tâm Hồ sơ & Cá nhân hóa.',
          'MiniPlayer đáy màn hình: Hiển thị bài đang phát, thanh tua, nút Yêu thích, True Shuffle, Repeat, Âm lượng và nút mở Queue Drawer.',
          'Queue Drawer: Ngăn kéo trượt bên phải hiển thị danh sách chờ phát với cơ chế ảo hóa mượt mà.',
        ],
      },
    ],
  },
  {
    id: 'ch-04-nhap-nhac-thu-vien',
    number: '04',
    title: 'Nhập nhạc & Quản lý Thư viện',
    summary:
      'Quét thư mục nhạc, nhập tệp lẻ, theo dõi thay đổi tự động, Relink bài hát bị di chuyển và điều hướng danh sách dài nhanh chóng.',
    keywords: ['thu vien', 'import', 'quet nhac', 'relink', 've dau trang', 'missing', 'exclusions'],
    sections: [
      {
        id: 'ch-04-import',
        heading: 'Thêm nhạc & theo dõi thư mục',
        paragraphs: [
          'Tại trang Thư viện (hoặc Cài đặt -> Thư viện nhạc), chọn Thêm thư mục hoặc Thêm file để lập chỉ mục vào SQLite.',
          'Các thư mục đã gắn kết có thể được quét lại (Rescan), hủy quét giữa chừng hoặc bật theo dõi thay đổi tự động.',
        ],
      },
      {
        id: 'ch-04-missing-relink',
        heading: 'Xử lý bài hát thiếu file (Missing) & Loại trừ',
        paragraphs: [
          'Nếu bạn di chuyển file nhạc sang ổ đĩa hay thư mục khác, DoReMi đánh dấu trạng thái Thiếu file thay vì tự ý xóa mất lịch sử nghe hoặc playlist.',
        ],
        bullets: [
          'Mở quản lý Nguồn & File thiếu để dùng Relink từng bài hoặc Quét thư mục Relink hàng loạt.',
          'Khi xóa bài khỏi Thư viện, file nhạc gốc trên ổ đĩa luôn được giữ nguyên trừ khi bạn chủ động chọn đưa vào Recycle Bin.',
          'Tùy chọn ghi vào Danh sách loại trừ (Exclusions) giúp tránh quét lại những file bạn không muốn đưa vào thư viện.',
        ],
      },
      {
        id: 'ch-04-navigation-helpers',
        heading: 'Nút Về đầu trang, Phát ngẫu nhiên & Tạo Playlist nhanh',
        paragraphs: [
          'Khi cuộn xuống sâu trong Thư viện hàng trăm đến hàng nghìn bài hát, nút nổi "Về đầu trang" (mũi tên lên) sẽ tự xuất hiện ở góc dưới bên phải ngay phía trên MiniPlayer để bạn trở về đầu trang mượt mà mà không mất bộ lọc hay vị trí tab.',
          'Nút "Phát ngẫu nhiên" nằm ngay cạnh "+ Tạo playlist" trên thanh công cụ Thư viện cho phép bắt đầu ngay một phiên nghe ngẫu nhiên thông minh từ toàn bộ bài hát khả dụng trong thư viện cục bộ (bỏ qua file lỗi/thiếu và tách biệt nguồn Remote).',
          'Nút "+ Tạo playlist" nằm ngay ngoài cùng bên phải thanh công cụ Thư viện giúp tạo playlist mọi lúc dù bạn đang ở tab Bài hát, Album, Nghệ sĩ, Thư mục hay Yêu thích.',
        ],
      },
    ],
  },
  {
    id: 'ch-05-phat-nhac-queue',
    number: '05',
    title: 'Phát nhạc, Queue & Điều khiển',
    summary:
      'Album-aware Smart Shuffle chống dồn bài cùng album, Tự động phát tiếp khi hết danh sách, Repeat, Audible Scrubbing, Chuyển bài mượt và tự động khôi phục hàng đợi phát.',
    keywords: ['phat nhac', 'shuffle', 'smart shuffle', 'auto continue', 'repeat', 'scrubbing', 'fade', 'queue', 'khoi phuc'],
    sections: [
      {
        id: 'ch-05-controls',
        heading: 'Điều khiển phát nhạc cốt lõi',
        paragraphs: [
          'DoReMi cung cấp bộ điều khiển chính xác trên cả MiniPlayer và màn hình Đang phát:',
        ],
        bullets: [
          'Album-aware Smart Shuffle: Trộn ngẫu nhiên thông minh phân bổ đều các album trên toàn bộ hàng đợi, hạn chế phát liên tiếp các bài cùng album/dồn cục về cuối danh sách nhưng vẫn giữ nguyên thứ tự gốc khi tắt Shuffle.',
          'Tự động phát tiếp khi hết danh sách (Auto Continue): Khi bật trong Cài đặt -> Phát nhạc (mặc định Bật), hết bài cuối của Album/Playlist/Hàng đợi (và không bật Lặp tất cả hay Hẹn giờ tắt) sẽ tự động phát nối tiếp từ Thư viện nhạc (theo thứ tự hoặc Smart Shuffle), tuyệt đối không tự nhảy chéo từ nguồn Remote sang cục bộ.',
          'Repeat: Chuyển linh hoạt giữa Tắt lặp, Lặp 1 lần, Lặp 2 lần, Lặp vô hạn (1 bài) và Lặp toàn bộ danh sách.',
          'Audible Scrubbing: Kéo thanh tiến trình để nghe dò âm thanh theo thời gian thực ngay trong khi tua.',
          'Chuyển bài mượt (Fade In/Out): Tùy chỉnh thời lượng 0.5s – 3s trong Cài đặt -> Phát nhạc hoặc ngay trên Now Playing.',
        ],
      },
      {
        id: 'ch-05-queue-restore',
        heading: 'Queue Drawer & Khôi phục phiên nghe',
        paragraphs: [
          'Ngăn kéo Queue tự động kích hoạt chế độ ảo hóa khi hàng đợi đạt từ 80 bài hát trở lên, giữ mượt mà kể cả với hàng chục nghìn bài.',
          'Khi tắt và mở lại DoReMi, hàng đợi gần nhất, bài đang nghe và vị trí thời gian sẽ được khôi phục tự động (có thể bật/tắt trong Cài đặt -> Phát nhạc).',
        ],
      },
    ],
  },
  {
    id: 'ch-06-album-nghe-si-thu-muc',
    number: '06',
    title: 'Album, Nghệ sĩ, Thư mục & Tìm kiếm',
    summary:
      'Coverflow 3D cho Album, duyệt cây thư mục ổ đĩa, lọc nhanh không dấu tiếng Việt và sắp xếp tự nhiên theo số thứ tự.',
    keywords: ['album', 'coverflow', 'nghe si', 'thu muc', 'tim kiem', 'chon nhieu', 'sap xep'],
    sections: [
      {
        id: 'ch-06-views',
        heading: 'Các chế độ duyệt Thư viện',
        paragraphs: [
          'Thanh tab Thư viện cho phép chuyển đổi tức thì giữa Bài hát, Album, Nghệ sĩ, Thư mục, Playlist và Yêu thích.',
        ],
        bullets: [
          'Tab Album & Chi tiết Album: Hỗ trợ Coverflow 3D và lưới Album; danh sách bài hát trong Album luôn được sắp xếp chuẩn xác theo Đĩa (disc_number) -> Số bài dạng số học (track_number: 1, 2, ..., 10) -> Tên file/Tiêu đề (cả cục bộ lẫn LAN Remote).',
          'Tab Thư mục: Phản ánh cấu trúc thư mục thực tế trên ổ cứng để dễ tìm nhạc sưu tầm theo folder.',
          'Lọc nhanh tiếng Việt & đa ngôn ngữ: Hỗ trợ tìm kiếm có dấu lẫn không dấu (NFC/NFD) và ký tự CJK, đồng thời lọc theo tên định dạng (FLAC, ALAC, WAV...).',
          'Chọn nhiều bài (Multi-select): Chọn hàng loạt bằng checkbox hoặc giữ Shift+Click để chọn một dải bài, thêm vào playlist hoặc tạo playlist mới.',
        ],
      },
    ],
  },
  {
    id: 'ch-07-playlist-yeu-thich',
    number: '07',
    title: 'Playlist & Yêu thích',
    summary:
      'Tạo playlist mọi lúc từ thanh công cụ, phòng trưng bày Editorial Playlist Gallery ở Trang chủ và quản lý danh sách Yêu thích.',
    keywords: ['playlist', 'yeu thich', 'editorial gallery', 'tao playlist', 'trung bai'],
    sections: [
      {
        id: 'ch-07-playlists',
        heading: 'Tạo và quản lý Playlist',
        paragraphs: [
          'Bạn có thể tạo playlist trống hoặc tạo từ các bài đang chọn bằng nút "+ Tạo playlist" trên thanh công cụ Thư viện hay nút "Tạo Playlist mới" trong thanh thao tác hàng loạt.',
          'Khi thêm bài vào playlist có sẵn, hộp thoại cho phép tùy chọn chặn trùng bài hoặc cho phép lặp bài trong cùng playlist.',
        ],
        bullets: [
          'Sắp xếp lại thứ tự bài trong trang chi tiết Playlist, đổi tên, cập nhật mô tả và gắn ảnh bìa tùy chỉnh.',
          'Trang chủ (Editorial Playlist Gallery) trưng bày các playlist theo phong cách biên tập với bảng màu nổi bật.',
          'Bài hát được nhấn Yêu thích (Tim) tự động đồng bộ vào tab Yêu thích và bảng điều khiển SQLite.',
        ],
      },
    ],
  },
  {
    id: 'ch-08-now-playing-focus-vinyl',
    number: '08',
    title: 'Now Playing & Focus Vinyl Mode',
    summary:
      'Trải nghiệm Đang phát với mâm đĩa than 33⅓ RPM, hai chế độ Chuẩn và Focus Vinyl giữ Sidebar ẩn đồng nhất để không xao nhãng.',
    keywords: ['now playing', 'focus vinyl', 'dia than', 'sidebar', 'alt+m', 'lyrics mode'],
    sections: [
      {
        id: 'ch-08-modes',
        heading: 'Chế độ Chuẩn & Focus Vinyl',
        paragraphs: [
          'Màn hình Đang phát (Now Playing) có hai chế độ hiển thị có thể chuyển đổi qua lại tức thì:',
        ],
        bullets: [
          'Chế độ Chuẩn (3 vùng): Hiển thị đồng thời Hàng đợi (Queue), Đĩa than / Bìa album trung tâm và Thông tin chi tiết / Lời bài hát bên phải; tên bài hát dài/có dấu tiếng Việt tự động co giãn nhịp nhàng, không bị cắt mất dấu.',
          'Chế độ Focus Vinyl: Tập trung toàn màn hình vào đĩa than 33⅓ RPM cùng Lời bài hát tối giản đồng bộ theo nhịp phát.',
          'Sidebar ẩn tức thì & Không xô lệch bố cục: Ngay khi bạn mở Màn hình đang phát hoặc Focus Vinyl, Sidebar lập tức ẩn gọn ở mép trái (không bật sáng 3 giây gây xao nhãng hay lệch nút Quay lại), và giữ nguyên trạng thái ẩn khi chuyển đổi giữa các chế độ phát.',
          'Mở nhanh Sidebar bất kỳ lúc nào bằng cách đưa chuột chạm mép trái màn hình (~10px) hoặc nhấn tổ hợp phím Alt + M (khi rời Màn hình đang phát, Sidebar tự khôi phục bình thường).',
        ],
      },
    ],
  },
  {
    id: 'ch-09-audio-engine-audio-lab',
    number: '09',
    title: 'Audio Engine, ALAC, FLAC & Audio Lab (EQ / DSP)',
    summary:
      'Chi tiết pipeline phát nhạc nội bộ (Chromium + @mgz-dev/alac WASM), Audio Lab EQ 10/8 băng tần, ReplayGain và phân tích phổ FFT.',
    keywords: ['audio engine', 'audio lab', 'eq', 'equalizer', 'dsp', 'alac', 'flac', 'replaygain', 'headroom'],
    sections: [
      {
        id: 'ch-09-engine',
        heading: 'Cơ chế giải mã & phát nhạc thực tế',
        paragraphs: [
          'DoReMi phát âm thanh bằng HTMLAudioElement qua giao thức nội bộ lossless-media:// (hỗ trợ HTTP 206 Byte-Range seeking) kết nối trực tiếp vào đồ thị xử lý Web Audio API (AudioDspGraph).',
        ],
        bullets: [
          'FLAC, WAV, MP3, AAC, OGG, Opus: Giải mã qua Chromium Media Pipeline nội bộ; riêng FLAC tích hợp flac-stream-sanitizer lọc sạch header/metadata ảo khi phát mà không chỉnh sửa file gốc.',
          'ALAC (.m4a): Giải mã trực tiếp bằng @mgz-dev/alac (WebAssembly) ngay trong ứng dụng sang luồng PCM WAV hỗ trợ tua chuẩn xác, không cần FFmpeg bên ngoài.',
          'Lớp Codec Engine ngoài (FFmpeg / encoder rời) hiện được tách biệt hoàn toàn khỏi luồng phát nhạc và giao diện mặc định.',
        ],
      },
      {
        id: 'ch-09-audiolab',
        heading: 'Tinh chỉnh Audio Lab (Equalizer & DSP)',
        paragraphs: [
          'Mục Audio Lab trên thanh Sidebar cho phép kiểm soát toàn diện đường âm thanh thời gian thực:',
        ],
        bullets: [
          'Hai chế độ EQ: Graphic EQ 10 băng tần (dải tần 31Hz – 16kHz) và Parametric EQ 8 băng tần linh hoạt.',
          'Preamp & Auto Headroom: Tự động hạ mức khuếch đại bù trừ đỉnh boost dương nhằm giảm nguy cơ vỡ tiếng (clipping).',
          'ReplayGain: Cân bằng độ lớn âm lượng theo Track, Album hoặc Tắt.',
          'Bộ phân tích phổ FFT (Spectrum Analyzer): Chỉ chạy khi bạn đang mở màn hình Audio Lab để tiết kiệm CPU/GPU.',
        ],
      },
    ],
  },
  {
    id: 'ch-10-lyrics-metadata',
    number: '10',
    title: 'Lời bài hát (Lyrics) & Metadata',
    summary:
      'Nhập lời .lrc/.txt đa bảng mã tiếng Việt & CJK, đồng bộ từng câu khi phát và chỉnh sửa Metadata/ảnh bìa an toàn trong SQLite.',
    keywords: ['lyrics', 'loi bai hat', 'lrc', 'encoding', 'cjk', 'metadata', 'artwork'],
    sections: [
      {
        id: 'ch-10-lyrics',
        heading: 'Lời bài hát đa ngôn ngữ & đồng bộ',
        paragraphs: [
          'DoReMi đọc lời bài hát nhúng trong file nhạc, cho phép dán/chỉnh sửa trực tiếp lời tùy chỉnh hoặc nhập file .lrc / .txt bên ngoài.',
        ],
        bullets: [
          'Hỗ trợ 8 chế độ bảng mã (Tự động, UTF-8, UTF-16LE, UTF-16BE, Windows-1258, Shift-JIS, EUC-JP, GBK, Big5...) giúp hiển thị chuẩn xác tiếng Việt lẫn chữ Nhật/Hoa/Hàn.',
          'File .lrc có mốc thời gian sẽ tự cuộn và làm nổi bật câu đang hát trong cả Now Playing và Focus Vinyl.',
        ],
      },
      {
        id: 'ch-10-metadata',
        heading: 'Chỉnh sửa Metadata & Ảnh bìa không phá file gốc',
        paragraphs: [
          'Trong danh sách Thư viện, chọn chỉnh sửa metadata để cập nhật Tiêu đề, Nghệ sĩ, Album, Số track hoặc thay Ảnh bìa tùy chỉnh.',
          'Mọi thay đổi được lưu dưới dạng lớp phủ (override) trong SQLite; file nhạc gốc trên ổ cứng luôn nguyên vẹn và bạn có thể khôi phục thông tin gốc bất kỳ lúc nào.',
        ],
      },
    ],
  },
  {
    id: 'ch-11-ca-nhan-hoa',
    number: '11',
    title: 'Cá nhân hóa & Giao diện',
    summary:
      'Tùy biến Theme Sáng/Tối, màu nhấn Accent, màu động theo bìa Album, hình nền Trang chủ, Font Editorial và Preset hiệu năng.',
    keywords: ['ca nhan hoa', 'theme', 'dark', 'light', 'accent', 'power saver', 'reduced motion', 'font'],
    sections: [
      {
        id: 'ch-11-theme',
        heading: 'Giao diện & Màu sắc',
        paragraphs: [
          'Nhấn Avatar ở góc trên bên trái Sidebar hoặc vào Cài đặt -> Cá nhân hóa để mở trung tâm tùy biến:',
        ],
        bullets: [
          'Chế độ giao diện: Sáng (Light) và Tối (Dark).',
          'Màu nhấn (Accent Color): Tự chọn màu chủ đạo cho nút nổi, slider và viền nhấn, hoặc bật trích xuất màu động từ ảnh bìa Album.',
          'Nền Trang chủ & Hình đại diện: Tải ảnh/GIF cục bộ cho avatar hoặc nền trang chủ, chọn font hiển thị Editorial tùy chỉnh.',
        ],
      },
      {
        id: 'ch-11-performance',
        heading: 'Chất lượng hình ảnh & Giảm chuyển động',
        paragraphs: [
          'Với máy cấu hình thấp hoặc laptop dùng pin, bạn có thể chọn Preset "Tiết kiệm tài nguyên" (Power Saver) và bật Giảm chuyển động (Reduced Motion) để giảm mờ kính và tự động dừng ảnh GIF/xoay đĩa.',
        ],
      },
    ],
  },
  {
    id: 'ch-12-thong-ke',
    number: '12',
    title: 'Thống kê & Lịch sử nghe nhạc',
    summary:
      'Theo dõi tổng thời gian nghe, bài hát/nghệ sĩ/album nghe nhiều nhất và lịch sử nghe thực tế từ SQLite.',
    keywords: ['thong ke', 'lich su', 'statistics', 'top track', 'sqlite'],
    sections: [
      {
        id: 'ch-12-stats',
        heading: 'Bảng điều khiển Thống kê',
        paragraphs: [
          'Mỗi phiên nghe nhạc thực tế trên máy được ghi nhận cục bộ vào SQLite và tổng hợp tại trang Thống kê.',
        ],
        bullets: [
          'Xem tổng số lượt phát, tổng thời lượng đã nghe, Top Bài hát, Top Nghệ sĩ và Top Album theo khoảng thời gian.',
          'Toàn bộ dữ liệu thống kê chỉ nằm trên máy của bạn và được bảo toàn khi bạn chuyển thư mục nhạc nhờ Relink thông minh.',
        ],
      },
    ],
  },
  {
    id: 'ch-13-du-lieu-sao-luu',
    number: '13',
    title: 'Dữ liệu, Sao lưu & Bảo mật Offline',
    summary:
      'Cơ sở dữ liệu SQLite WAL, tự động tạo bản sao lưu trước nâng cấp và kiến trúc Sandbox cách ly hoàn toàn.',
    keywords: ['sao luu', 'backup', 'restore', 'userdata', 'sqlite', 'wal', 'bao mat'],
    sections: [
      {
        id: 'ch-13-backup',
        heading: 'Quản lý dữ liệu & Sao lưu',
        paragraphs: [
          'DoReMi sử dụng SQLite chế độ WAL cùng kiểm tra toàn vẹn foreign_keys mỗi lần mở.',
          'Trước khi chạy nâng cấp schema (migration) trên cơ sở dữ liệu có sẵn, DoReMi tự động tạo bản sao dự phòng ngay bên cạnh tệp library.db.',
        ],
        bullets: [
          'Trong Cài đặt -> Thư viện nhạc, bạn có thể xem đường dẫn library.db thực tế và mở quản lý nguồn thư viện.',
          'Khi dùng bộ cài Windows Installer, dữ liệu cá nhân trong %APPDATA%\\Lossless Player được giữ lại khi nâng cấp hoặc gỡ cài đặt.',
        ],
      },
      {
        id: 'ch-13-security',
        heading: 'Kiến trúc an toàn Offline & DoReMi Connect (Smart Connection, Quản lý Nguồn điện & Tài nguyên)',
        paragraphs: [
          'Tiến trình giao diện chạy trong Sandbox nghiêm ngặt (contextIsolation: true, nodeIntegration: false) cùng Content Security Policy (CSP) khóa kết nối mạng ngoài ở renderer.',
          'Tính năng Máy chủ nhạc cá nhân (DoReMi Connect · Phase 6.2–6.5) mặc định TẮT. Trong mạng nội bộ (LAN Direct), dữ liệu chỉ phục vụ qua HTTPS mã hóa TLS kèm chứng chỉ SPKI Pinning nghiêm ngặt, hỗ trợ ghép nối nhanh qua mã QR/JSON ngoại tuyến dùng 1 lần, xoay vòng token thiết bị và danh sách thư mục chia sẻ chỉ đọc do bạn tự chọn.',
          'Khi bạn chủ động bật Truy cập từ xa qua Internet (Remote HTTPS · Phase 6.3), máy Host sử dụng Tailscale Funnel làm cầu nối TLS công cộng tới một cổng Gateway riêng chỉ lắng nghe tại loopback 127.0.0.1 với danh sách đường dẫn cho phép nghiêm ngặt (chặn hoàn toàn /enrollment, /remote/provision, /admin, /diagnostics). Thiết bị Client (Windows hay ứng dụng Android tương lai) KHÔNG cần cài Tailscale hay VPN.',
          'Từ Phase 6.4–6.5, bộ quản lý kết nối thông minh (Smart Connection Manager) hỗ trợ 3 chế độ trên từng Host đã lưu (Tự động, Chỉ LAN, Chỉ Remote), kết hợp quản lý nguồn điện Windows tường minh (Theo hệ thống, Giữ thức khi đang phát từ xa, Giữ thức khi bật Host) và tối ưu tài nguyên chạy dài cho máy cấu hình phổ thông.',
        ],
        bullets: [
          'Không tải nhạc lên Cloud, không cần thuê VPS. Chế độ Remote HTTPS mặc định TẮT và chỉ mở khi bạn tự bật kèm xác nhận công khai Internet.',
          'Ghép nối lần đầu bắt buộc thực hiện trong mạng LAN an toàn qua QR / Pairing Payload (doremi-pair v1 <= 2 KB) hoặc thủ công. Quyền Truy cập từ xa (remoteAccessEnabled) mặc định TẮT cho từng thiết bị — Host phải chủ động cấp quyền mới nhận được scoped Remote Token (r1.*).',
          'Token LAN và Remote Token được tách biệt hoàn toàn: token LAN bị từ chối trên Gateway công cộng, và ngược lại; tắt hoặc thu hồi quyền từ xa chỉ chặn Remote HTTPS mà không làm gián đoạn kết nối LAN đang tin cậy.',
          'Mọi quá trình tự động chuyển mạng (LAN <-> Remote HTTPS), tái sử dụng kết nối Keep-Alive được cách ly theo từng Host hoặc quét lại IP LAN mới qua mDNS đều bắt buộc vượt qua đầy đủ bước xác minh mật mã (SPKI Pinning trên LAN; CA công cộng rejectUnauthorized: true + chặn 3xx + challenge-response ECDSA P-256 trên Remote) trước khi gửi Bearer Token.',
          'Bàn giao phát nhạc (Playback Handover) giữ nguyên bài hát đang nghe, vị trí thời gian, trạng thái Phát/Tạm dừng, Hàng đợi, Smart Shuffle, Repeat, Volume, EQ và bộ lọc tìm kiếm Thư viện Remote.',
          'Chế độ nguồn điện máy Host mặc định tôn trọng cài đặt Sleep của Windows ("Theo hệ thống"). Nếu chọn "Giữ thức khi đang phát từ xa" hoặc "Giữ thức khi bật Host", DoReMi chỉ ngăn tiến trình hệ thống ngủ (prevent-app-suspension) để nhạc không đứt quãng nhưng vẫn cho phép màn hình tắt bình thường; khi máy thức dậy từ Sleep, tuyến Remote HTTPS được kiểm tra an toàn fail-closed và không bao giờ tự mở lại ngầm.',
          'Truyền phát nguyên bản trên Host (Direct Streaming + HTTP 206 Range), không chuyển mã hay sửa file nhạc gốc; khi tắt Host hoặc thu hồi thiết bị, mọi kết nối, bộ đệm giải mã và khóa giữ thức đều được giải phóng ngay lập tức.',
        ],
      },
    ],
  },
  {
    id: 'ch-14-phim-tat-meo',
    number: '14',
    title: 'Phím tắt & Mẹo sử dụng nhanh',
    summary:
      'Tổng hợp các phím tắt đang được hỗ trợ trực tiếp trong ứng dụng cùng mẹo thao tác nhanh trên Thư viện và Player.',
    keywords: ['phim tat', 'meo', 'alt+m', 'esc', 'shift+click', 'hotkey'],
    sections: [
      {
        id: 'ch-14-shortcuts',
        heading: 'Phím tắt & thao tác được hỗ trợ',
        paragraphs: [
          'Các phím tắt và cử chỉ đang hoạt động trong DoReMi Windows:',
        ],
        bullets: [
          'Alt + M (tại màn hình Đang phát / Focus Vinyl): Ẩn hoặc hiện nhanh thanh Sidebar điều hướng.',
          'Rê chuột vào mép trái (vùng 12px ngoài cùng) tại màn hình Đang phát: Hiện tạm thanh Sidebar để chuyển trang nhanh.',
          'Esc: Đóng nhanh các hộp thoại đang mở (Tạo/Thêm Playlist, Chỉnh sửa Metadata...).',
          'Shift + Click (khi bật Chọn nhiều trong Thư viện): Chọn liên tiếp cả dải bài hát từ điểm chọn trước đó.',
          'Click nút nổi "Về đầu trang" (góc dưới phải Thư viện): Cuộn mượt lên đầu danh sách bài hát.',
        ],
        note: 'DoReMi hiện tập trung vào điều khiển chuẩn xác trong cửa sổ ứng dụng, chưa đăng ký phím tắt đa phương tiện toàn cục mức hệ điều hành để tránh xung đột với các phần mềm khác.',
      },
    ],
  },
  {
    id: 'ch-15-xu-ly-su-co',
    number: '15',
    title: 'Xử lý sự cố thường gặp (FAQ)',
    summary:
      'Giải pháp nhanh cho các tình huống thực tế: bài hát Thiếu file, lỗi ký tự lời bài hát, máy cấu hình thấp và kiểm tra ảnh bìa/âm thanh.',
    keywords: ['su co', 'faq', 'loi', 'giat lag', 'font', 'relink', 'troubleshooting'],
    sections: [
      {
        id: 'ch-15-faq',
        heading: 'Câu hỏi & cách khắc phục nhanh',
        paragraphs: [
          'Nếu gặp vấn đề trong quá trình sử dụng, bạn có thể tự kiểm tra theo các gợi ý bên dưới:',
        ],
        bullets: [
          'Bài hát hiện "Thiếu file": Tệp gốc đã đổi tên hoặc chuyển sang thư mục/ổ đĩa khác. Hãy vào quản lý Nguồn & File thiếu để dùng Relink tìm lại file mà không mất lịch sử nghe.',
          'Lời bài hát bị lỗi ô vuông hoặc sai ký tự tiếng Việt / Nhật / Hoa: Chọn lại đúng bảng mã (Windows-1258, Shift-JIS, GBK, UTF-8...) ngay khi nhập tệp .lrc / .txt.',
          'Máy cấu hình yếu bị giật khi bật đĩa than hoặc ảnh nền: Vào Cá nhân hóa, đặt Chất lượng giao diện về "Tiết kiệm tài nguyên" (Power Saver) hoặc bật "Giảm chuyển động".',
          'Một số file ALAC (.m4a) không mở được ở trình phát mặc định nhưng vẫn phát trên DoReMi: Bình thường — DoReMi tích hợp bộ giải mã @mgz-dev/alac WebAssembly nội bộ để phát trực tiếp file ALAC chuẩn.',
          'Báo lỗi gói thông tin Remote Endpoint hết hạn (REMOTE_ENDPOINT_EXPIRED) khi ở ngoài mạng nhà: Để bảo mật, gói địa chỉ Remote HTTPS đã ký có thời hạn hiệu lực. Khi mang máy về mạng Wi-Fi nhà, chỉ cần kết nối LAN với Host (chế độ Tự động sẽ tự làm mới hoặc bấm "Đồng bộ Remote") để gia hạn.',
          'Máy Host tự chuyển sang Sleep khi bạn để ở nhà đi ra ngoài: Mặc định DoReMi chọn "Theo hệ thống" để tôn trọng cài đặt tiết kiệm điện của Windows. Nếu muốn nghe từ xa lâu dài, hãy chọn "Giữ thức khi đang phát từ xa" hoặc "Giữ thức khi bật Host" trong trang Server (màn hình vẫn tắt bình thường để bảo vệ tấm nền). Lưu ý không thể đánh thức máy tính đã ngủ qua Internet công cộng.',
          'Muốn kiểm tra đường dẫn dữ liệu SQLite: Mở Cài đặt -> Thư viện nhạc để xem vị trí chính xác của library.db.',
        ],
      },
    ],
  },
];
