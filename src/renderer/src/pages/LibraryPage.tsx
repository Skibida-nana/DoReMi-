import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Disc3,
  FilePlus2,
  FolderPlus,
  Heart,
  ListPlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import type { TrackMetadataOverrideInput } from '../../../shared/types/track';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import { AlbumCoverflow } from '../components/AlbumCoverflow';
import {
  TrackMetadataModal,
  type TrackMetadataEditTarget,
} from '../components/TrackMetadataModal';
import { PROTOTYPE_ALBUMS, PROTOTYPE_TRACKS, type PrototypeTrack } from '../data/prototype-catalog';
import { libraryStore, useLibraryState } from '../stores/library-store';
import { usePlaybackState } from '../stores/player-store';
import { uiStore, useUiState } from '../stores/ui-store';
import { formatDurationSeconds } from '../utils/formatters';
import { compareUnicodeText, matchesVietnameseQuery } from '../utils/vietnamese-search';

type SortMode = 'recent' | 'title' | 'artist' | 'duration';
type StatusFilter = 'all' | 'available' | 'missing';

export function LibraryPage() {
  const ui = useUiState();
  const library = useLibraryState();
  const playback = usePlaybackState();
  const palette = uiStore.getCurrentPalette();

  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [showPlaylistCreator, setShowPlaylistCreator] = useState(false);
  const [editTarget, setEditTarget] = useState<TrackMetadataEditTarget | null>(null);
  const [isSavingMeta, setIsSavingMeta] = useState(false);

  const allTracks = uiStore.getUnifiedTracks();
  const activeTrackId =
    ui.activeSource === 'local' && playback.currentTrackId
      ? playback.currentTrackId
      : ui.activeSampleTrackId;

  const filteredTracks = useMemo(() => {
    const base =
      ui.libraryTab === 'favorites'
        ? allTracks.filter((t) => ui.favoriteIds.includes(t.id))
        : allTracks;

    const searched = base.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) {
        return false;
      }
      if (!query.trim()) {
        return true;
      }
      return (
        matchesVietnameseQuery(t.title, query) ||
        matchesVietnameseQuery(t.artist, query) ||
        matchesVietnameseQuery(t.albumTitle, query) ||
        matchesVietnameseQuery(t.formatBadge, query)
      );
    });

    return [...searched].sort((a, b) => {
      if (sortMode === 'title') {
        return compareUnicodeText(a.title, b.title);
      }
      if (sortMode === 'artist') {
        return compareUnicodeText(a.artist, b.artist);
      }
      if (sortMode === 'duration') {
        return b.durationSec - a.durationSec;
      }
      return b.addedOrder - a.addedOrder;
    });
  }, [allTracks, ui.libraryTab, ui.favoriteIds, statusFilter, query, sortMode]);

  const artists = useMemo(() => {
    const map = new Map<
      string,
      { name: string; coverUrl: string; trackCount: number; albumSet: Set<string> }
    >();
    for (const track of allTracks) {
      const existing = map.get(track.artist);
      if (existing) {
        existing.trackCount += 1;
        existing.albumSet.add(track.albumTitle);
      } else {
        map.set(track.artist, {
          name: track.artist,
          coverUrl: track.coverUrl || DEFAULT_DOREMI_ARTWORK_URL,
          trackCount: 1,
          albumSet: new Set([track.albumTitle]),
        });
      }
    }
    return Array.from(map.values())
      .map((entry) => ({
        name: entry.name,
        coverUrl: entry.coverUrl,
        trackCount: entry.trackCount,
        albumCount: entry.albumSet.size,
      }))
      .filter((a) => matchesVietnameseQuery(a.name, query));
  }, [allTracks, query]);

  const filteredAlbums = useMemo(
    () =>
      PROTOTYPE_ALBUMS.filter(
        (a) =>
          matchesVietnameseQuery(a.title, query) ||
          matchesVietnameseQuery(a.artist, query) ||
          matchesVietnameseQuery(a.genre, query),
      ),
    [query],
  );

  const openMetadataEditor = (track: PrototypeTrack) => {
    if (track.source === 'local') {
      const real = library.tracks.find((t) => t.id === track.id);
      if (!real) return;
      setEditTarget({
        id: real.id,
        title: real.title,
        artist: real.artist ?? 'Unknown Artist',
        album: real.album,
        originalTitle: real.original_title ?? real.title,
        originalArtist: real.original_artist ?? real.artist ?? 'Unknown Artist',
        originalAlbum:
          real.original_album !== undefined ? real.original_album : real.album,
        hasOverride: Boolean(
          real.title_override || real.artist_override || real.album_override,
        ),
      });
      return;
    }

    const baseSample = PROTOTYPE_TRACKS.find((t) => t.id === track.id) ?? track;
    const override = ui.metadataOverridesByTrackId[track.id];
    setEditTarget({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.albumTitle,
      originalTitle: baseSample.title,
      originalArtist: baseSample.artist,
      originalAlbum: baseSample.albumTitle,
      hasOverride: Boolean(override),
    });
  };

  const handleSaveMetadata = async (trackId: string, input: TrackMetadataOverrideInput) => {
    setIsSavingMeta(true);
    try {
      const isLocal = library.tracks.some((t) => t.id === trackId);
      if (isLocal && window.losslessApi) {
        await libraryStore.updateTrackMetadataOverride(trackId, input);
        uiStore.showToast('Đã lưu thông tin bài hát trong SQLite (file gốc không thay đổi)');
      } else {
        uiStore.setWebMetadataOverride(trackId, input);
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handleRestoreMetadata = async (trackId: string) => {
    setIsSavingMeta(true);
    try {
      const isLocal = library.tracks.some((t) => t.id === trackId);
      if (isLocal && window.losslessApi) {
        await libraryStore.restoreTrackMetadataOriginal(trackId);
        uiStore.showToast('Đã khôi phục thông tin gốc của bài hát');
      } else {
        uiStore.restoreWebMetadataOriginal(trackId);
      }
    } finally {
      setIsSavingMeta(false);
    }
  };

  const handlePlayTrack = (track: PrototypeTrack) => {
    if (track.source === 'local') {
      const realTrack = library.tracks.find((t) => t.id === track.id);
      if (realTrack) {
        void uiStore.playLocalElectronTrack(realTrack);
        return;
      }
    }
    uiStore.playSampleTrack(track.id);
  };

  const handleElectronAction = async (action: 'files' | 'folder' | 'rescan') => {
    if (!library.isElectronAvailable) {
      uiStore.showToast(
        'Đang ở chế độ xem trước UI. Mở ứng dụng desktop Electron trên Windows để quét & lưu SQLite thật.',
      );
      return;
    }
    if (action === 'files') {
      await libraryStore.importFiles();
    } else if (action === 'folder') {
      await libraryStore.importFolder();
    } else {
      await libraryStore.rescanLibrary();
    }
  };

  const tabs: Array<{ id: typeof ui.libraryTab; label: string; count: number }> = [
    { id: 'songs', label: 'Bài hát', count: allTracks.length },
    { id: 'albums', label: 'Album', count: PROTOTYPE_ALBUMS.length },
    { id: 'artists', label: 'Nghệ sĩ', count: artists.length },
    { id: 'playlists', label: 'Playlist', count: ui.playlists.length },
    {
      id: 'favorites',
      label: 'Yêu thích',
      count: allTracks.filter((t) => ui.favoriteIds.includes(t.id)).length,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[1360px] space-y-6 pb-36">
      {/* Header + Local Import Toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.16em] text-[var(--text-muted)] uppercase">
            Thư viện âm nhạc cục bộ
          </p>
          <h1 className="font-display mt-1 text-[30px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
            Thư viện nhạc
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleElectronAction('files')}
            disabled={library.isScanning}
            className="flex h-10 items-center gap-2 rounded-full bg-[var(--text-primary)] px-4 text-[12.5px] font-semibold text-[var(--bg-deep)] transition hover:opacity-90 disabled:opacity-50"
          >
            <FilePlus2 className="h-4 w-4" />
            Thêm file nhạc
          </button>
          <button
            type="button"
            onClick={() => void handleElectronAction('folder')}
            disabled={library.isScanning}
            className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-4 text-[12.5px] font-medium text-[var(--text-primary)] disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            Thêm thư mục
          </button>
          <button
            type="button"
            onClick={() => void handleElectronAction('rescan')}
            disabled={library.isScanning}
            className="lp-btn-ghost flex h-10 items-center gap-2 rounded-full px-4 text-[12.5px] font-medium disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${library.isScanning ? 'animate-spin' : ''}`} />
            Quét lại
          </button>
        </div>
      </div>

      {/* Tabs + Search / Sort / Filter Controls */}
      <div className="lp-glass-panel flex flex-wrap items-center justify-between gap-4 rounded-[22px] px-4 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {tabs.map((tab) => {
            const active = ui.libraryTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`library-tab-${tab.id}`}
                onClick={() => uiStore.openLibraryTab(tab.id)}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium transition ${
                  active
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
                }`}
              >
                <span>{tab.label}</span>
                <span className="font-mono-tabular text-[11px] opacity-70">{tab.count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Lọc nhanh (Việt, CJK, FLAC)..."
              className="lp-surface-input h-9 w-[230px] rounded-full pr-3.5 pl-9 text-[12.5px] focus:outline-none"
            />
          </div>

          {(ui.libraryTab === 'songs' || ui.libraryTab === 'favorites') && (
            <>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label="Lọc trạng thái file"
                className="lp-surface-input h-9 rounded-full px-3.5 text-[12px] focus:outline-none"
              >
                <option value="all">Tất cả file</option>
                <option value="available">Sẵn sàng phát</option>
                <option value="missing">Thiếu file</option>
              </select>

              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                aria-label="Sắp xếp bài hát"
                className="lp-surface-input h-9 rounded-full px-3.5 text-[12px] focus:outline-none"
              >
                <option value="recent">Mới thêm gần đây</option>
                <option value="title">Tên bài A–Z</option>
                <option value="artist">Nghệ sĩ A–Z</option>
                <option value="duration">Thời lượng dài nhất</option>
              </select>
            </>
          )}
        </div>
      </div>

      {/* Tab Content */}
      {(ui.libraryTab === 'songs' || ui.libraryTab === 'favorites') && (
        <div className="lp-glass-panel overflow-hidden rounded-[24px]">
          <div className="grid grid-cols-[36px_minmax(0,1.7fr)_minmax(0,1fr)_175px_72px_112px] items-center gap-4 border-b border-[var(--border-subtle)] px-5 py-3 text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase">
            <span>#</span>
            <span>Bài hát</span>
            <span className="hidden md:block">Album</span>
            <span className="hidden lg:block">Định dạng</span>
            <span className="text-right">Thời lượng</span>
            <span className="text-right">Thao tác</span>
          </div>

          {filteredTracks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Disc3 className="h-10 w-10 text-[var(--text-muted)]/60" />
              <p className="mt-3 text-[14px] font-medium text-[var(--text-primary)]">
                Không tìm thấy bài hát phù hợp
              </p>
              <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                Thử đổi bộ lọc hoặc xóa từ khóa tìm kiếm hiện tại.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {filteredTracks.map((track, idx) => {
                const isCurrent = activeTrackId === track.id;
                const isMissing = track.status === 'missing';
                const isFav = ui.favoriteIds.includes(track.id);

                return (
                  <div
                    key={track.id}
                    onClick={() => handlePlayTrack(track)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handlePlayTrack(track);
                      }
                    }}
                    className={`group grid h-[62px] cursor-pointer grid-cols-[36px_minmax(0,1.7fr)_minmax(0,1fr)_175px_72px_112px] items-center gap-4 px-5 transition ${
                      isMissing
                        ? 'bg-amber-500/[0.06] opacity-75 hover:bg-amber-500/[0.12]'
                        : isCurrent
                          ? 'bg-[var(--surface-hover)]'
                          : 'hover:bg-[var(--surface-glass-light)]'
                    }`}
                  >
                    <span className="font-mono-tabular text-[12px] text-[var(--text-muted)]">{idx + 1}</span>

                    <div className="flex min-w-0 items-center gap-3.5">
                      <div className="relative h-[42px] w-[42px] shrink-0 overflow-hidden rounded-[10px] border border-white/10 bg-[#101218]">
                        <img
                          src={track.coverUrl}
                          alt={track.albumTitle}
                          onError={(e) => {
                            const img = e.currentTarget;
                            if (img.dataset.fallbackApplied !== '1') {
                              img.dataset.fallbackApplied = '1';
                              img.src = DEFAULT_DOREMI_ARTWORK_URL;
                            }
                          }}
                          className="h-full w-full object-cover"
                        />
                        {isMissing && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/65 text-amber-300">
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p
                            className="truncate text-[13.5px] font-medium"
                            style={{ color: isCurrent ? palette.dominant : 'var(--text-primary)' }}
                          >
                            {track.title}
                          </p>
                          {track.source === 'local' && (
                            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-200">
                              SQLite
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            uiStore.openArtistDetail(track.artist);
                          }}
                          className="truncate text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          {track.artist}
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (track.source !== 'local') {
                          uiStore.openAlbumDetail(track.albumId);
                        }
                      }}
                      className="hidden truncate text-left text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] md:block"
                    >
                      {track.albumTitle}
                    </button>

                    <div className="hidden items-center gap-1.5 lg:flex">
                      {isMissing ? (
                        <span className="rounded-full border border-amber-500/35 bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-200">
                          Thiếu file
                        </span>
                      ) : (
                        <span className="truncate rounded-full border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)]">
                          {track.formatBadge}
                        </span>
                      )}
                    </div>

                    <span className="font-mono-tabular text-right text-[12px] text-[var(--text-muted)]">
                      {formatDurationSeconds(track.durationSec)}
                    </span>

                    <div className="flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openMetadataEditor(track);
                        }}
                        title="Chỉnh sửa thông tin bài hát"
                        aria-label={`Chỉnh sửa thông tin ${track.title}`}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] opacity-75 transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] group-hover:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          uiStore.toggleFavorite(track.id);
                        }}
                        aria-label="Yêu thích"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Heart
                          className="h-3.5 w-3.5"
                          style={
                            isFav
                              ? { color: palette.dominant, fill: palette.dominant }
                              : undefined
                          }
                        />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          uiStore.playNextInQueue(track.id);
                        }}
                        title="Phát tiếp theo"
                        aria-label="Phát tiếp theo"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      >
                        <ListPlus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {ui.libraryTab === 'albums' && (
        <div className="space-y-8">
          {/* Square 1:1 3D Coverflow Stage (Distinct from Portrait Editorial Playlist Gallery) */}
          <AlbumCoverflow albums={filteredAlbums} />

          {/* Clean Square Album Grid below for direct scanning */}
          <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
            {filteredAlbums.map((album) => (
              <div
                key={album.id}
                onClick={() => uiStore.openAlbumDetail(album.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    uiStore.openAlbumDetail(album.id);
                  }
                }}
                className="lp-glass-panel group cursor-pointer rounded-[22px] p-4 transition duration-200 hover:-translate-y-0.5"
              >
                <div className="relative aspect-square w-full overflow-hidden rounded-[16px] border border-[var(--border-subtle)]">
                  <img
                    src={album.coverUrl}
                    alt={album.title}
                    className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      uiStore.playAlbum(album.id);
                    }}
                    aria-label={`Phát album ${album.title}`}
                    className="absolute right-3 bottom-3 flex h-10 w-10 translate-y-1 items-center justify-center rounded-full bg-white text-[#090A0D] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                  >
                    <Play className="ml-0.5 h-4 w-4 fill-current" />
                  </button>
                </div>
                <p className="mt-3.5 truncate text-[15px] font-semibold text-[var(--text-primary)]">
                  {album.title}
                </p>
                <p className="mt-0.5 truncate text-[12.5px] text-[var(--text-secondary)]">
                  {album.artist}
                </p>
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  {album.year} · {album.formatLabel}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {ui.libraryTab === 'artists' && (
        <div className="grid grid-cols-2 gap-5 md:grid-cols-3 lg:grid-cols-4">
          {artists.map((artist) => (
            <button
              key={artist.name}
              type="button"
              onClick={() => uiStore.openArtistDetail(artist.name)}
              className="lp-glass-panel group flex flex-col items-center rounded-[24px] p-6 text-center transition hover:-translate-y-0.5"
            >
              <div className="h-32 w-32 overflow-hidden rounded-full border border-[var(--border-glass)] shadow-xl">
                <img
                  src={artist.coverUrl}
                  alt={artist.name}
                  className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                />
              </div>
              <p className="mt-4 text-[15px] font-semibold text-[var(--text-primary)]">
                {artist.name}
              </p>
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                {artist.albumCount} album · {artist.trackCount} bài trong thư viện
              </p>
            </button>
          ))}
        </div>
      )}

      {ui.libraryTab === 'playlists' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-[var(--text-secondary)]">
              Playlist lưu cục bộ trên máy tính — không đồng bộ đám mây.
            </p>
            <button
              type="button"
              onClick={() => setShowPlaylistCreator(!showPlaylistCreator)}
              className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[12.5px] font-semibold text-[var(--bg-deep)]"
            >
              <Plus className="h-4 w-4" />
              Tạo Playlist mới
            </button>
          </div>

          {showPlaylistCreator && (
            <div className="lp-glass-panel flex flex-wrap items-center gap-3 rounded-[20px] p-4">
              <input
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="Nhập tên playlist mới..."
                className="lp-surface-input h-10 min-w-[240px] flex-1 rounded-full px-4 text-[13px] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  uiStore.createPlaylist(newPlaylistName, 'Playlist mới tạo trong DoReMi.');
                  setNewPlaylistName('');
                  setShowPlaylistCreator(false);
                }}
                className="h-10 rounded-full bg-[var(--text-primary)] px-5 text-[12.5px] font-semibold text-[var(--bg-deep)]"
              >
                Lưu playlist
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {ui.playlists.map((playlist) => {
              const firstTrack =
                allTracks.find((t) => t.id === playlist.trackIds[0]) ?? PROTOTYPE_TRACKS[0];
              const coverSrc =
                playlist.coverUrl ?? firstTrack?.coverUrl ?? DEFAULT_DOREMI_ARTWORK_URL;
              return (
                <div
                  key={playlist.id}
                  onClick={() => uiStore.openPlaylistDetail(playlist.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      uiStore.openPlaylistDetail(playlist.id);
                    }
                  }}
                  className="lp-glass-panel flex cursor-pointer flex-col justify-between rounded-[22px] p-5 transition hover:-translate-y-0.5"
                >
                  <div className="flex items-center gap-4">
                    <img
                      src={coverSrc}
                      alt={playlist.name}
                      className="h-16 w-16 rounded-2xl border border-[var(--border-subtle)] object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[16px] font-semibold text-[var(--text-primary)]">
                        {playlist.name}
                      </h3>
                      <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                        {playlist.trackIds.length} bài · {playlist.updatedLabel}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                    {playlist.description}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        uiStore.playPlaylist(playlist.id);
                      }}
                      className="flex h-9 items-center gap-1.5 rounded-full bg-[var(--text-primary)] px-4 text-[12px] font-semibold text-[var(--bg-deep)]"
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                      Phát ngay
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!library.isElectronAvailable && (
        <div className="lp-glass-subtle flex items-center gap-2.5 rounded-2xl px-4 py-3 text-[12px] text-[var(--text-muted)]">
          <Sparkles className="h-4 w-4 shrink-0" style={{ color: palette.dominant }} />
          <span>
            Chế độ trình duyệt web. Mở ứng dụng desktop Windows Electron để thêm file nhạc trực tiếp từ ổ đĩa và lưu vào SQLite.
          </span>
        </div>
      )}

      <TrackMetadataModal
        target={editTarget}
        isSaving={isSavingMeta}
        onClose={() => setEditTarget(null)}
        onSave={handleSaveMetadata}
        onRestoreOriginal={handleRestoreMetadata}
      />
    </div>
  );
}
