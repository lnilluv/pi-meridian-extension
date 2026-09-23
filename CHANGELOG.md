# Changelog

## [0.2.5] - 2026-09-23

### Security
- Update development dependencies to resolve the reported npm audit advisories.
- Run `npm audit` before npm publication.

## [0.2.4] - 2026-09-23

### Added
- Add Claude Opus 5.5 to the Meridian provider with Anthropic pricing and request compatibility.

### Fixed
- Preserve Pi's XML `<project_context>` instructions in rewritten Meridian prompts.

### Compatibility
- Raise the supported Meridian minimum to 1.75.0 for Opus 5.5 support.
