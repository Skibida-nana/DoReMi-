import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Info,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  TrackArtworkSource,
  TrackAvailabilityState,
  TrackMetadataOverrideInput,
  TrackRecord,
} from '../../../shared/types/track';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { OverlayPortal } from './OverlayLayer';
import { formatDurationSeconds, formatFileSize } from '../utils/formatters';

export interface TrackMetadataEditTarget {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  genre: string | null;
  year: number | null;
  albumArtist: string | null;
  trackNumber: number | null;
  trackTotal: number | null;
  discNumber: number | null;
  discTotal: number | null;
  composer: string | null;
  lyricist: string | null;
  comment: string | null;

  originalTitle: string;
  originalArtist: string;
  originalAlbum: string | null;
  originalGenre: string | null;
  originalYear: number | null;
  originalAlbumArtist: string | null;
  originalTrackNumber: number | null;
  originalTrackTotal: number | null;
  originalDiscNumber: number | null;
  originalDiscTotal: number | null;
  originalComposer: string | null;
  originalLyricist: string | null;
  originalComment: string | null;

  hasOverride: boolean;
  artworkUrl: string | null;
  artworkSource: TrackArtworkSource;
  hasCustomArtwork: boolean;

  codec: string | null;
  container: string | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  bitrateBps: number | null;
  channels: number | null;
  encoder: string | null;
  durationMs: number | null;
  fileSizeBytes: number | null;
  fileName: string | null;
  filePath: string;
  availabilityState: TrackAvailabilityState;
}

export function buildMetadataEditTargetFromTrack(track: TrackRecord): TrackMetadataEditTarget {
  const originalAlbum =
    track.original_album !== undefined ? track.original_album : track.album;
  const originalGenre =
    track.original_genre !== undefined ? track.original_genre : track.genre ?? null;
  const originalYear =
    track.original_year !== undefined ? track.original_year : track.year ?? null;
  const originalAlbumArtist =
    track.original_album_artist !== undefined
      ? track.original_album_artist
      : track.album_artist ?? null;
  const originalTrackNumber =
    track.original_track_number !== undefined
      ? track.original_track_number
      : track.track_number ?? null;
  const originalTrackTotal =
    track.original_track_total !== undefined
      ? track.original_track_total
      : track.track_total ?? null;
  const originalDiscNumber =
    track.original_disc_number !== undefined
      ? track.original_disc_number
      : track.disc_number ?? null;
  const originalDiscTotal =
    track.original_disc_total !== undefined
      ? track.original_disc_total
      : track.disc_total ?? null;
  const originalComposer =
    track.original_composer !== undefined
      ? track.original_composer
      : track.composer ?? null;
  const originalLyricist =
    track.original_lyricist !== undefined
      ? track.original_lyricist
      : track.lyricist ?? null;
  const originalComment =
    track.original_comment !== undefined
      ? track.original_comment
      : track.comment ?? null;

  return {
    id: track.id,
    title: track.title,
    artist: track.artist ?? 'Unknown Artist',
    album: track.album,
    genre: track.genre ?? null,
    year: track.year ?? null,
    albumArtist: track.album_artist ?? null,
    trackNumber: track.track_number ?? null,
    trackTotal: track.track_total ?? null,
    discNumber: track.disc_number ?? null,
    discTotal: track.disc_total ?? null,
    composer: track.composer ?? null,
    lyricist: track.lyricist ?? null,
    comment: track.comment ?? null,

    originalTitle: track.original_title ?? track.title,
    originalArtist: track.original_artist ?? track.artist ?? 'Unknown Artist',
    originalAlbum,
    originalGenre,
    originalYear,
    originalAlbumArtist,
    originalTrackNumber,
    originalTrackTotal,
    originalDiscNumber,
    originalDiscTotal,
    originalComposer,
    originalLyricist,
    originalComment,

    hasOverride: Boolean(
      track.title_override ||
        track.artist_override ||
        track.album_override ||
        track.genre_override ||
        track.year_override ||
        track.album_artist_override ||
        track.track_number_override ||
        track.track_total_override ||
        track.disc_number_override ||
        track.disc_total_override ||
        track.composer_override ||
        track.lyricist_override ||
        track.comment_override,
    ),
    artworkUrl: track.artwork_url ?? track.artwork_thumb_url ?? null,
    artworkSource: track.artwork_source ?? 'default',
    hasCustomArtwork: Boolean(track.has_custom_artwork),

    codec: track.codec,
    container: track.container,
    sampleRateHz: track.sample_rate_hz,
    bitDepth: track.bit_depth,
    bitrateBps: track.bitrate_bps,
    channels: track.channels ?? null,
    encoder: track.encoder ?? null,
    durationMs: track.duration_ms,
    fileSizeBytes: track.file_size_bytes,
    fileName: track.file_name ?? null,
    filePath: track.original_path,
    availabilityState:
      track.availability_state ?? (track.status === 'error' ? 'access_error' : track.status),
  };
}

