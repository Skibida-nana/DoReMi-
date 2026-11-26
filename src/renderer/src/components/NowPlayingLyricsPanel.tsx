import { memo, type RefObject } from 'react';
import { FileText, Plus, Upload } from 'lucide-react';
import type { ResolvedTrackLyrics } from '../../../shared/types/track';
import type { TimedLyricGroup } from '../../../shared/utils/lyrics-parser';

interface NowPlayingLyricsPanelProps {
  sourceLabel: string;
  isLoadingLyrics: boolean;
  isLrcLyrics: boolean;
  isTxtLyrics: boolean;
  lyricGroups: readonly TimedLyricGroup[];
  effectiveActiveLyricIdx: number;
  resolvedLyrics: ResolvedTrackLyrics;
  isManualScrolling: boolean;
  accentHex: string;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  activeLineRef: RefObject<HTMLButtonElement | null>;
  onManualScroll: () => void;
  onSeekToLine: (timeSec: number) => void;
  onResyncLyrics: () => void;
  onOpenLyricsEditor: () => void;
  onImportLyricsFile: () => void;
}

/**
 * Memoized Editorial Lyrics Viewport:
 * Depends strictly on `effectiveActiveLyricIdx` (integer) rather than ticking `currentTimeSec`,
 * so continuous audio progress updates trigger ZERO lyric DOM diffing between line transitions.
 */
export const NowPlayingLyricsPanel = memo(function NowPlayingLyricsPanel({
  sourceLabel,
  isLoadingLyrics,
  isLrcLyrics,
  isTxtLyrics,
  lyricGroups,
  effectiveActiveLyricIdx,
  resolvedLyrics,
  isManualScrolling,
  accentHex,
  lyricsContainerRef,
  activeLineRef,
  onManualScroll,
  onSeekToLine,
  onResyncLyrics,
  onOpenLyricsEditor,
  onImportLyricsFile,
}: NowPlayingLyricsPanelProps) {
  return (
    <div
      data-testid="now-playing-lyrics-panel"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <span data-testid="lyrics-source-badge" className="sr-only">
        {sourceLabel}
      </span>

      {isLoadingLyrics ? (
        <div className="flex flex-1 items-center text-[14px] text-[var(--np-text-muted)]">
          Đang tải lời bài hát...
        </div>
      ) : isLrcLyrics ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={lyricsContainerRef}
            onWheel={onManualScroll}
            onTouchMove={onManualScroll}
            data-testid="lyrics-scroll-region"
            className="flex-1 overflow-y-auto overflow-x-hidden pr-3"
            style={{
              paddingTop: '18%',
              paddingBottom: '36%',
              maskImage:
                'linear-gradient(180deg, transparent 0%, black 10%, black 88%, transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(180deg, transparent 0%, black 10%, black 88%, transparent 100%)',
            }}
          >
            <div className="space-y-4">
              {lyricGroups.map((group, groupIdx) => {
                const isActive = groupIdx === effectiveActiveLyricIdx;
                const dist = Math.abs(groupIdx - effectiveActiveLyricIdx);
                const lineOpacity = isActive
                  ? 1
                  : dist === 1
                    ? 0.78
                    : dist === 2
                      ? 0.62
                      : 0.46;

                return (
                  <button
                    key={`${group.timeSec}-${groupIdx}`}
                    ref={isActive ? activeLineRef : null}
                    type="button"
                    data-testid={isActive ? 'active-lyric-line' : 'lyric-line'}
                    data-active={isActive ? 'true' : 'false'}
                    onClick={() => onSeekToLine(group.timeSec)}
                    style={{ opacity: lineOpacity }}
                    className="lp-lyrics-text block w-full text-left text-[var(--np-text-primary)] transition-opacity duration-200 hover:!opacity-95 focus-visible:outline-none focus-visible:underline"
                  >
                    {group.lines.map((lineText, subIdx) => (
                      <span
                        key={`${group.timeSec}-${groupIdx}-${subIdx}`}
                        className={
                          subIdx === 0
                            ? isActive
                              ? 'font-display block font-semibold tracking-[-0.015em]'
                              : dist <= 1
                                ? 'block font-medium'
                                : 'block font-normal'
                            : isActive
                              ? 'mt-1 block text-[15.5px] font-normal leading-[1.5] text-[var(--np-text-secondary)]'
                              : 'mt-0.5 block text-[13.5px] font-normal leading-[1.48] text-[var(--np-text-muted)]'
                        }
                        style={
                          subIdx === 0
                            ? {
                                fontSize: isActive
                                  ? 'clamp(24px, 1.95vw, 29px)'
                                  : dist === 1
                                    ? 'clamp(19px, 1.48vw, 22px)'
                                    : 'clamp(17.5px, 1.32vw, 20px)',
                                lineHeight: isActive ? 1.4 : 1.5,
                              }
                            : undefined
                        }
                      >
                        {lineText}
                      </span>
                    ))}
                  </button>
                );
              })}
            </div>
          </div>

          {isManualScrolling && (
            <button
              type="button"
              data-testid="btn-resync-lyrics"
              onClick={onResyncLyrics}
              style={{
                backgroundColor: 'var(--np-btn-primary-bg, var(--np-text-primary))',
                color: 'var(--np-btn-primary-fg, var(--np-bg))',
              }}
              className="absolute bottom-3 left-0 flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px] font-semibold shadow-md transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: accentHex }}
              />
              Quay về lời đang hát
            </button>
          )}
        </div>
      ) : isTxtLyrics ? (
        <div
          data-testid="lyrics-static-region"
          className="flex-1 overflow-y-auto overflow-x-hidden py-5 pr-3"
        >
          <div className="lp-lyrics-text space-y-3 text-[17px] leading-[1.68] text-[var(--np-text-primary)]">
            {resolvedLyrics.plainLines.map((line, index) =>
              line.trim() === '' ? (
                <div key={`gap-${index}`} className="h-2.5" aria-hidden="true" />
              ) : (
                <p key={`txt-${index}`}>{line}</p>
              ),
            )}
          </div>
        </div>
      ) : (
        <div
          data-testid="lyrics-empty-state"
          className="flex flex-1 flex-col items-start justify-center py-6"
        >
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl border text-[var(--np-text-primary)]"
            style={{
              borderColor: 'var(--np-divider)',
              backgroundColor: 'var(--np-btn-ghost-bg)',
            }}
          >
            <FileText className="h-4.5 w-4.5" />
          </div>
          <p className="mt-3 text-[16px] font-semibold text-[var(--np-text-primary)]">
            Chưa có lời bài hát
          </p>
          <p className="mt-1 max-w-[320px] text-[13px] leading-relaxed text-[var(--np-text-secondary)]">
            Thêm lời LRC đồng bộ hoặc nhập file .lrc / .txt trực tiếp từ máy tính.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="btn-empty-add-lyrics"
              onClick={onOpenLyricsEditor}
              style={{
                backgroundColor: 'var(--np-btn-primary-bg, var(--np-text-primary))',
                color: 'var(--np-btn-primary-fg, var(--np-bg))',
              }}
              className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-semibold shadow-sm transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Thêm lời bài hát</span>
            </button>
            <button
              type="button"
              onClick={onImportLyricsFile}
              style={{
                backgroundColor: 'var(--np-btn-ghost-bg)',
                color: 'var(--np-btn-ghost-fg, var(--np-text-primary))',
                borderColor: 'var(--np-btn-ghost-border, var(--np-divider))',
              }}
              className="flex h-9 items-center gap-1.5 rounded-full border px-4 text-[12px] font-medium backdrop-blur-xs transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Nhập file .lrc / .txt</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
