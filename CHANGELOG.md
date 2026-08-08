# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Added official `kiro-cli acp` fallback for direct Kiro `401`/`403` responses, with configurable CLI path and agent profile.
- Added Kiro subscription entries for `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.6-sol`, including vision and extended reasoning metadata.
- Added the ACP runtime dependency and configuration coverage for CLI-backed subscription access.

### Changed
- The Kiro provider now forwards every active OMP tool, including terminal execution, consistently with other providers. ACP fallback uses the default Kiro CLI agent unless an agent is explicitly configured.
- The Node test runner now supports Node 26 workspaces with TypeScript/Bun-only OMP dependencies through temporary test-only transpilation and compatibility shims.

### Fixed
- Fixed GPT-5.6-Luna requests losing terminal and other active tool permissions because Kiro CLI-shaped tool definitions were filtered from direct requests.
- Fixed social OAuth callback handling when the host supplies an explicit method selector or a callback URL directly.

## [0.2.2] - 2026-07-03

### Changed
- Widened Pi peer dependency ranges to 0.80 and added security dependency overrides. ([ce50099](https://github.com/MasuRii/pi-kiro-provider/commit/ce50099c1071da42f69a2c637bf124ea4634ff12))
- Extracted shared credentials and HTTP utilities to reduce duplication. ([1c2fbe3](https://github.com/MasuRii/pi-kiro-provider/commit/1c2fbe34689f92794bff56ca7f4fc372fcf69b16))

## [0.2.1] - 2026-06-16

### Fixed
- Validated that parsed model cost values are non-negative finite numbers to prevent invalid cost metadata from silently passing through.
- Added stricter bounds checking for malformed event stream frames, returning `null` instead of silently reading past the header section boundary.

## [0.2.0] - 2026-06-01

### Added
- Added lazy loading for Kiro OAuth and streaming modules to reduce startup cost.

### Changed
- Widened Pi peer dependency compatibility to include Pi 0.77.x and 0.78.x.

### Fixed
- Corrected the default Kiro API key placeholder to reference `$KIRO_ACCESS_TOKEN` consistently in config and docs.

## [0.1.0] - 2026-05-27

### Added
- Prepared npm/GitHub release metadata, package contents, README, changelog, license, and package ignore rules for public review.
- Added the initial Kiro provider extension with OAuth registration, Pi provider registration, runtime provider replay for pi-multi-auth, configurable model metadata, and file-gated debug logging.