interface TrackMetadataModalProps {
  target: TrackMetadataEditTarget | null;
  isSaving?: boolean;
  onClose: () => void;
  onSave: (trackId: string, input: TrackMetadataOverrideInput) => Promise<void> | void;
  onRestoreOriginal: (trackId: string) => Promise<void> | void;
  onImportCustomArtwork?: (trackId: string) => Promise<void> | void;
  onRemoveCustomArtwork?: (trackId: string) => Promise<void> | void;
}

function artworkSourceText(src: TrackArtworkSource): string {
  switch (src) {
    case 'custom':
      return 'Ảnh bìa tùy chỉnh (DoReMi)';
    case 'embedded':
      return 'Ảnh bìa nhúng trong file';
    case 'folder':
      return 'Ảnh cover.jpg / folder.jpg';
    default:
      return 'Ảnh mặc định DoReMi';
  }
}

function parseOptionalIntInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return Number.NaN;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export function TrackMetadataModal({
  target,
  isSaving = false,
  onClose,
  onSave,
  onRestoreOriginal,
  onImportCustomArtwork,
  onRemoveCustomArtwork,
}: TrackMetadataModalProps) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [yearText, setYearText] = useState('');
  const [genre, setGenre] = useState('');
  const [albumArtist, setAlbumArtist] = useState('');
  const [trackNumberText, setTrackNumberText] = useState('');
  const [trackTotalText, setTrackTotalText] = useState('');
  const [discNumberText, setDiscNumberText] = useState('');
  const [discTotalText, setDiscTotalText] = useState('');
  const [composer, setComposer] = useState('');
  const [lyricist, setLyricist] = useState('');
  const [comment, setComment] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!target) {
      return;
    }
    setTitle(target.title);
    setArtist(target.artist);
    setAlbum(target.album ?? '');
    setYearText(target.year ? String(target.year) : '');
    setGenre(target.genre ?? '');
    setAlbumArtist(target.albumArtist ?? '');
    setTrackNumberText(target.trackNumber ? String(target.trackNumber) : '');
    setTrackTotalText(target.trackTotal ? String(target.trackTotal) : '');
    setDiscNumberText(target.discNumber ? String(target.discNumber) : '');
    setDiscTotalText(target.discTotal ? String(target.discTotal) : '');
    setComposer(target.composer ?? '');
    setLyricist(target.lyricist ?? '');
    setComment(target.comment ?? '');
    setConfirmDiscard(false);
    setErrorMessage(null);
  }, [target?.id]);

  if (!target) {
    return null;
  }

  const trimmedTitle = title.normalize('NFC').trim();
  const trimmedArtist = artist.normalize('NFC').trim();
  const trimmedAlbum = album.normalize('NFC').trim();
  const trimmedGenre = genre.normalize('NFC').trim();
  const trimmedAlbumArtist = albumArtist.normalize('NFC').trim();
  const trimmedComposer = composer.normalize('NFC').trim();
  const trimmedLyricist = lyricist.normalize('NFC').trim();
  const trimmedComment = comment.normalize('NFC').trim();

  const isDirty =
    trimmedTitle !== target.title.normalize('NFC').trim() ||
    trimmedArtist !== target.artist.normalize('NFC').trim() ||
    trimmedAlbum !== (target.album ?? '').normalize('NFC').trim() ||
    yearText.trim() !== (target.year ? String(target.year) : '') ||
    trimmedGenre !== (target.genre ?? '').normalize('NFC').trim() ||
    trimmedAlbumArtist !== (target.albumArtist ?? '').normalize('NFC').trim() ||
    trackNumberText.trim() !== (target.trackNumber ? String(target.trackNumber) : '') ||
    trackTotalText.trim() !== (target.trackTotal ? String(target.trackTotal) : '') ||
    discNumberText.trim() !== (target.discNumber ? String(target.discNumber) : '') ||
    discTotalText.trim() !== (target.discTotal ? String(target.discTotal) : '') ||
    trimmedComposer !== (target.composer ?? '').normalize('NFC').trim() ||
    trimmedLyricist !== (target.lyricist ?? '').normalize('NFC').trim() ||
    trimmedComment !== (target.comment ?? '').normalize('NFC').trim();

  const hasAnyOverride =
    target.hasOverride ||
    trimmedTitle !== target.originalTitle ||
    trimmedArtist !== target.originalArtist ||
    trimmedAlbum !== (target.originalAlbum ?? '') ||
    trimmedGenre !== (target.originalGenre ?? '') ||
    yearText.trim() !== (target.originalYear ? String(target.originalYear) : '') ||
    trimmedAlbumArtist !== (target.originalAlbumArtist ?? '') ||
    trimmedComposer !== (target.originalComposer ?? '') ||
    trimmedLyricist !== (target.originalLyricist ?? '') ||
    trimmedComment !== (target.originalComment ?? '');

  const handleRequestClose = () => {
    if (isDirty && !confirmDiscard && !isSaving) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedTitle) {
      setErrorMessage('Tên bài hát không được để trống.');
      return;
    }
    if (!trimmedArtist) {
      setErrorMessage('Tên nghệ sĩ không được để trống.');
      return;
    }

    const parsedYear = parseOptionalIntInput(yearText);
    if (yearText.trim() && (Number.isNaN(parsedYear) || (parsedYear ?? 0) < 1000 || (parsedYear ?? 0) > 2999)) {
      setErrorMessage('Năm phát hành phải là số từ 1000 đến 2999 hoặc để trống.');
      return;
    }

    const parsedTrackNum = parseOptionalIntInput(trackNumberText);
    const parsedTrackTotal = parseOptionalIntInput(trackTotalText);
    const parsedDiscNum = parseOptionalIntInput(discNumberText);
    const parsedDiscTotal = parseOptionalIntInput(discTotalText);

    if (
      Number.isNaN(parsedTrackNum) ||
      Number.isNaN(parsedTrackTotal) ||
      Number.isNaN(parsedDiscNum) ||
      Number.isNaN(parsedDiscTotal)
    ) {
      setErrorMessage('Số Track / Disc phải là số nguyên dương hợp lệ.');
      return;
    }

    setErrorMessage(null);
    await onSave(target.id, {
      titleOverride: trimmedTitle !== target.originalTitle ? trimmedTitle : null,
      artistOverride: trimmedArtist !== target.originalArtist ? trimmedArtist : null,
      albumOverride: trimmedAlbum !== (target.originalAlbum ?? '') ? trimmedAlbum : null,
      genreOverride: trimmedGenre !== (target.originalGenre ?? '') ? trimmedGenre : null,
      yearOverride: parsedYear !== target.originalYear ? parsedYear : null,
      albumArtistOverride:
        trimmedAlbumArtist !== (target.originalAlbumArtist ?? '') ? trimmedAlbumArtist : null,
      trackNumberOverride:
        parsedTrackNum !== target.originalTrackNumber ? parsedTrackNum : null,
      trackTotalOverride:
        parsedTrackTotal !== target.originalTrackTotal ? parsedTrackTotal : null,
      discNumberOverride: parsedDiscNum !== target.originalDiscNumber ? parsedDiscNum : null,
      discTotalOverride: parsedDiscTotal !== target.originalDiscTotal ? parsedDiscTotal : null,
      composerOverride:
        trimmedComposer !== (target.originalComposer ?? '') ? trimmedComposer : null,
      lyricistOverride:
        trimmedLyricist !== (target.originalLyricist ?? '') ? trimmedLyricist : null,
      commentOverride:
        trimmedComment !== (target.originalComment ?? '') ? trimmedComment : null,
    });
    onClose();
  };

  const handleRestoreAll = async () => {
    await onRestoreOriginal(target.id);
    onClose();
  };

  return (
    <OverlayPortal layer="modal">
      <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        role="dialog"
        aria-modal="true"
        aria-label="Chỉnh sửa thông tin bài hát"
        data-testid="metadata-edit-modal"
        className="lp-glass-pill flex max-h-[92vh] w-full max-w-[660px] flex-col overflow-hidden rounded-[26px]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-6 py-4">
          <div>
            <h2 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
              Chỉnh sửa thông tin bài hát
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
              Chỉnh sửa được lưu riêng trong thư viện DoReMi (không thay đổi file gốc).
            </p>
          </div>
          <button
            type="button"
            onClick={handleRequestClose}
            aria-label="Đóng"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable 4-Group Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-3.5 py-2.5 text-[11.5px] leading-relaxed text-emerald-700 dark:text-emerald-100/90">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
            <span>
              File âm thanh gốc trên ổ đĩa hoàn toàn không bị chỉnh sửa hoặc ghi đè tag. Bạn có thể đổi ảnh bìa hoặc khôi phục thông tin gốc riêng biệt bất kỳ lúc nào.
            </span>
          </div>

          {/* GROUP 1: Artwork */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4">
            <h3 className="text-[11px] font-semibold tracking-[0.14em] text-[var(--text-muted)] uppercase">
              Nhóm 1 · Ảnh bìa bài hát
            </h3>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-[var(--border-glass)] bg-black/20">
                <img
                  src={target.artworkUrl || DEFAULT_DOREMI_ARTWORK_URL}
                  alt={target.title}
                  data-testid="metadata-modal-artwork-preview"
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (img.dataset.fallbackApplied !== '1') {
                      img.dataset.fallbackApplied = '1';
                      img.src = DEFAULT_DOREMI_ARTWORK_URL;
                    }
                  }}
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-[12px] font-medium text-[var(--text-secondary)]">
                  Nguồn: <span className="text-[var(--text-primary)]">{artworkSourceText(target.artworkSource)}</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {onImportCustomArtwork && (
                    <button
                      type="button"
                      disabled={isSaving}
                      data-testid="metadata-modal-change-artwork-btn"
                      onClick={() => void onImportCustomArtwork(target.id)}
                      className="lp-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium text-[var(--text-primary)]"
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      <span>{target.hasCustomArtwork ? 'Thay ảnh bìa' : 'Chọn ảnh bìa...'}</span>
                    </button>
                  )}
                  {target.hasCustomArtwork && onRemoveCustomArtwork && (
                    <button
                      type="button"
                      disabled={isSaving}
                      data-testid="metadata-modal-restore-artwork-btn"
                      onClick={() => void onRemoveCustomArtwork(target.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3.5 text-[12px] font-medium text-amber-600 transition hover:bg-amber-500/18 dark:text-amber-200"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>Khôi phục ảnh gốc</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* GROUP 2: Basic Info */}
          <section className="space-y-3.5">
            <h3 className="text-[11px] font-semibold tracking-[0.14em] text-[var(--text-muted)] uppercase">
              Nhóm 2 · Thông tin cơ bản
            </h3>

            {/* Title */}
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="doremi-meta-title" className="text-[12px] font-medium text-[var(--text-primary)]">
                  Tên bài hát (Title) *
                </label>
                {trimmedTitle !== target.originalTitle && (
                  <button
                    type="button"
                    onClick={() => setTitle(target.originalTitle)}
                    className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Khôi phục
                  </button>
                )}
              </div>
              <input
                id="doremi-meta-title"
                data-testid="metadata-input-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
              />
              <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">Gốc: {target.originalTitle}</p>
            </div>

            {/* Artist & Album Grid */}
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="doremi-meta-artist" className="text-[12px] font-medium text-[var(--text-primary)]">
                    Nghệ sĩ (Artist) *
                  </label>
                  {trimmedArtist !== target.originalArtist && (
                    <button
                      type="button"
                      onClick={() => setArtist(target.originalArtist)}
                      className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Khôi phục
                    </button>
                  )}
                </div>
                <input
                  id="doremi-meta-artist"
                  data-testid="metadata-input-artist"
                  type="text"
                  value={artist}
                  onChange={(e) => setArtist(e.target.value)}
                  className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
                />
                <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">Gốc: {target.originalArtist}</p>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="doremi-meta-album" className="text-[12px] font-medium text-[var(--text-primary)]">
                    Album
                  </label>
                  {trimmedAlbum !== (target.originalAlbum ?? '') && (
                    <button
                      type="button"
                      onClick={() => setAlbum(target.originalAlbum ?? '')}
                      className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Khôi phục
                    </button>
                  )}
                </div>
                <input
                  id="doremi-meta-album"
                  data-testid="metadata-input-album"
                  type="text"
                  value={album}
                  onChange={(e) => setAlbum(e.target.value)}
                  placeholder="Để trống nếu không có album"
                  className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
                />
                <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                  Gốc: {target.originalAlbum || 'Không có'}
                </p>
              </div>
            </div>

            {/* Year & Genre */}
            <div className="grid gap-3.5 sm:grid-cols-2">
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="doremi-meta-year" className="text-[12px] font-medium text-[var(--text-primary)]">
                    Năm phát hành (Year)
                  </label>
                  {yearText.trim() !== (target.originalYear ? String(target.originalYear) : '') && (
                    <button
                      type="button"
                      onClick={() => setYearText(target.originalYear ? String(target.originalYear) : '')}
                      className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Khôi phục
                    </button>
                  )}
                </div>
                <input
                  id="doremi-meta-year"
                  data-testid="metadata-input-year"
                  type="text"
                  inputMode="numeric"
                  value={yearText}
                  onChange={(e) => setYearText(e.target.value)}
                  placeholder="Ví dụ: 2024"
                  className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="doremi-meta-genre" className="text-[12px] font-medium text-[var(--text-primary)]">
                    Thể loại (Genre)
                  </label>
                  {trimmedGenre !== (target.originalGenre ?? '') && (
                    <button
                      type="button"
                      onClick={() => setGenre(target.originalGenre ?? '')}
                      className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Khôi phục
                    </button>
                  )}
                </div>
                <input
                  id="doremi-meta-genre"
                  data-testid="metadata-input-genre"
                  type="text"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  placeholder="Ví dụ: Jazz, Classical, Indie..."
                  className="lp-surface-input mt-1.5 h-10 w-full rounded-xl px-3.5 text-[13.5px] focus:outline-none"
                />
              </div>
            </div>
          </section>

          {/* GROUP 3: Collapsible Advanced Info */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)]">
            <button
              type="button"
              data-testid="metadata-toggle-advanced-btn"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--text-muted)] uppercase">
                Nhóm 3 · Thông tin nâng cao (Album Artist, Track #, Composer...)
              </span>
              {showAdvanced ? (
                <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
              ) : (
                <ChevronRight className="h-4 w-4 text-[var(--text-muted)]" />
              )}
            </button>

            {showAdvanced && (
              <div className="space-y-3 border-t border-[var(--border-subtle)] px-4 pt-3.5 pb-4">
                <div>
                  <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                    Album Artist
                  </label>
                  <input
                    type="text"
                    value={albumArtist}
                    onChange={(e) => setAlbumArtist(e.target.value)}
                    placeholder="Nghệ sĩ chính của album"
                    className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Track #
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={trackNumberText}
                      onChange={(e) => setTrackNumberText(e.target.value)}
                      placeholder="1"
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Tổng bài
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={trackTotalText}
                      onChange={(e) => setTrackTotalText(e.target.value)}
                      placeholder="12"
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Disc #
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={discNumberText}
                      onChange={(e) => setDiscNumberText(e.target.value)}
                      placeholder="1"
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Tổng đĩa
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={discTotalText}
                      onChange={(e) => setDiscTotalText(e.target.value)}
                      placeholder="1"
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Nhạc sĩ (Composer)
                    </label>
                    <input
                      type="text"
                      value={composer}
                      onChange={(e) => setComposer(e.target.value)}
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                      Tác giả lời (Lyricist)
                    </label>
                    <input
                      type="text"
                      value={lyricist}
                      onChange={(e) => setLyricist(e.target.value)}
                      className="lp-surface-input mt-1 h-9 w-full rounded-xl px-3 text-[13px] focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11.5px] font-medium text-[var(--text-secondary)]">
                    Ghi chú (Comment)
                  </label>
                  <textarea
                    rows={2}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="lp-surface-input mt-1 w-full resize-none rounded-xl p-2.5 text-[12.5px] focus:outline-none"
                  />
                </div>
              </div>
            )}
          </section>

          {/* GROUP 4: Read-Only Technical Specs */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-[var(--text-muted)] uppercase">
                <Info className="h-3.5 w-3.5" />
                Nhóm 4 · Thông số kỹ thuật & File nguồn (Chỉ đọc)
              </h3>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-3">
              <div>
                <dt className="text-[var(--text-muted)]">Codec / Định dạng</dt>
                <dd className="font-mono-tabular font-medium text-[var(--text-primary)]">
                  {[target.codec, target.container].filter(Boolean).join(' · ') || 'Không rõ'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Bit depth / Sample rate</dt>
                <dd className="font-mono-tabular font-medium text-[var(--text-primary)]">
                  {target.bitDepth ? `${target.bitDepth}-bit` : 'Lossy'}
                  {target.sampleRateHz ? ` / ${Number((target.sampleRateHz / 1000).toFixed(1))} kHz` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Bitrate / Kênh</dt>
                <dd className="font-mono-tabular font-medium text-[var(--text-primary)]">
                  {target.bitrateBps ? `${Math.round(target.bitrateBps / 1000)} kbps` : '—'}
                  {target.channels ? ` · ${target.channels} ch` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Thời lượng</dt>
                <dd className="font-mono-tabular font-medium text-[var(--text-primary)]">
                  {target.durationMs ? formatDurationSeconds(Math.round(target.durationMs / 1000)) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Dung lượng</dt>
                <dd className="font-mono-tabular font-medium text-[var(--text-primary)]">
                  {target.fileSizeBytes ? formatFileSize(target.fileSizeBytes) : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--text-muted)]">Encoder</dt>
                <dd className="truncate font-medium text-[var(--text-primary)]">
                  {target.encoder || '—'}
                </dd>
              </div>
            </dl>
            <p className="font-mono-tabular mt-2.5 truncate border-t border-[var(--border-subtle)] pt-2 text-[11px] text-[var(--text-muted)]" title={target.filePath}>
              File: {target.filePath}
            </p>
          </section>

          {errorMessage && (
            <p className="text-[12px] text-rose-500 dark:text-rose-300" role="alert">
              {errorMessage}
            </p>
          )}

          {confirmDiscard && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3.5 py-2.5 text-[12px]">
              <span className="text-amber-600 dark:text-amber-200">
                Bạn có thay đổi chưa lưu. Đóng mà không lưu?
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(false)}
                  className="lp-btn-ghost rounded-full px-3 py-1 font-medium"
                >
                  Tiếp tục sửa
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-rose-600 px-3 py-1 font-semibold text-white"
                >
                  Bỏ thay đổi
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-t border-[var(--border-subtle)] px-6 py-4">
          <button
            type="button"
            disabled={!hasAnyOverride || isSaving}
            onClick={() => void handleRestoreAll()}
            data-testid="metadata-restore-original"
            className="lp-btn-ghost flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px] font-medium disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Khôi phục thông tin gốc
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRequestClose}
              disabled={isSaving}
              className="lp-btn-ghost rounded-full px-4 py-2 text-[12.5px] font-medium"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSaving}
              data-testid="metadata-save-btn"
              className="rounded-full bg-[var(--text-primary)] px-5 py-2 text-[12.5px] font-semibold text-[var(--bg-deep)] transition hover:opacity-90 disabled:opacity-50"
            >
              {isSaving ? 'Đang lưu...' : 'Lưu thay đổi'}
            </button>
          </div>
        </div>
      </form>
    </div>
    </OverlayPortal>
  );
}
