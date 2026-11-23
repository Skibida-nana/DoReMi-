import type { LyricsEncodingOption } from '../types/stage5';

export interface DecodedLyricsText {
  text: string;
  detectedEncoding: Exclude<LyricsEncodingOption, 'auto'>;
  confidence: 'bom' | 'strict-utf8' | 'heuristic' | 'explicit';
  hadReplacementChars: boolean;
}

export class LyricsEncodingError extends Error {
  readonly code = 'LYRICS_ENCODING_UNSUPPORTED';

  constructor(message: string) {
    super(message);
    this.name = 'LyricsEncodingError';
  }
}

const CJK_AND_VIET_REGEX =
  /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u00C0-\u024F\u1E00-\u1EFF]/g;
const LRC_TIMESTAMP_HINT = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g;
const CONTROL_GARBAGE_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g;

function decodeWithEncoding(
  bytes: Uint8Array,
  encoding: Exclude<LyricsEncodingOption, 'auto'>,
  fatal: boolean,
): string | null {
  try {
    const decoder = new TextDecoder(encoding, { fatal });
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function countShiftJisKanaPairs(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    // Hiragana: 0x82 0x9F..0xF1, Katakana: 0x83 0x40..0x96
    if ((b1 === 0x82 && b2 >= 0x9f && b2 <= 0xf1) || (b1 === 0x83 && b2 >= 0x40 && b2 <= 0x96)) {
      count += 1;
      i += 1;
    }
  }
  return count;
}

function countUhcRareExtensionLeadBytes(bytes: Uint8Array): number {
  let rare = 0;
  let standardKsHangul = 0;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    if (b1 >= 0x81 && b1 <= 0xa0 && b2 >= 0x41 && b2 <= 0xfe) {
      rare += 1;
      i += 1;
    } else if (b1 >= 0xb0 && b1 <= 0xc8 && b2 >= 0xa1 && b2 <= 0xfe) {
      standardKsHangul += 1;
      i += 1;
    }
  }
  return rare - standardKsHangul;
}

function scoreDecodedCandidate(
  text: string,
  encoding?: Exclude<LyricsEncodingOption, 'auto'>,
  bytes?: Uint8Array,
): number {
  if (!text || text.trim().length === 0) {
    return -10_000;
  }

  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  const controlGarbage = (text.match(CONTROL_GARBAGE_REGEX) ?? []).length;
  if (replacementCount > 0 || controlGarbage > 2) {
    return -5_000 - replacementCount * 500 - controlGarbage * 200;
  }

  const cjkOrVietMatches = (text.match(CJK_AND_VIET_REGEX) ?? []).length;
  const timestampMatches = (text.match(LRC_TIMESTAMP_HINT) ?? []).length;
  const printableAscii = (text.match(/[\x20-\x7E\r\n\t]/g) ?? []).length;

  // Penalize half-width katakana flood (common artifact when GBK/EUC-KR is misread as Shift-JIS)
  const halfWidthKatakana = (text.match(/[\uFF61-\uFF9F]/g) ?? []).length;
  // Penalize obscure Latin-1 artifacts
  const obscureLatin = (text.match(/[\u00A1-\u00BF\u00D7\u00F7]/g) ?? []).length;
  // Bonus for Japanese Kana (Hiragana/Katakana)
  const japaneseKana = (text.match(/[\u3040-\u30FF]/g) ?? []).length;
  const hangul = (text.match(/[\uAC00-\uD7AF]/g) ?? []).length;

  let encodingBonus = 0;
  if (bytes && encoding === 'shift_jis') {
    encodingBonus += countShiftJisKanaPairs(bytes) * 14 + japaneseKana * 6;
  } else if (bytes && encoding === 'euc-kr') {
    // Standard Korean lyrics use KS X 1001 bytes (0xB0..0xC8); 0x81..0xA0 are rare UHC syllables
    // that strongly collide with everyday Shift-JIS bytes.
    const uhcDelta = countUhcRareExtensionLeadBytes(bytes);
    if (uhcDelta > 0) {
      encodingBonus -= uhcDelta * 20;
    } else if (uhcDelta < 0) {
      encodingBonus += Math.abs(uhcDelta) * 8;
    }
  }

  return (
    timestampMatches * 25 +
    cjkOrVietMatches * 6 +
    japaneseKana * 5 +
    hangul * 3 +
    encodingBonus +
    printableAscii * 0.5 -
    halfWidthKatakana * 12 -
    obscureLatin * 8
  );
}

