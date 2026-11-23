import { isValidTrackUuid } from '../../shared/contracts/media-protocol';

/**
 * Validates that an IPC trackId argument is a properly formatted UUID string.
 */
export function assertValidTrackId(value: unknown): string {
  if (!isValidTrackUuid(value)) {
    throw new Error('Tham số trackId không hợp lệ (yêu cầu định dạng UUID).');
  }
  return value.toLowerCase();
}
