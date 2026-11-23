import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  APP_DISPLAY_NAME,
  LEGACY_PACKAGED_USER_DATA_DIR,
  resolveSafeUserDataPath,
} from '../src/main/utils/user-data-path';

test('dev mode keeps existing lossless-player userData directory untouched', () => {
  const appDataPath = '/Users/tester/AppData/Roaming';
  const currentUserDataPath = path.join(appDataPath, 'lossless-player');

  const result = resolveSafeUserDataPath({
    isPackaged: false,
    appDataPath,
    currentUserDataPath,
  });

  assert.equal(APP_DISPLAY_NAME, 'DoReMi');
  assert.equal(result.shouldOverride, false);
  assert.equal(result.targetUserDataPath, currentUserDataPath);
});

test('packaged DoReMi build pins userData to legacy Lossless Player directory', () => {
  const appDataPath = '/Users/tester/AppData/Roaming';
  const currentUserDataPath = path.join(appDataPath, 'DoReMi');

  const result = resolveSafeUserDataPath({
    isPackaged: true,
    appDataPath,
    currentUserDataPath,
  });

  assert.equal(result.shouldOverride, true);
  assert.equal(
    result.targetUserDataPath,
    path.join(appDataPath, LEGACY_PACKAGED_USER_DATA_DIR),
  );
});

test('packaged build already pointing to legacy Lossless Player does not override unnecessarily', () => {
  const appDataPath = '/Users/tester/AppData/Roaming';
  const currentUserDataPath = path.join(appDataPath, 'Lossless Player');

  const result = resolveSafeUserDataPath({
    isPackaged: true,
    appDataPath,
    currentUserDataPath,
  });

  assert.equal(result.shouldOverride, false);
  assert.equal(result.targetUserDataPath, currentUserDataPath);
});
