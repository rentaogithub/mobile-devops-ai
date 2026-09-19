# Security Policy

## Supported versions

Security fixes are provided for the latest tagged minor release and the current `main` branch.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier or untagged snapshots | No |

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/rentaogithub/mobile-devops-ai/security/advisories/new). Do not open a public Issue or include secrets, production logs, dSYMs, device identifiers, or personal data in public discussions.

Include the affected component and version, reproduction steps or a proof of concept, potential impact, and any suggested mitigation. Maintainers will acknowledge a complete report as soon as practical, validate severity, coordinate a fix, and publish an advisory when users need to take action.

## Security expectations

- Keep credentials in local environment files or secret stores; tracked `.env` files are prohibited.
- Use the committed lockfiles and review dependency changes.
- Treat uploaded crash logs, dSYMs, device data, and build artifacts as sensitive.
- Run the repository's Node.js and Rust dependency audits before release.
- Never commit real tokens, signing certificates, provisioning profiles, or private keys.

The latest release self-assessment is recorded in [SECURITY_AUDIT.md](SECURITY_AUDIT.md).
