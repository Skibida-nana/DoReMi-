import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import {
  buildEditorialFontMediaUrl,
  buildProfileMediaUrl,
  parseProfileMediaRequest,
} from '../../shared/contracts/media-protocol';
import type {
  CustomEditorialFontRecord,
  EditorialFontFormat,
  FadeDurationSec,
  LocalUserProfile,
  PersonalizationPreferences,
} from '../../shared/types/stage5';
import {
  createDefaultAudioLabSettings,
  normalizeAudioLabSettings,
} from '../../shared/utils/audio-dsp';
import {
  DEFAULT_EDITORIAL_TYPOGRAPHY,
  MAX_EDITORIAL_FONT_BYTES,
  normalizeEditorialTypographySettings,
  validateEditorialFontBytes,
} from '../../shared/utils/editorial-typography';
import {
  DEFAULT_REPLAYGAIN_SETTINGS,
  normalizeReplayGainSettings,
} from '../../shared/utils/replaygain';
import {
  DEFAULT_PLAYBACK_CONTROLS,
  normalizePlaybackControls,
} from '../../shared/utils/playback-controls';
import { buildMediaCorsHeaders, isAllowedMediaCorsOrigin } from './audio-stream-handler';

export const MAX_PROFILE_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MB default limit
export const MAX_DISPLAY_NAME_LENGTH = 48;
export const DEFAULT_DISPLAY_NAME = 'Người nghe nhạc';

export interface ValidatedProfileImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  extension: '.jpg' | '.png' | '.webp' | '.gif';
  isAnimated: boolean;
}

/**
 * Inspects GIF binary blocks to determine whether a GIF contains more than one
 * Image Descriptor frame (true animated GIF vs single-frame static GIF).
 */
export function isAnimatedGifBuffer(buffer: Buffer): boolean {
  if (buffer.length < 14) {
    return false;
  }
  const header = buffer.subarray(0, 6).toString('ascii');
  if (header !== 'GIF87a' && header !== 'GIF89a') {
    return false;
  }

  // Skip Logical Screen Descriptor (7 bytes) + optional Global Color Table
  const packed = buffer[10];
  let offset = 13;
  if (packed & 0x80) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    offset += gctSize;
  }

  let frameCount = 0;
  while (offset < buffer.length) {
    const blockId = buffer[offset];
    if (blockId === 0x3b) {
      // Trailer
      break;
    }
    if (blockId === 0x2c) {
      // Image Descriptor
      frameCount += 1;
      if (frameCount >= 2) {
        return true;
      }
      if (offset + 10 >= buffer.length) {
        break;
      }
      const localPacked = buffer[offset + 9];
      offset += 10;
      if (localPacked & 0x80) {
        const lctSize = 3 * (1 << ((localPacked & 0x07) + 1));
        offset += lctSize;
      }
      // LZW Minimum Code Size byte + sub-blocks
      offset += 1;
      while (offset < buffer.length) {
        const subLen = buffer[offset];
        offset += 1;
        if (subLen === 0) {
          break;
        }
        offset += subLen;
      }
    } else if (blockId === 0x21) {
      // Extension block (Graphic Control, Application, Comment, Plain Text)
      offset += 2;
      while (offset < buffer.length) {
        const subLen = buffer[offset];
        offset += 1;
        if (subLen === 0) {
          break;
        }
        offset += subLen;
      }
    } else {
      offset += 1;
    }
  }

  return frameCount >= 2;
}

/**
 * Validates avatar or background image bytes strictly by binary magic header
 * (JPG, PNG, WEBP, GIF) and enforces byte size limits.
 */
