import { useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import {
  USER_GUIDE_CHAPTERS,
  USER_GUIDE_VERSION_NOTE,
} from '../../../../shared/user-guide/guide-content';
import { searchUserGuideChapters } from '../../../../shared/user-guide/guide-search';
import { uiStore } from '../../stores/ui-store';

export function UserGuideSection() {
  const userAccent = uiStore.getUserAccentPalette();
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set([USER_GUIDE_CHAPTERS[0]?.id ?? 'ch-01-gioi-thieu']),
  );
  const chapterRefs = useRef<Record<string, HTMLElement | null>>({});

  const matches = useMemo(() => searchUserGuideChapters(query), [query]);
  const isSearching = query.trim().length > 0;

  const toggleChapter = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleJumpToChapter = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const el = chapterRefs.current[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const expandAll = () => {
    setExpandedIds(new Set(matches.map((m) => m.chapter.id)));
  };

  const collapseAll = () => {
    setExpandedIds(new Set());
  };

  return (
    <div className="space-y-6" data-testid="settings-user-guide-section">
      {/* Header & Offline Search */}
      <div className="flex flex-col gap-4 border-b border-[var(--border-subtle)] pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" style={{ color: userAccent.activeHex }} />
              <h2 className="font-display text-[20px] font-semibold text-[var(--text-primary)]">
                Hướng dẫn sử dụng (Offline)
              </h2>
            </div>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">
              {USER_GUIDE_VERSION_NOTE} ({USER_GUIDE_CHAPTERS.length} chương đầy đủ).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={expandAll}
              className="lp-btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
            >
              Mở tất cả
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="lp-btn-ghost rounded-full px-3 py-1.5 text-[12px] font-medium"
            >
              Thu gọn
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              data-testid="user-guide-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm hướng dẫn (hỗ trợ có dấu hoặc không dấu: alac, focus vinyl, relink, eq...)"
              className="lp-surface-input h-10 w-full rounded-full pr-10 pl-10 text-[13px] focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Xóa từ khóa tìm kiếm"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-3 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {isSearching && (
            <span className="font-mono-tabular shrink-0 text-[12px] text-[var(--text-muted)]">
              Tìm thấy {matches.length}/{USER_GUIDE_CHAPTERS.length} chương
            </span>
          )}
        </div>
      </div>

      {/* Table of Contents */}
      {!isSearching && (
        <div className="rounded-[20px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] p-4">
          <p className="mb-2.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Mục lục nhanh ({USER_GUIDE_CHAPTERS.length} chương)
          </p>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {USER_GUIDE_CHAPTERS.map((ch) => (
              <button
                key={ch.id}
                type="button"
                data-testid={`user-guide-toc-${ch.id}`}
                onClick={() => handleJumpToChapter(ch.id)}
                className="flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                <span
                  className="font-mono-tabular shrink-0 text-[11px] font-bold"
                  style={{ color: userAccent.activeHex }}
                >
                  {ch.number}
                </span>
                <span className="truncate">{ch.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chapters List / Empty Search State */}
      {matches.length === 0 ? (
        <div
          data-testid="user-guide-empty-state"
          className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-6 py-10 text-center"
        >
          <p className="text-[14.5px] font-semibold text-[var(--text-primary)]">
            Không tìm thấy nội dung phù hợp với &ldquo;{query.trim()}&rdquo;
          </p>
          <p className="mt-1.5 text-[12.5px] text-[var(--text-muted)]">
            Thử từ khóa khác như: playlist, focus vinyl, alac, audio lab, relink, alt+m, sao lưu.
          </p>
          <button
            type="button"
            onClick={() => setQuery('')}
            style={{
              backgroundColor: userAccent.activeHex,
              color: userAccent.onAccentText,
            }}
            className="mt-4 rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition hover:brightness-110"
          >
            Xem toàn bộ {USER_GUIDE_CHAPTERS.length} chương
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {matches.map(({ chapter, matchedSectionIds }) => {
            const isExpanded = isSearching || expandedIds.has(chapter.id);
            return (
              <article
                key={chapter.id}
                ref={(el) => {
                  chapterRefs.current[chapter.id] = el;
                }}
                data-testid={`user-guide-chapter-${chapter.id}`}
                className="rounded-[22px] border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] transition"
              >
                <button
                  type="button"
                  onClick={() => toggleChapter(chapter.id)}
                  aria-expanded={isExpanded}
                  className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="font-mono-tabular rounded-full px-2 py-0.5 text-[11px] font-bold"
                        style={{
                          backgroundColor: `rgba(${userAccent.glowRgb}, 0.16)`,
                          color: userAccent.activeHex,
                        }}
                      >
                        Chương {chapter.number}
                      </span>
                      <h3 className="font-display text-[15.5px] font-semibold text-[var(--text-primary)]">
                        {chapter.title}
                      </h3>
                    </div>
                    <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">
                      {chapter.summary}
                    </p>
                  </div>
                  <span className="mt-1 shrink-0 text-[var(--text-muted)]">
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </span>
                </button>

                {isExpanded && (
                  <div className="space-y-4 border-t border-[var(--border-subtle)] px-5 py-4">
                    {chapter.sections.map((section) => {
                      const highlighted =
                        isSearching && matchedSectionIds.includes(section.id);
                      return (
                        <div
                          key={section.id}
                          className={`rounded-2xl border p-4 ${
                            highlighted
                              ? 'border-[var(--user-accent)]/40 bg-[var(--surface-glass-strong)]'
                              : 'border-[var(--border-subtle)] bg-[var(--surface-glass-strong)]'
                          }`}
                        >
                          <h4 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                            {section.heading}
                          </h4>
                          <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                            {section.paragraphs.map((p, idx) => (
                              <p key={idx}>{p}</p>
                            ))}
                          </div>
                          {section.bullets && section.bullets.length > 0 && (
                            <ul className="mt-2.5 list-disc space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                              {section.bullets.map((b, idx) => (
                                <li key={idx}>{b}</li>
                              ))}
                            </ul>
                          )}
                          {section.note && (
                            <p className="mt-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-glass-light)] px-3 py-2 text-[12px] text-[var(--text-muted)]">
                              <strong className="text-[var(--text-primary)]">Lưu ý: </strong>
                              {section.note}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
