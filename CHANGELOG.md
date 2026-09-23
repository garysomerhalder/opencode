# Changelog

Changes in the Legatus fork of OpenCode. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Upstream release notes are generated from commits by `script/changelog.ts`, and this file does not replace them.

## [Unreleased]

### Changed

- Permissions (2026-09-23): an explicit `deny` in an agent's ruleset is now final. An "always" approval only lifts
  an `ask`, so an approval given under one agent can no longer unlock a pattern another agent denies. Before, an
  approval given to `build` (for example `edit` with `"edit": "ask"` in the config) also let `plan` edit.