/**
 * Decodes raw bytes from an `.lrc` or `.txt` lyrics file safely without ever mutating
 * the source file or silently saving mojibake (`???` / replacement glyphs).
 *
 * Supported encodings (via native Electron/Node ICU TextDecoder):
 * - UTF-8 (with or without BOM)
 * - UTF-16 LE & UTF-16 BE (with BOM)
 * - Shift-JIS (Japanese)
 * - GB18030 / GBK (Simplified Chinese)
 * - EUC-KR / CP949-compatible subset (Korean)
 * - Big5 (Traditional Chinese)
 */
export function decodeLyricsBuffer(
  buffer: Uint8Array,
  preferredEncoding: LyricsEncodingOption = 'auto',
): DecodedLyricsText {
  if (buffer.byteLength === 0) {
    return {
      text: '',
      detectedEncoding: 'utf-8',
      confidence: 'strict-utf8',
      hadReplacementChars: false,
    };
  }

  // 1. Explicit encoding chosen by user
  if (preferredEncoding !== 'auto') {
    const strict = decodeWithEncoding(buffer, preferredEncoding, true);
    if (strict !== null) {
      return {
        text: strict.replace(/^\uFEFF/, ''),
        detectedEncoding: preferredEncoding,
        confidence: 'explicit',
        hadReplacementChars: strict.includes('\uFFFD'),
      };
    }
    throw new LyricsEncodingError(
      `Không thể giải mã file lời bài hát bằng bảng mã ${preferredEncoding.toUpperCase()}. Hãy chọn bảng mã khác hoặc chuyển file sang UTF-8.`,
    );
  }

  // 2. BOM inspection (highest certainty)
  if (
    buffer.byteLength >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    const decoded = decodeWithEncoding(buffer.subarray(3), 'utf-8', true);
    if (decoded !== null) {
      return {
        text: decoded,
        detectedEncoding: 'utf-8',
        confidence: 'bom',
        hadReplacementChars: false,
      };
    }
  }

  if (buffer.byteLength >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const decoded = decodeWithEncoding(buffer.subarray(2), 'utf-16le', true);
    if (decoded !== null) {
      return {
        text: decoded.replace(/^\uFEFF/, ''),
        detectedEncoding: 'utf-16le',
        confidence: 'bom',
        hadReplacementChars: false,
      };
    }
  }

  if (buffer.byteLength >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const decoded = decodeWithEncoding(buffer.subarray(2), 'utf-16be', true);
    if (decoded !== null) {
      return {
        text: decoded.replace(/^\uFEFF/, ''),
        detectedEncoding: 'utf-16be',
        confidence: 'bom',
        hadReplacementChars: false,
      };
    }
  }

  // 3. Strict UTF-8 (covers ASCII, Vietnamese, Chinese, Japanese, Korean UTF-8 cleanly)
  const strictUtf8 = decodeWithEncoding(buffer, 'utf-8', true);
  if (strictUtf8 !== null) {
    return {
      text: strictUtf8.replace(/^\uFEFF/, ''),
      detectedEncoding: 'utf-8',
      confidence: 'strict-utf8',
      hadReplacementChars: false,
    };
  }

  // 4. Legacy CJK encodings supported by ICU TextDecoder (strict fatal=true to prevent silent corruption)
  const legacyEncodings: Array<Exclude<LyricsEncodingOption, 'auto'>> = [
    'shift_jis',
    'euc-kr',
    'gb18030',
    'big5',
  ];

  let best: {
    encoding: Exclude<LyricsEncodingOption, 'auto'>;
    text: string;
    score: number;
  } | null = null;

  for (const encoding of legacyEncodings) {
    const candidate = decodeWithEncoding(buffer, encoding, true);
    if (candidate === null) {
      continue;
    }
    const score = scoreDecodedCandidate(candidate, encoding, buffer);
    if (!best || score > best.score) {
      best = { encoding, text: candidate, score };
    }
  }

  if (best && best.score > 0) {
    return {
      text: best.text.replace(/^\uFEFF/, ''),
      detectedEncoding: best.encoding,
      confidence: 'heuristic',
      hadReplacementChars: false,
    };
  }

  throw new LyricsEncodingError(
    'Không thể xác định chắc chắn bảng mã của file lời bài hát. File gốc không bị thay đổi — vui lòng chọn lại bảng mã (UTF-8 / UTF-16 / Shift-JIS / GB18030 / EUC-KR / Big5) khi nhập.',
  );
}

/**
 * Lists encodings that the current JS/Electron runtime ICU actually supports.
 */
export function getSupportedLyricsEncodings(): Array<Exclude<LyricsEncodingOption, 'auto'>> {
  const candidates: Array<Exclude<LyricsEncodingOption, 'auto'>> = [
    'utf-8',
    'utf-16le',
    'utf-16be',
    'shift_jis',
    'gb18030',
    'euc-kr',
    'big5',
  ];
  return candidates.filter((enc) => {
    try {
      new TextDecoder(enc);
      return true;
    } catch {
      return false;
    }
  });
}
