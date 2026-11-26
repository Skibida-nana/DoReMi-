# PHASE 5.2.1E — DOCUMENTATION, RELEASE & REGRESSION VERIFICATION REPORT

- **Project**: DoReMi Desktop (Windows) — `kamisamao`
- **Target Tag**: `1.0.0-rc.2` (`RELEASE CANDIDATE - PENDING UAT`)
- **Date**: 2026-11-26

---

## 1. Documentation & Metadata Synchronization Summary
- **Single Source of Truth User Guide**: Added [`scripts/sync-user-guide.mjs`](file:///G:/Source%20code%20DoReMi/scripts/sync-user-guide.mjs) (`npm run docs:sync` & `-- --check`) generating [`docs/USER_GUIDE.md`](file:///G:/Source%20code%20DoReMi/docs/USER_GUIDE.md) (`v1.0.0-rc.2`) directly from [`src/shared/user-guide/guide-content.ts`](file:///G:/Source%20code%20DoReMi/src/shared/user-guide/guide-content.ts).
- **Root Documentation Updated**: [`package.json`](file:///G:/Source%20code%20DoReMi/package.json), [`package-lock.json`](file:///G:/Source%20code%20DoReMi/package-lock.json), [`README.md`](file:///G:/Source%20code%20DoReMi/README.md), [`CHANGELOG.md`](file:///G:/Source%20code%20DoReMi/CHANGELOG.md), [`RELEASE_NOTES.md`](file:///G:/Source%20code%20DoReMi/RELEASE_NOTES.md), [`SYSTEM_REQUIREMENTS.md`](file:///G:/Source%20code%20DoReMi/SYSTEM_REQUIREMENTS.md), [`WINDOWS_INSTALLATION_GUIDE.md`](file:///G:/Source%20code%20DoReMi/WINDOWS_INSTALLATION_GUIDE.md), [`USER_DATA_AND_BACKUP.md`](file:///G:/Source%20code%20DoReMi/USER_DATA_AND_BACKUP.md), [`THIRD_PARTY_NOTICES.md`](file:///G:/Source%20code%20DoReMi/THIRD_PARTY_NOTICES.md), [`PHASE_6_HANDOFF.md`](file:///G:/Source%20code%20DoReMi/PHASE_6_HANDOFF.md).
- **QA & AI Context Updated**: [`docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md`](file:///G:/Source%20code%20DoReMi/docs/phase-5.2/PHASE_5.2_WINDOWS_UAT.md), [`qa/DoReMi-QA-*.cmd`](file:///G:/Source%20code%20DoReMi/qa/DoReMi-QA-Launch.cmd), and all 8 `.ai-context/*.md` files.

---

## 2. Final Verification Results (`v1.0.0-rc.2`)

| Check | Scope | Result | Details |
|---|---|---|---|
| `npm.cmd run doctor` | Host & Electron runtime | **PASS** | `0` hard failures, `2` expected host Node N-API 9 warnings; Electron `45.4.1` OK |
| `npm.cmd run lint` | `tsc --noEmit` | **PASS** | `0` errors across `src/`, `shared/`, `renderer/`, `tests/` |
| `npm.cmd run codecs:verify` | `resources/codecs/manifest.json` | **PASS** | Validated schema (`manifest.json` only, no bundled binaries) |
| `npm.cmd run docs:sync -- --check` | `docs/USER_GUIDE.md` vs in-app chapters | **PASS** | Byte-for-byte match at `v1.0.0-rc.2` |
| `npm.cmd run test:electron` | 40 test files (with FFmpeg & Foobar2000 env) | **PASS** | **`191` tests: `189 PASS`, `0 FAIL`, `2 SKIP`** (`Phase 4.5C` OS link tests skipped under non-elevated Windows sandbox `EPERM`), `6,252.32 ms` |
| `npm.cmd run build` | `electron-vite build` + `verify-build.mjs` | **PASS** | `out/main/index.js` `336.24 kB` (+ lazy `codec-manager` `122.05 kB`), `out/preload/index.cjs` `11.11 kB`, main renderer `675.38 kB` (`AboutSection` `27.14 kB`, `UserGuideSection` `37.46 kB`, `LibraryPage` `168.48 kB`) |
| `npm.cmd run smoke:electron` | Unpacked Dev (`packaged=false`) | **PASS** | `electron=45.4.1, rootChildren=2, diagLogs=1` |
| `smoke:electron -- --exe ...` | Packaged RC2 `DoReMi.exe` (`packaged=true`) | **PASS** | `electron=45.4.1, rootChildren=2, diagLogs=1` |
| Packaged `app.asar` inspection | Bundled chunks & codecs dir | **PASS** | Verified `UserGuideSection-*`, `AboutSection-*`, `Về đầu trang`, `kamisamao`, and `resources/codecs/manifest.json` inside `win-unpacked` |
| `npm.cmd audit --omit=dev --json` | Production dependency graph (`23` prod deps) | **PASS** | `0` vulnerabilities (`info/low/moderate/high/critical = 0`) |

---

## 3. Isolated Packaging & Preserved Baseline Artifacts

- **New RC2 Directory (`release/v1.0.0-rc.2/`)**:
  - `DoReMi-1.0.0-rc.2-x64-portable.exe`: `121,869,390` bytes (`SHA256: 915f395cbd07c8a562546b79bcf9810d4cf2b1036052ca0cd6c1fe2beaf4b499`)
  - `DoReMi-1.0.0-rc.2-x64-portable.zip`: `169,542,750` bytes (`SHA256: 9ba56569f0e89d2bbd3c286f4b3a05e1fd98952b8cb7c01787b379e95de7d6b0`)
  - `DoReMi-1.0.0-rc.2-x64-setup.exe`: `134,185,470` bytes (`SHA256: 24b9227a8426576ed72b96c80986b7ed735faf0f15b86783c98d154b48194c5d`)
  - `SHA256SUMS.txt` & `win-unpacked/` verified.
- **Preserved Artifacts**:
  - `release/v1.0.0-rc.1/*` (`121,860,682` bytes portable EXE + `SHA256SUMS.txt` untouched)
  - `release/DoReMi-0.1.0-x64-portable.exe` (`121,831,133` bytes untouched)
  - `OBS-51-01` remains `INTERMITTENT - NOT REPRODUCED`.
