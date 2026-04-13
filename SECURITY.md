# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Talome, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **GitHub Security Advisory** (preferred): Go to [Security Advisories](https://github.com/tomastruben/Talome/security/advisories/new) and create a new advisory.
2. **Email**: Send details to **security@talome.dev**

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity, typically within 2 weeks for critical issues

### Scope

The following are in scope:

- Talome core application (`apps/core/`, `apps/dashboard/`)
- The installer script (`install.sh`)
- Docker image and compose templates
- The marketing site (`talome.dev`)

The following are out of scope:

- Third-party apps installed through the app store (report to their maintainers)
- Issues in upstream dependencies (report to the dependency maintainer, then let us know)

### Safe Harbor

We will not take legal action against researchers who:

- Act in good faith to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts they own or have explicit permission to test
- Report vulnerabilities promptly and do not exploit them beyond what is needed to demonstrate the issue

Thank you for helping keep Talome and its users safe.
