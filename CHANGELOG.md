# Changelog

All notable changes to Mobile DevOps AI are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## Unreleased

### Changed

- Removed organization-specific naming from source code, routes, configuration keys, sample data, scripts, and documentation.
- Renamed the built-in product line to `default`, the sample iOS project to `mobile-ios`, and RTC integration identifiers to `mobile-rtc`.
- Renamed Jenkins templates and helper scripts to use the `mobile-devops-ai` and `mobile-quality` names.

### Security

- Replaced internal hosts, bundle identifiers, repository URLs, and service defaults with explicit example values.
- Removed embedded Nexus and Git credential fallbacks; external services now require user-supplied configuration.

## 0.1.0 2026-09-19

### Added

- Mobile application lifecycle workspace covering development, testing, release, and production operations.
- iOS build orchestration, USB real-device quality suites, WebDriverAgent automation, performance tracing, and release gates.
- Android application isolation, build, smoke-test, and internal-distribution foundations.
- Crash collection, dSYM management, symbolication, governance, and AI-assisted diagnosis.
- Component and CocoaPods management, workflow evidence, delivery diagnostics, and application-service integrations.
- Recorded real-device workflow replay and business-aware Monkey testing.
- Community Issue templates, pull-request template, contribution guide, security policy, and automated CI/security checks.

### Security

- Added the MIT license file, tracked dependency lockfile, npm and Rust dependency audits, CodeQL analysis, and full-history secret scanning.
- Replaced production-shaped App Store Connect identifiers in tests with explicit test fixtures.