export function validateProfileImageBuffer(
  buffer: Buffer,
  options: { allowGif: boolean; maxBytes?: number },
): ValidatedProfileImage {
  const maxBytes = options.maxBytes ?? MAX_PROFILE_MEDIA_BYTES;
  if (!buffer || buffer.length < 12) {
    throw new Error('File ảnh trống hoặc không hợp lệ.');
  }
  if (buffer.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`Dung lượng ảnh vượt quá giới hạn ${mb}MB.`);
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg', isAnimated: false };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: '.png', isAnimated: false };
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: '.webp', isAnimated: false };
  }

  // GIF: GIF87a / GIF89a
  const gifSig = buffer.subarray(0, 6).toString('ascii');
  if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
    if (!options.allowGif) {
      throw new Error('Ảnh nền chỉ hỗ trợ JPG, PNG hoặc WEBP.');
    }
    return {
      mimeType: 'image/gif',
      extension: '.gif',
      isAnimated: isAnimatedGifBuffer(buffer),
    };
  }

  throw new Error(
    options.allowGif
      ? 'Định dạng avatar không hợp lệ. Chỉ hỗ trợ JPG, PNG, WEBP hoặc GIF.'
      : 'Định dạng ảnh nền không hợp lệ. Chỉ hỗ trợ JPG, PNG hoặc WEBP.',
  );
}

/**
 * Sanitizes Unicode display name cleanly:
 * - Preserves Vietnamese, Chinese, Japanese, Korean, and all valid Unicode scripts (never forces ASCII).
 * - Strips control characters and collapses whitespace.
 * - Enforces reasonable max length (48 Unicode code points).
 */
export function sanitizeDisplayName(raw: string): string {
  if (typeof raw !== 'string') {
    return DEFAULT_DISPLAY_NAME;
  }
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return DEFAULT_DISPLAY_NAME;
  }

  const chars = Array.from(cleaned);
  return chars.slice(0, MAX_DISPLAY_NAME_LENGTH).join('');
}

export const DEFAULT_PERSONALIZATION_PREFERENCES: PersonalizationPreferences = {
  themeMode: 'dark',
  accentPresetId: 'violet',
  customAccentHex: null,
  homeBackgroundMode: 'dynamic',
  customBackgroundUrl: null,
  customBackgroundHash: null,
  dynamicAlbumColors: true,
  vinylAnimation: true,
  reducedMotion: false,
  reduceMotionStaticGif: true,
  backgroundEffects: true,
  uiQualityPreset: 'balanced',
  transition: {
    enabled: false,
    durationSec: 1,
  },
  replayGain: { ...DEFAULT_REPLAYGAIN_SETTINGS },
  audioLab: createDefaultAudioLabSettings(),
  playbackControls: { ...DEFAULT_PLAYBACK_CONTROLS },
  editorialTypography: { ...DEFAULT_EDITORIAL_TYPOGRAPHY },
  editorialFonts: [],
};

const VALID_FADE_DURATIONS = new Set<FadeDurationSec>([0.5, 1, 2, 3]);
const VALID_QUALITY_PRESETS = new Set<'high' | 'balanced' | 'power-saver'>([
  'high',
  'balanced',
  'power-saver',
]);
const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/i;

interface StoredBackgroundMeta {
  file: string;
  mime: string;
  hash: string;
}

interface StoredEditorialFontMeta {
  id: string;
  name: string;
  fileName: string;
  storedFile: string;
  format: EditorialFontFormat;
  mimeType: string;
  hash: string;
  sizeBytes: number;
  addedAt: string;
}

interface ProfileRow {
  display_name: string;
  avatar_file: string | null;
  avatar_mime: string | null;
  avatar_is_animated: number;
  avatar_hash: string | null;
  updated_at: string;
}

export class ProfileService {
  private readonly db: Database.Database;
  private readonly mediaDir: string;
  private readonly fontsDir: string;
  private readonly stmtGetProfile: Database.Statement;
  private readonly stmtGetPref: Database.Statement;
  private readonly stmtWritePref: Database.Statement;
  private cachedProfile: LocalUserProfile | null = null;
  private cachedPreferences: PersonalizationPreferences | null = null;

