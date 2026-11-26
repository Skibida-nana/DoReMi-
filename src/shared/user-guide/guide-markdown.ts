import { USER_GUIDE_CHAPTERS, USER_GUIDE_VERSION_NOTE } from './guide-content';
import type { UserGuideChapter } from './guide-types';

/**
 * Generates deterministic Markdown for `docs/USER_GUIDE.md` from the exact same
 * structured chapters rendered inside the app (`Settings -> Hướng dẫn sử dụng`).
 */
export function renderUserGuideMarkdown(
  versionLabel: string,
  chapters: readonly UserGuideChapter[] = USER_GUIDE_CHAPTERS,
): string {
  const lines: string[] = [
    '# DoReMi Desktop (Windows) — Hướng Dẫn Sử Dụng',
    '',
    `> **Phiên bản tài liệu:** ${versionLabel} · **Nhà phát triển:** kamisamao`,
    `> ${USER_GUIDE_VERSION_NOTE}`,
    '> *(Tệp này được tạo tự động từ Single Source of Truth trong `src/shared/user-guide/guide-content.ts` thông qua `scripts/sync-user-guide.mjs`.)*',
    '',
    '## Mục lục',
    '',
  ];

  for (const ch of chapters) {
    lines.push(`- [Chương ${ch.number} — ${ch.title}](#${ch.id})`);
  }
  lines.push('');

  for (const ch of chapters) {
    lines.push('---', '');
    lines.push(`<a id="${ch.id}"></a>`, '');
    lines.push(`## Chương ${ch.number} — ${ch.title}`, '');
    lines.push(`*${ch.summary}*`, '');

    for (const section of ch.sections) {
      lines.push(`### ${section.heading}`, '');
      for (const p of section.paragraphs) {
        lines.push(p, '');
      }
      if (section.bullets && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          lines.push(`- ${bullet}`);
        }
        lines.push('');
      }
      if (section.note) {
        lines.push(`> **Lưu ý:** ${section.note}`, '');
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
