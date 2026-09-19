# Mobile DevOps AI

[简体中文](README.md) | [Contributing](CONTRIBUTING.md) | [Security](SECURITY.md) | [Security audit](SECURITY_AUDIT.md) | [Changelog](CHANGELOG.md)

Mobile DevOps AI is an AI-powered platform for the complete mobile application lifecycle. It connects development, testing, release, and production operations into one delivery loop. Its core capabilities include AI-assisted coding and code review, automated and regression testing, multi-channel staged releases, crash attribution and performance analysis, and dependency security scanning. The platform currently supports iOS services and isolated Android builds and integrates with CI/CD and monitoring systems.

## Architecture

The platform combines a React workspace, a Node.js and Express backend, SQLite and local artifact storage, and external execution systems. Delivery evidence is normalized into workflow records for quality and release decisions.

![Mobile DevOps AI architecture](docs/diagrams/platform-overview.png)

## Getting started

Use Node.js 22 and install the committed dependency tree:

```bash
git clone https://github.com/rentaogithub/mobile-devops-ai.git
cd mobile-devops-ai
npm ci
npm run dev
```

The frontend defaults to `http://localhost:5173` and the backend to `http://localhost:3000`. See the [installation guide](docs/安装指南.md) and [deployment guide](docs/部署与运行.md) for environment configuration and production operation.

## Verification

```bash
npm run check
npm run build
```

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