  constructor(options: { db: Database.Database; userDataDir: string }) {
    this.db = options.db;
    this.mediaDir = path.join(options.userDataDir, 'profile-media');
    this.fontsDir = path.join(this.mediaDir, 'fonts');
    this.stmtGetProfile = this.db.prepare(
      'SELECT display_name, avatar_file, avatar_mime, avatar_is_animated, avatar_hash, updated_at FROM user_profile WHERE id = 1',
    );
    this.stmtGetPref = this.db.prepare(
      'SELECT value_json FROM app_preferences WHERE key = ?',
    );
    this.stmtWritePref = this.db.prepare(
      `INSERT INTO app_preferences (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    );
  }

  private ensureMediaDir(): void {
    fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  private ensureFontsDir(): void {
    fs.mkdirSync(this.fontsDir, { recursive: true });
  }

  getProfile(): LocalUserProfile {
    if (this.cachedProfile) {
      return { ...this.cachedProfile };
    }

    const row = this.stmtGetProfile.get() as ProfileRow | undefined;

    if (!row) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          'INSERT OR IGNORE INTO user_profile (id, display_name, avatar_is_animated, updated_at) VALUES (1, ?, 0, ?)',
        )
        .run(DEFAULT_DISPLAY_NAME, now);
      this.cachedProfile = {
        displayName: DEFAULT_DISPLAY_NAME,
        avatarUrl: null,
        avatarMime: null,
        avatarIsAnimated: false,
        avatarHash: null,
        updatedAt: now,
      };
      return { ...this.cachedProfile };
    }

    const avatarExists =
      Boolean(row.avatar_file) &&
      fs.existsSync(path.join(this.mediaDir, path.basename(row.avatar_file!)));

    this.cachedProfile = {
      displayName: row.display_name || DEFAULT_DISPLAY_NAME,
      avatarUrl: avatarExists ? buildProfileMediaUrl('avatar', row.avatar_hash) : null,
      avatarMime: avatarExists ? row.avatar_mime : null,
      avatarIsAnimated: avatarExists && row.avatar_is_animated === 1,
      avatarHash: avatarExists ? row.avatar_hash : null,
      updatedAt: row.updated_at,
    };
    return { ...this.cachedProfile };
  }

  updateDisplayName(rawName: string): LocalUserProfile {
    const sanitized = sanitizeDisplayName(rawName);
    const now = new Date().toISOString();
    this.cachedProfile = null;
    const existing = this.db
      .prepare('SELECT id FROM user_profile WHERE id = 1')
      .get() as { id: number } | undefined;

    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO user_profile (id, display_name, avatar_is_animated, updated_at) VALUES (1, ?, 0, ?)',
        )
        .run(sanitized, now);
    } else {
      this.db
        .prepare('UPDATE user_profile SET display_name = ?, updated_at = ? WHERE id = 1')
        .run(sanitized, now);
    }
    return this.getProfile();
  }

  /**
   * Copies the local avatar image (JPG/PNG/WEBP/Animated GIF) directly into
   * userData/profile-media without re-encoding GIF frames, so animated GIFs
   * remain 100% animated and completely independent of the source file path.
   */
  async importAvatarFromFile(sourceFilePath: string): Promise<LocalUserProfile> {
    const stat = await fsPromises.stat(sourceFilePath);
    if (!stat.isFile()) {
      throw new Error('Đường dẫn avatar không phải file hợp lệ.');
    }
    if (stat.size > MAX_PROFILE_MEDIA_BYTES) {
      throw new Error('Dung lượng avatar vượt quá giới hạn 10MB.');
    }

    const buffer = await fsPromises.readFile(sourceFilePath);
    const validated = validateProfileImageBuffer(buffer, { allowGif: true });

    this.ensureMediaDir();
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const fileName = `avatar-${hash}${validated.extension}`;
    const destPath = path.join(this.mediaDir, fileName);

    const prevRow = this.db
      .prepare('SELECT avatar_file FROM user_profile WHERE id = 1')
      .get() as { avatar_file: string | null } | undefined;

    await fsPromises.writeFile(destPath, buffer);

    const now = new Date().toISOString();
    if (!prevRow) {
      this.db
        .prepare(
          `INSERT INTO user_profile (id, display_name, avatar_file, avatar_mime, avatar_is_animated, avatar_hash, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          DEFAULT_DISPLAY_NAME,
          fileName,
          validated.mimeType,
          validated.isAnimated ? 1 : 0,
          hash,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE user_profile
           SET avatar_file = ?, avatar_mime = ?, avatar_is_animated = ?, avatar_hash = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(fileName, validated.mimeType, validated.isAnimated ? 1 : 0, hash, now);
    }

    // Clean up old avatar file if replaced by a different filename
    if (prevRow?.avatar_file && prevRow.avatar_file !== fileName) {
      await fsPromises.unlink(path.join(this.mediaDir, path.basename(prevRow.avatar_file))).catch(() => {});
    }

    this.cachedProfile = null;
    return this.getProfile();
  }

  async removeAvatar(): Promise<LocalUserProfile> {
    const prevRow = this.db
      .prepare('SELECT avatar_file FROM user_profile WHERE id = 1')
      .get() as { avatar_file: string | null } | undefined;

    const now = new Date().toISOString();
    if (prevRow) {
      this.db
        .prepare(
          `UPDATE user_profile
           SET avatar_file = NULL, avatar_mime = NULL, avatar_is_animated = 0, avatar_hash = NULL, updated_at = ?
           WHERE id = 1`,
        )
        .run(now);
      if (prevRow.avatar_file) {
        await fsPromises.unlink(path.join(this.mediaDir, path.basename(prevRow.avatar_file))).catch(() => {});
      }
    }

    this.cachedProfile = null;
    return this.getProfile();
  }

  private readPreferenceJson<T>(key: string): T | null {
    const row = this.stmtGetPref.get(key) as { value_json: string } | undefined;
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  private writePreferenceJson(key: string, value: unknown): void {
    const now = new Date().toISOString();
    this.cachedPreferences = null;
    this.stmtWritePref.run(key, JSON.stringify(value), now);
  }

  private readStoredEditorialFonts(): StoredEditorialFontMeta[] {
    const raw = this.readPreferenceJson<StoredEditorialFontMeta[]>('editorial_fonts_meta');
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((entry) => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.storedFile !== 'string') {
        return false;
      }
      return fs.existsSync(path.join(this.fontsDir, path.basename(entry.storedFile)));
    });
  }

