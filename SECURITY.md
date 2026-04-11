# Security Policy

Talome takes security seriously. Thank you for helping keep Talome and its users safe.

## Supported Versions

Talome is in **public alpha**. Only the latest release on the `main` branch is supported with security updates. We recommend always running the most recent version.

| Version | Supported |
|---|---|
| Latest `main` | Yes |
| Tagged releases (`v1.x`) | Yes, latest only |
| Everything else | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report privately through one of these channels:

1. **GitHub Security Advisories** — [open a private report](https://github.com/tomastruben/Talome/security/advisories/new) (preferred)
2. **Email** — `security@talome.dev` (if configured) or reach the maintainer directly via a private Discord DM

Please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept is appreciated but not required)
- The Talome version and platform where you observed it
- Any suggested remediation if you have one

## What to Expect

- **Acknowledgement** within 72 hours
- **Triage and severity assessment** within 7 days
- **Fix and disclosure** coordinated with you — we will credit you in the release notes if you want credit

## Scope

In scope:

- The Talome core backend (`apps/core`)
- The dashboard frontend (`apps/dashboard`)
- The marketing site (`apps/web`) for issues that affect user trust (XSS, supply-chain, etc.)
- The installer scripts (`install.sh`, `install.ps1`)
- The Docker image on `ghcr.io/tomastruben/talome`

Out of scope:

- Third-party services Talome integrates with (Anthropic API, Docker Hub, etc.) — report these to the vendor
- Self-hosted user instances you do not own
- Vulnerabilities that require physical access to the host
- Social-engineering attacks against Talome users
- Missing security headers that do not lead to a concrete exploit

## Disclosure Policy

We follow a **coordinated disclosure** model. We ask that you give us a reasonable time to fix the issue before public disclosure — typically 90 days, but we will work with you on a timeline that fits the severity.

Once a fix is released, we will publish a security advisory on GitHub with the CVE (if applicable), the fix version, and credit to the reporter.

## Hall of Fame

Security researchers who have responsibly disclosed vulnerabilities will be listed here after their issue is resolved.

_(No entries yet — be the first!)_
