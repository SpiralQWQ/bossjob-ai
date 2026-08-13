# Security Policy

## Reporting a Vulnerability

We take security seriously. **Please do not open a public issue** for security vulnerabilities.

Instead, report privately via **GitHub Security Advisories**:

👉 **https://github.com/SpiralQWQ/bossjob-ai/security/advisories/new**

or open a **private** discussion via https://github.com/SpiralQWQ/bossjob-ai/discussions.

Please include:

- The affected version(s) and file(s).
- A step-by-step description of the vulnerability.
- A proof of concept if possible (minimal, no destructive payloads).

We aim to acknowledge reports within **48 hours** and to ship a fix in a timely manner, depending on severity.

## Security Posture

BossJobAI is a **local-first, privacy-first** desktop app. The threat model is: a malicious page/script in the renderer must not be able to read, exfiltrate, or tamper with local data or credentials.

Key defenses (see [README § Security Baseline](README.md#security-baseline) and the [interface doc](docs/求职投递项目_接口文档_v0.1.md#7-安全基线)):

- Electron: `contextIsolation=true`, `nodeIntegration=false`, `sandbox=true`; minimal preload API surface.
- Backend: global Bearer-token auth (fail-closed, one-time token file), Host/Origin checks (DNS-rebinding / CSRF), CORS limited to localhost + `app://`.
- Renderer: strict CSP `script-src 'self'` (build-time + runtime enforced).
- Secrets: LLM `api_key` DPAPI-encrypted at rest; never in `GET /api/settings` responses or exports.
- `llm.base_url` whitelist prevents XSS-driven server-side exfiltration.
- Backup/restore: checksum verification, path-traversal guards, pre-overwrite snapshots.

## Scope

**In scope**: the source code in this repository (backend, Electron main/preload, frontend).

**Out of scope**:
- Third-party dependencies (report them to their respective maintainers).
- Automated use of BOSS直聘 (P4–P5 features are **not yet implemented**; compliance risk, not a security vulnerability in this repo).
- Issues caused by user-modified builds.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest (≥ 0.1.x) | ✅ security fixes land in the latest release |
| older | ⚠️ best effort |

## Disclosure

We will coordinate disclosure with you before publishing a fix. We ask that reporters give us a reasonable window (typically 90 days) before public disclosure.

---

*Thank you for helping keep BossJobAI safe.*