  private toPublicEditorialFonts(entries: StoredEditorialFontMeta[]): CustomEditorialFontRecord[] {
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      fileName: entry.fileName,
      format: entry.format,
      mimeType: entry.mimeType,
      url: buildEditorialFontMediaUrl(entry.id, entry.hash),
      hash: entry.hash,
      sizeBytes: entry.sizeBytes,
      addedAt: entry.addedAt,
    }));
  }

  getPreferences(): PersonalizationPreferences {
    if (this.cachedPreferences) {
      return this.cachedPreferences;
    }

    const stored =
      this.readPreferenceJson<Partial<PersonalizationPreferences>>('personalization') ?? {};
    const bgMeta = this.readPreferenceJson<StoredBackgroundMeta>('custom_background_meta');
    const bgExists =
      Boolean(bgMeta?.file) &&
      fs.existsSync(path.join(this.mediaDir, path.basename(bgMeta!.file)));

    const storedFonts = this.readStoredEditorialFonts();
    const editorialFonts = this.toPublicEditorialFonts(storedFonts);
    const validFontIds = new Set(editorialFonts.map((f) => f.id));

    const rawDuration = stored.transition?.durationSec;
    const durationSec: FadeDurationSec =
      rawDuration && VALID_FADE_DURATIONS.has(rawDuration) ? rawDuration : 1;

    this.cachedPreferences = {
      themeMode: stored.themeMode === 'light' ? 'light' : 'dark',
      accentPresetId:
        typeof stored.accentPresetId === 'string' && stored.accentPresetId.length > 0
          ? stored.accentPresetId
          : DEFAULT_PERSONALIZATION_PREFERENCES.accentPresetId,
      customAccentHex:
        typeof stored.customAccentHex === 'string' && HEX_COLOR_REGEX.test(stored.customAccentHex)
          ? stored.customAccentHex.toUpperCase()
          : null,
      homeBackgroundMode:
        stored.homeBackgroundMode === 'custom' && bgExists
          ? 'custom'
          : stored.homeBackgroundMode === 'default'
            ? 'default'
            : 'dynamic',
      customBackgroundUrl: bgExists ? buildProfileMediaUrl('background', bgMeta!.hash) : null,
      customBackgroundHash: bgExists ? bgMeta!.hash : null,
      dynamicAlbumColors:
        typeof stored.dynamicAlbumColors === 'boolean'
          ? stored.dynamicAlbumColors
          : DEFAULT_PERSONALIZATION_PREFERENCES.dynamicAlbumColors,
      vinylAnimation:
        typeof stored.vinylAnimation === 'boolean'
          ? stored.vinylAnimation
          : DEFAULT_PERSONALIZATION_PREFERENCES.vinylAnimation,
      reducedMotion:
        typeof stored.reducedMotion === 'boolean'
          ? stored.reducedMotion
          : DEFAULT_PERSONALIZATION_PREFERENCES.reducedMotion,
      reduceMotionStaticGif:
        typeof stored.reduceMotionStaticGif === 'boolean'
          ? stored.reduceMotionStaticGif
          : DEFAULT_PERSONALIZATION_PREFERENCES.reduceMotionStaticGif,
      backgroundEffects:
        typeof stored.backgroundEffects === 'boolean'
          ? stored.backgroundEffects
          : DEFAULT_PERSONALIZATION_PREFERENCES.backgroundEffects,
      uiQualityPreset:
        stored.uiQualityPreset && VALID_QUALITY_PRESETS.has(stored.uiQualityPreset)
          ? stored.uiQualityPreset
          : DEFAULT_PERSONALIZATION_PREFERENCES.uiQualityPreset,
      transition: {
        enabled: Boolean(stored.transition?.enabled),
        durationSec,
      },
      replayGain: normalizeReplayGainSettings(stored.replayGain),
      audioLab: normalizeAudioLabSettings(stored.audioLab),
      playbackControls: normalizePlaybackControls(stored.playbackControls),
      editorialTypography: normalizeEditorialTypographySettings(
        stored.editorialTypography,
        validFontIds,
      ),
      editorialFonts,
    };
    return this.cachedPreferences;
  }

  updatePreferences(
    partial: Partial<PersonalizationPreferences>,
  ): PersonalizationPreferences {
    const current = this.getPreferences();
    const validFontIds = new Set(current.editorialFonts.map((f) => f.id));
    const merged: PersonalizationPreferences = {
      ...current,
      ...partial,
      transition: {
        ...current.transition,
        ...(partial.transition ?? {}),
      },
      replayGain: normalizeReplayGainSettings({
        ...(current.replayGain ?? DEFAULT_REPLAYGAIN_SETTINGS),
        ...(partial.replayGain ?? {}),
      }),
      audioLab: normalizeAudioLabSettings(
        partial.audioLab !== undefined ? partial.audioLab : current.audioLab,
      ),
      playbackControls: normalizePlaybackControls(
        partial.playbackControls
          ? {
              ...(current.playbackControls ?? DEFAULT_PLAYBACK_CONTROLS),
              ...partial.playbackControls,
            }
          : current.playbackControls,
      ),
      editorialTypography: normalizeEditorialTypographySettings(
        {
          ...current.editorialTypography,
          ...(partial.editorialTypography ?? {}),
        },
        validFontIds,
      ),
      // Never allow client to spoof editorialFonts directly; managed via import/delete
      editorialFonts: current.editorialFonts,
    };

    // Never allow client to spoof customBackgroundUrl directly
    merged.customBackgroundUrl = current.customBackgroundUrl;
    merged.customBackgroundHash = current.customBackgroundHash;
    if (merged.customAccentHex && !HEX_COLOR_REGEX.test(merged.customAccentHex)) {
      merged.customAccentHex = current.customAccentHex;
    }
    if (!VALID_FADE_DURATIONS.has(merged.transition.durationSec)) {
      merged.transition.durationSec = current.transition.durationSec;
    }
    if (!VALID_QUALITY_PRESETS.has(merged.uiQualityPreset)) {
      merged.uiQualityPreset = current.uiQualityPreset;
    }

    this.writePreferenceJson('personalization', merged);
    return this.getPreferences();
  }

  /**
   * Copies a local .ttf/.otf/.woff/.woff2 font file into userData/profile-media/fonts/
   * so Home Editorial Background Typography works 100% offline and survives deletion/moving
   * of the original file as well as app restarts.
   */
  async importEditorialFontFromFile(sourceFilePath: string): Promise<{
    preferences: PersonalizationPreferences;
    font: CustomEditorialFontRecord;
  }> {
    const stat = await fsPromises.stat(sourceFilePath);
    if (!stat.isFile()) {
      throw new Error('Đường dẫn file font không hợp lệ.');
    }
    if (stat.size > MAX_EDITORIAL_FONT_BYTES) {
      throw new Error('Dung lượng file font vượt quá giới hạn 15MB.');
    }

    const buffer = await fsPromises.readFile(sourceFilePath);
    const baseName = path.basename(sourceFilePath);
    const validated = validateEditorialFontBytes(buffer, baseName, MAX_EDITORIAL_FONT_BYTES);

    this.ensureFontsDir();
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const existing = this.readStoredEditorialFonts();
    const duplicate = existing.find((entry) => entry.hash === hash);
    if (duplicate) {
      const prefs = this.updatePreferences({
        editorialTypography: {
          ...this.getPreferences().editorialTypography,
          selectedFontId: duplicate.id,
        },
      });
      const matched = prefs.editorialFonts.find((f) => f.id === duplicate.id)!;
      return { preferences: prefs, font: matched };
    }

    const fontId = `font_${hash}`;
    const storedFile = `${fontId}${validated.extension}`;
    const destPath = path.join(this.fontsDir, storedFile);
    await fsPromises.writeFile(destPath, buffer);

    const meta: StoredEditorialFontMeta = {
      id: fontId,
      name: validated.displayName,
      fileName: baseName,
      storedFile,
      format: validated.format,
      mimeType: validated.mimeType,
      hash,
      sizeBytes: buffer.length,
      addedAt: new Date().toISOString(),
    };

    const nextList = [meta, ...existing].slice(0, 24);
    this.writePreferenceJson('editorial_fonts_meta', nextList);

    const current = this.getPreferences();
    const preferences = this.updatePreferences({
      editorialTypography: {
        ...current.editorialTypography,
        selectedFontId: fontId,
      },
    });
    const font = preferences.editorialFonts.find((f) => f.id === fontId)!;
    return { preferences, font };
  }

  async deleteEditorialFont(fontId: string): Promise<PersonalizationPreferences> {
    const existing = this.readStoredEditorialFonts();
    const target = existing.find((entry) => entry.id === fontId);
    const remaining = existing.filter((entry) => entry.id !== fontId);
    this.writePreferenceJson('editorial_fonts_meta', remaining);

    if (target?.storedFile) {
      await fsPromises
        .unlink(path.join(this.fontsDir, path.basename(target.storedFile)))
        .catch(() => {});
    }

    const current = this.getPreferences();
    if (current.editorialTypography.selectedFontId === fontId) {
      return this.updatePreferences({
        editorialTypography: {
          ...current.editorialTypography,
          selectedFontId: null,
        },
      });
    }
    return current;
  }

  async importCustomBackgroundFromFile(
    sourceFilePath: string,
  ): Promise<PersonalizationPreferences> {
    const stat = await fsPromises.stat(sourceFilePath);
    if (!stat.isFile()) {
      throw new Error('Đường dẫn ảnh nền không phải file hợp lệ.');
    }
    if (stat.size > MAX_PROFILE_MEDIA_BYTES) {
      throw new Error('Dung lượng ảnh nền vượt quá giới hạn 10MB.');
    }

    const buffer = await fsPromises.readFile(sourceFilePath);
    const validated = validateProfileImageBuffer(buffer, { allowGif: false });

    this.ensureMediaDir();
    const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
    const fileName = `home-bg-${hash}${validated.extension}`;
    const destPath = path.join(this.mediaDir, fileName);

    const prevMeta = this.readPreferenceJson<StoredBackgroundMeta>('custom_background_meta');
    await fsPromises.writeFile(destPath, buffer);

    this.writePreferenceJson('custom_background_meta', {
      file: fileName,
      mime: validated.mimeType,
      hash,
    } satisfies StoredBackgroundMeta);

    if (prevMeta?.file && prevMeta.file !== fileName) {
      await fsPromises.unlink(path.join(this.mediaDir, path.basename(prevMeta.file))).catch(() => {});
    }

    return this.updatePreferences({ homeBackgroundMode: 'custom' });
  }

  async removeCustomBackground(): Promise<PersonalizationPreferences> {
    const prevMeta = this.readPreferenceJson<StoredBackgroundMeta>('custom_background_meta');
    this.cachedPreferences = null;
    this.db.prepare('DELETE FROM app_preferences WHERE key = ?').run('custom_background_meta');
    if (prevMeta?.file) {
      await fsPromises.unlink(path.join(this.mediaDir, path.basename(prevMeta.file))).catch(() => {});
    }
    const current = this.getPreferences();
    if (current.homeBackgroundMode === 'custom') {
      return this.updatePreferences({ homeBackgroundMode: 'dynamic' });
    }
    return current;
  }

  /**
   * Serves `lossless-media://profile/avatar`, `lossless-media://profile/background`,
   * and `lossless-media://profile/font/<fontId>` strictly from `userData/profile-media`
   * without exposing OS paths to the renderer.
   */
  async resolveProfileMediaHttpResponse(request: Request): Promise<Response> {
    const originHeader = request.headers.get('origin');
    if (!isAllowedMediaCorsOrigin(originHeader)) {
      return new Response('Forbidden: Disallowed CORS origin.', { status: 403 });
    }
    const corsHeaders = buildMediaCorsHeaders(originHeader);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const parsed = parseProfileMediaRequest(request.url);
    if (!parsed) {
      return new Response('Forbidden: Invalid profile media URL.', { status: 403, headers: corsHeaders });
    }

    let safeFilePath: string | null = null;
    let mimeType = 'application/octet-stream';
    let hash = '';

    if (parsed.kind === 'avatar') {
      const row = this.db
        .prepare('SELECT avatar_file, avatar_mime, avatar_hash FROM user_profile WHERE id = 1')
        .get() as { avatar_file: string | null; avatar_mime: string | null; avatar_hash: string | null } | undefined;
      if (row?.avatar_file) {
        safeFilePath = path.join(this.mediaDir, path.basename(row.avatar_file));
      }
      mimeType = row?.avatar_mime ?? 'image/png';
      hash = row?.avatar_hash ?? '';
    } else if (parsed.kind === 'background') {
      const meta = this.readPreferenceJson<StoredBackgroundMeta>('custom_background_meta');
      if (meta?.file) {
        safeFilePath = path.join(this.mediaDir, path.basename(meta.file));
      }
      mimeType = meta?.mime ?? 'image/jpeg';
      hash = meta?.hash ?? '';
    } else if (parsed.kind === 'font' && parsed.fontId) {
      const fonts = this.readStoredEditorialFonts();
      const target = fonts.find((entry) => entry.id.toLowerCase() === parsed.fontId);
      if (target?.storedFile) {
        safeFilePath = path.join(this.fontsDir, path.basename(target.storedFile));
        mimeType = target.mimeType || 'font/ttf';
        hash = target.hash;
      }
    }

    if (!safeFilePath) {
      return new Response('Not Found', {
        status: 404,
        headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
      });
    }

    let stat;
    try {
      stat = await fsPromises.stat(safeFilePath);
    } catch {
      return new Response('Not Found', {
        status: 404,
        headers: { ...corsHeaders, 'Cache-Control': 'no-store' },
      });
    }

    if (!stat.isFile()) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders });
    }

    const headers = new Headers({
      ...corsHeaders,
      'Content-Type': mimeType,
      'Content-Length': String(stat.size),
      ETag: `"${hash || stat.mtimeMs}"`,
      'Cache-Control': parsed.hasVersionToken
        ? 'public, max-age=31536000, immutable'
        : 'private, max-age=60',
    });

    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    const nodeStream = fs.createReadStream(safeFilePath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(webStream, { status: 200, headers });
  }
}
