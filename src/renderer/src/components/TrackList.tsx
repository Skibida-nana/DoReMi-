import { AlertTriangle, Music, Pause, Play } from 'lucide-react';
import type { TrackRecord } from '../../../shared/types/track';
import { libraryStore, useLibraryState } from '../stores/library-store';
import {
  playerActions,
  usePlaybackStatus,
  usePlaybackTrackId,
} from '../stores/player-store';
import { formatDurationMs, formatTrackAudioSpecs } from '../utils/formatters';

interface TrackListProps {
  tracks: TrackRecord[];
}

export function TrackList({ tracks }: TrackListProps) {
  const { isLoadingInitial, isElectronAvailable, searchQuery, filterMode } = useLibraryState();
  const playbackTrackId = usePlaybackTrackId();
  const playbackStatus = usePlaybackStatus();

  if (isLoadingInitial) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-zinc-400">
        Đang tải danh sách bài hát từ thư viện...
      </div>
    );
  }

  if (tracks.length === 0) {
    const isFiltered = searchQuery.trim().length > 0 || filterMode !== 'all';
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <Music className="h-5 w-5 text-zinc-500" aria-hidden="true" />
        </div>
        <h2 className="text-sm font-medium text-zinc-200">
          {isFiltered
            ? 'Không có bài hát nào khớp với bộ lọc hiện tại'
            : 'Thư viện nhạc của bạn đang trống'}
        </h2>
        <p className="mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">
          {isFiltered
            ? 'Thử xóa từ khóa tìm kiếm hoặc chuyển về chế độ "Tất cả bài hát".'
            : 'Import file FLAC, MP3, WAV hoặc chọn cả thư mục nhạc. DoReMi giữ nguyên file gốc tại vị trí cũ và lưu thông tin trong thư viện cục bộ.'}
        </p>
        {!isFiltered && isElectronAvailable && (
          <div className="mt-5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void libraryStore.importFiles()}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-xs font-medium text-zinc-100 hover:bg-zinc-800"
            >
              Import Files
            </button>
            <button
              type="button"
              onClick={() => void libraryStore.importFolder()}
              className="rounded-md bg-sky-500 px-3.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-sky-400"
            >
              Import Folder
            </button>
          </div>
        )}
      </div>
    );
  }

  const handleRowPlayToggle = (track: TrackRecord) => {
    const isCurrent = playbackTrackId === track.id;
    if (isCurrent && (playbackStatus === 'playing' || playbackStatus === 'loading')) {
      playerActions.pause();
      return;
    }
    if (isCurrent && playbackStatus === 'paused') {
      void playerActions.resume();
      return;
    }
    void playerActions.play(track.id);
  };

  return (
    <div className="flex-1 overflow-auto px-5 py-3">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="sticky top-0 z-10 bg-zinc-950 text-xs font-medium text-zinc-500">
          <tr className="border-b border-zinc-800/90">
            <th scope="col" className="w-12 py-2.5 pl-2 pr-2 text-center">
              #
            </th>
            <th scope="col" className="w-[32%] py-2.5 pr-4">
              Bài hát / Nghệ sĩ
            </th>
            <th scope="col" className="w-[20%] py-2.5 pr-4">
              Album
            </th>
            <th scope="col" className="w-[28%] py-2.5 pr-4">
              Định dạng
            </th>
            <th scope="col" className="w-20 py-2.5 pr-3 text-right">
              Thời lượng
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-900/90">
          {tracks.map((track, index) => {
            const isCurrent = playbackTrackId === track.id;
            const isPlaying = isCurrent && playbackStatus === 'playing';
            const isMissing = track.status === 'missing';
            const isError = track.status === 'error';

            return (
              <tr
                key={track.id}
                data-testid={`track-row-${track.id}`}
                data-status={track.status}
                className={`group transition-colors ${
                  isCurrent
                    ? 'bg-sky-500/10'
                    : 'hover:bg-zinc-900/70'
                } ${isMissing ? 'opacity-65' : ''}`}
              >
                <td className="py-2.5 pl-2 pr-2 text-center align-middle">
                  <button
                    type="button"
                    onClick={() => handleRowPlayToggle(track)}
                    aria-label={
                      isPlaying
                        ? `Tạm dừng ${track.title}`
                        : `Phát ${track.title}`
                    }
                    className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${
                      isCurrent
                        ? 'text-sky-400 hover:bg-sky-500/15'
                        : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                    }`}
                  >
                    {isPlaying ? (
                      <Pause className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                    ) : (
                      <>
                        <span className="font-mono-tabular text-xs group-hover:hidden">
                          {index + 1}
                        </span>
                        <Play
                          className="hidden h-3.5 w-3.5 fill-current group-hover:block"
                          aria-hidden="true"
                        />
                      </>
                    )}
                  </button>
                </td>

                <td className="py-2.5 pr-4 align-middle">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        type="button"
                        onClick={() => handleRowPlayToggle(track)}
                        className={`truncate text-left font-medium transition-colors hover:underline focus-visible:outline-none focus-visible:underline ${
                          isCurrent
                            ? 'text-sky-400'
                            : isMissing
                              ? 'text-zinc-400 line-through decoration-zinc-600'
                              : 'text-zinc-100'
                        }`}
                        title={track.original_path}
                      >
                        {track.title}
                      </button>

                      {isMissing && (
                        <span
                          className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 whitespace-nowrap shrink-0"
                          title={`File không còn tại: ${track.original_path}`}
                        >
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          Thiếu file
                        </span>
                      )}

                      {isError && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-400 whitespace-nowrap shrink-0">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          Lỗi đọc file
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 truncate text-xs text-zinc-400">{track.artist}</p>
                  </div>
                </td>

                <td className="py-2.5 pr-4 align-middle">
                  <p className="truncate text-xs text-zinc-400">{track.album ?? '—'}</p>
                </td>

                <td className="py-2.5 pr-4 align-middle">
                  <p className="truncate font-mono-tabular text-xs text-zinc-400">
                    {formatTrackAudioSpecs(track)}
                  </p>
                </td>

                <td className="py-2.5 pr-3 text-right align-middle font-mono-tabular text-xs text-zinc-400">
                  {formatDurationMs(track.duration_ms)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
