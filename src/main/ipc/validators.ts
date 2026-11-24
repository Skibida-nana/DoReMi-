import { isValidTrackUuid } from '../../shared/contracts/media-protocol';

const MAX_BATCH_IDS = 10_000;

/**
 * Validates that an IPC trackId argument is a properly formatted UUID string.
 */
export function assertValidTrackId(value: unknown): string {
  if (!isValidTrackUuid(value)) {
    throw new Error('Tham số trackId không hợp lệ (yêu cầu định dạng UUID).');
  }
  return value.toLowerCase();
}

/**
 * Validates an array of UUIDs (trackIds, exclusionIds, etc.) and returns deduplicated lowercase IDs.
 */
export function assertValidUuidList(value: unknown, fieldName = 'trackIds'): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Tham số ${fieldName} phải là danh sách UUID hợp lệ.`);
  }
  if (value.length > MAX_BATCH_IDS) {
    throw new Error(`Danh sách ${fieldName} vượt quá giới hạn xử lý (${MAX_BATCH_IDS}).`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isValidTrackUuid(item)) {
      throw new Error(`Phần tử không hợp lệ trong ${fieldName} (yêu cầu định dạng UUID).`);
    }
    const normalized = item.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Validates a generic UUID identifier (e.g. rootId, exclusionId).
 */
export function assertValidUuid(value: unknown, fieldName = 'id'): string {
  if (!isValidTrackUuid(value)) {
    throw new Error(`Tham số ${fieldName} không hợp lệ (yêu cầu định dạng UUID).`);
  }
  return value.toLowerCase();
}
