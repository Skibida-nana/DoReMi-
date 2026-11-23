import {
  AlertCircle,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { playerActions, usePlaybackState } from '../stores/player-store';
import {
  formatDurationSeconds,
  formatPlaybackStatusLabel,
  formatTrackAudioSpecs,
} from '../utils/formatters';

export function PlaybackBar() {
  const playback = usePlaybackState();
  const {
    status,
    currentTrack,
    currentTimeSeconds,
    durationSeconds,
    volume,
    muted,
    errorMessage,
    canPrevious,
    canNext,
  } = playback;

  const isPlaying = status === 'playing';
  const isLoading = status === 'loading';
  const canSeek = Boolean(currentTrack && durationSeconds > 0);
  const clampedTime = Math.min(currentTimeSeconds, durationSeconds || 0);

  return (
    <footer
      aria-label="Thanh điều khiển phát nhạc"
      className="border-t border-zinc-800/90 bg-zinc-950 px-5 py-3 shrink-0"
    >
      {errorMessage && (
        <div
          role="alert"
          className="mb-2.5 flex items-center gap-2 rounded border border-rose-500/35 bg-rose-950/35 px-3 py-1.5 text-xs text-rose-200"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
          <span className="truncate">{errorMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-[minmax(200px,1fr)_minmax(320px,1.5fr)_minmax(180px,1fr)] items-center gap-6">
        {/* Left: Now Playing Track Metadata */}
        <div className="min-w-0">
          {currentTrack ? (
            <>
              <p className="truncate text-sm font-medium text-zinc-100">{currentTrack.title}</p>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-zinc-400">
                <span className="truncate">{currentTrack.artist}</span>
                <span aria-hidden="true" className="text-zinc-600">
                  ·
                </span>
                <span className="font-mono-tabular text-zinc-500 shrink-0">
                  {formatTrackAudioSpecs(currentTrack)}
                </span>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-zinc-400">Chưa chọn bài hát</p>
              <p className="mt-0.5 text-xs text-zinc-600">Chọn một bài trong thư viện để phát</p>
            </>
          )}
        </div>

        {/* Center: Transport Controls + Seek Slider */}
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void playerActions.previous()}
              disabled={!canPrevious}
              aria-label="Bài trước"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <SkipBack className="h-4 w-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => void playerActions.togglePlayPause()}
              disabled={!currentTrack && !canNext}
              aria-label={isPlaying ? 'Tạm dừng' : 'Phát nhạc'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4 fill-current" aria-hidden="true" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={() => void playerActions.next()}
              disabled={!canNext}
              aria-label="Bài tiếp theo"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <SkipForward className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="flex w-full max-w-lg items-center gap-2.5">
            <span
              data-testid="playback-current-time"
              className="w-11 text-right font-mono-tabular text-[11px] text-zinc-400"
            >
              {formatDurationSeconds(clampedTime)}
            </span>

            <input
              type="range"
              min={0}
              max={durationSeconds > 0 ? durationSeconds : 100}
              step={0.1}
              value={canSeek ? clampedTime : 0}
              disabled={!canSeek}
              onChange={(event) => playerActions.seek(Number(event.target.value))}
              aria-label="Tua vị trí bài hát"
              className="lp-slider h-4 flex-1"
            />

            <span
              data-testid="playback-duration"
              className="w-11 font-mono-tabular text-[11px] text-zinc-500"
            >
              {formatDurationSeconds(durationSeconds > 0 ? durationSeconds : null)}
            </span>
          </div>
        </div>

        {/* Right: Playback Status + Volume Control */}
        <div className="flex items-center justify-end gap-4">
          <span
            data-testid="playback-status"
            className={`text-xs whitespace-nowrap ${
              status === 'error'
                ? 'text-rose-400'
                : status === 'playing'
                  ? 'text-sky-400'
                  : 'text-zinc-400'
            }`}
          >
            {formatPlaybackStatusLabel(status)}
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => playerActions.toggleMute()}
              aria-label={muted || volume === 0 ? 'Bật âm thanh' : 'Tắt âm thanh'}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Volume2 className="h-4 w-4" aria-hidden="true" />
              )}
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(event) => playerActions.setVolume(Number(event.target.value))}
              aria-label="Âm lượng"
              className="lp-slider h-4 w-24"
            />

            <span className="w-8 text-right font-mono-tabular text-[11px] text-zinc-500">
              {Math.round((muted ? 0 : volume) * 100)}%
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
