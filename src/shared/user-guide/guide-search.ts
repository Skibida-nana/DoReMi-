import { USER_GUIDE_CHAPTERS } from './guide-content';
import type { UserGuideChapter, UserGuideSearchMatch } from './guide-types';

/**
 * Normalizes Vietnamese text (including `đ`/`Đ` and decomposed NFD marks)
 * so both accent-sensitive and accent-insensitive searches match accurately.
 */
export function normalizeGuideSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchUserGuideChapters(
  rawQuery: string,
  chapters: readonly UserGuideChapter[] = USER_GUIDE_CHAPTERS,
): UserGuideSearchMatch[] {
  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return chapters.map((chapter, idx) => ({
      chapter,
      matchedSectionIds: chapter.sections.map((section) => section.id),
      score: chapters.length - idx,
    }));
  }

  const normalizedQuery = normalizeGuideSearchText(trimmed);
  if (!normalizedQuery) {
    return chapters.map((chapter, idx) => ({
      chapter,
      matchedSectionIds: chapter.sections.map((section) => section.id),
      score: chapters.length - idx,
    }));
  }

  const exactLower = trimmed.toLowerCase();
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const matches: UserGuideSearchMatch[] = [];

  for (const chapter of chapters) {
    const titleNorm = normalizeGuideSearchText(chapter.title);
    const summaryNorm = normalizeGuideSearchText(chapter.summary);
    const keywordNorm = normalizeGuideSearchText(chapter.keywords.join(' '));
    const numNorm = normalizeGuideSearchText(`${chapter.number} chuong ${chapter.number}`);

    let score = 0;
    const matchedSectionIds: string[] = [];

    const chapterHaystackNorm = `${numNorm} ${titleNorm} ${summaryNorm} ${keywordNorm}`;
    const chapterMatchesAllTokens = tokens.every((token) =>
      chapterHaystackNorm.includes(token),
    );

    if (chapter.title.toLowerCase().includes(exactLower)) {
      score += 50;
    }
    if (titleNorm.includes(normalizedQuery)) {
      score += 35;
    }
    if (summaryNorm.includes(normalizedQuery)) {
      score += 18;
    }
    if (keywordNorm.includes(normalizedQuery)) {
      score += 22;
    } else if (chapterMatchesAllTokens) {
      score += 12;
    }

    for (const section of chapter.sections) {
      const sectionRaw = [
        section.heading,
        ...section.paragraphs,
        ...(section.bullets ?? []),
        section.note ?? '',
      ].join(' ');
      const sectionNorm = normalizeGuideSearchText(sectionRaw);
      const sectionMatchesAll = tokens.every(
        (token) => sectionNorm.includes(token) || chapterHaystackNorm.includes(token),
      );
      if (sectionNorm.includes(normalizedQuery) || sectionMatchesAll) {
        matchedSectionIds.push(section.id);
        score += sectionNorm.includes(normalizedQuery) ? 16 : 6;
      }
    }

    if (score > 0 || chapterMatchesAllTokens || matchedSectionIds.length > 0) {
      matches.push({
        chapter,
        matchedSectionIds:
          matchedSectionIds.length > 0
            ? matchedSectionIds
            : chapter.sections.map((section) => section.id),
        score,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.chapter.number.localeCompare(b.chapter.number));
  return matches;
}
