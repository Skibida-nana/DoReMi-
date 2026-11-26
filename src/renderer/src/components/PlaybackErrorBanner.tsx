import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronUp, Copy, RotateCcw } from 'lucide-react';
import type { PlaybackErrorDetails } from '../../../shared/types/player';
import type { DiagnosticLogEntry } from '../../../shared/types/stage6';
import { formatPlaybackDiagnosticReport } from '../player/playback-error';

interface PlaybackErrorBannerProps {
  errorMessage: string | null;
  playbackError?: PlaybackErrorDetails | null;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}

export function PlaybackErrorBanner({
  errorMessage,
  playbackError,
  onRetry,
  compact = false,
  className = '',
}: PlaybackErrorBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const summary = playbackError?.summary ?? errorMessage;
  if (!summary) {
    return null;
  }

  const handleCopyDiagnostics = async () => {
    let logs: DiagnosticLogEntry[] = [];
    try {
      logs = (await window.losslessApi?.getDiagnosticLogs?.()) ?? [];
    } catch {
      logs = [];
    }
    const report = formatPlaybackDiagnosticReport(playbackError ?? null, logs);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // Ignore clipboard permission errors cleanly
    }
  };

  return (
    <div
      role="alert"
      data-testid="playback-error-banner"
      className={`rounded-2xl border border-rose-500/35 bg-rose-950/80 text-rose-100 shadow-lg backdrop-blur-md ${
        compact ? 'px-3.5 py-2 text-[12px]' : 'px-4 py-2.5 text-[12.5px]'
      } ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium">{summary}</span>
          {playbackError?.code && (
            <span className="font-mono-tabular hidden shrink-0 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10.5px] text-rose-200 sm:inline-block">
              {playbackError.code}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-full bg-rose-500/25 px-2.5 py-1 text-[11px] font-medium text-rose-100 transition hover:bg-rose-500/40"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Thử lại
            </button>
          )}

          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-rose-100 transition hover:bg-white/18"
          >
            {expanded ? (
              <>
                Ẩn chi tiết <ChevronUp className="h-3 w-3" aria-hidden="true" />
              </>
            ) : (
              <>
                Xem chi tiết <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => void handleCopyDiagnostics()}
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-rose-100 transition hover:bg-white/18"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-300" aria-hidden="true" />
                Đã chép
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" aria-hidden="true" />
                Sao chép chẩn đoán
              </>
            )}
          </button>
        </div>
      </div>

      {expanded && playbackError && (
        <div className="mt-2 space-y-1 border-t border-rose-400/20 pt-2 text-[11.5px] text-rose-100/90">
          <p>{playbackError.suggestion}</p>
          <p className="font-mono-tabular break-all text-[10.5px] text-rose-200/80">
            {playbackError.technicalDetail}
          </p>
        </div>
      )}
    </div>
  );
}
