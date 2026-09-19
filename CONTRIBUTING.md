# Contributing to Mobile DevOps AI

Thank you for helping improve Mobile DevOps AI. Contributions should be reproducible, reviewable, and safe for a public repository.

## Before opening an Issue

Search existing Issues and documentation first. Use the Bug, Feature, or Documentation template so maintainers receive enough context to reproduce and evaluate the request. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); never publish credentials, private logs, dSYMs, device identifiers, or personal data.

## Development setup

The supported runtime is Node.js 22. The iOS quality and device workflows additionally require macOS, a compatible Xcode installation, and a trusted test device. The Rust watermark decoder requires the stable Rust toolchain.

```bash
git clone https://github.com/rentaogithub/mobile-devops-ai.git
cd mobile-devops-ai
npm ci
npm run dev
```

See [the installation guide](docs/安装指南.md) for environment and production setup details.

## Change workflow

1. Open or reference an Issue for nontrivial work.
2. Create a focused branch such as `feat/quality-report` or `fix/device-pairing`.
3. Keep commits small and use clear prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.
4. Add or update tests and documentation with the implementation.
5. Run the required checks before opening a pull request.

```bash
npm ci
npm run check
npm run build
```

Hardware-dependent iOS or Android changes must also document the device, OS version, test suite, and evidence used for verification.

## Code review policy

Changes should enter `main` through a pull request. A merge requires green automated checks, resolved review conversations, and at least one approving review from someone other than the author whenever another qualified reviewer is available. Security-, authentication-, release-, and device-control changes require explicit maintainer review.

Authors must not approve their own changes. Maintainers may use the documented administrative bypass only for an urgent repository recovery, then open a follow-up Issue describing the bypass and validation performed.

Use squash merge for a focused change unless preserving individual commits materially improves traceability. Update `CHANGELOG.md` for user-visible behavior, compatibility, security, or operational changes.

## Pull request expectations

A pull request should explain:

- the user or operational problem;
- the implementation and important alternatives;
- test and build evidence;
- security, privacy, compatibility, and rollout risk;
- related Issues, specifications, or screenshots where appropriate.

By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).
