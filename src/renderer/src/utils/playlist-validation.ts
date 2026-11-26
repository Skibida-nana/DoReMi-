export const MAX_PLAYLIST_NAME_LENGTH = 80;

export interface PlaylistNameValidationResult {
  valid: boolean;
  normalizedName: string;
  error: string | null;
}

export function normalizePlaylistName(name: string): string {
  return name.trim().normalize('NFC');
}

export function validatePlaylistName(
  rawName: string,
  existingNames: readonly string[],
): PlaylistNameValidationResult {
  const normalizedName = normalizePlaylistName(rawName);
  if (!normalizedName) {
    return {
      valid: false,
      normalizedName,
      error: 'Vui lòng nhập tên playlist.',
    };
  }

  if (normalizedName.length > MAX_PLAYLIST_NAME_LENGTH) {
    return {
      valid: false,
      normalizedName,
      error: `Tên playlist tối đa ${MAX_PLAYLIST_NAME_LENGTH} ký tự.`,
    };
  }

  const lowerTarget = normalizedName.toLocaleLowerCase('vi');
  const isDuplicate = existingNames.some(
    (name) => normalizePlaylistName(name).toLocaleLowerCase('vi') === lowerTarget,
  );
  if (isDuplicate) {
    return {
      valid: false,
      normalizedName,
      error: 'Đã có playlist trùng tên. Vui lòng chọn tên khác.',
    };
  }

  return {
    valid: true,
    normalizedName,
    error: null,
  };
}
