# Contributing to Talome

Thanks for your interest in contributing to Talome! Whether it's a bug fix, new feature, documentation improvement, or just a question — all contributions are welcome.

## Development Setup

### Prerequisites

- **Node.js** 22+ (matches the runtime — `install.sh` enforces this and `apps/core` will not build under older versions)
- **pnpm** 10+
- **Docker** (for running services locally; OrbStack recommended on macOS)
- **git** (required — Talome's self-evolution uses git stash/rollback for safety)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/tomastruben/Talome.git
cd Talome

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your local configuration

# Start all services in development mode
pnpm dev
```

### Monorepo Structure

| Path | Description |
|---|---|
| `apps/core` | Hono backend API |
| `apps/dashboard` | Next.js dashboard application |
| `apps/web` | Marketing site |
| `packages/types` | Shared TypeScript type definitions |

## Making Changes

### Workflow

1. **Fork** the repository
2. **Create a branch** from `main`
3. **Make your changes** and commit them
4. **Open a Pull Request** against `main`

### Branch Naming

Use a prefix that describes the type of change:

- `feat/` — new features (e.g., `feat/app-templates`)
- `fix/` — bug fixes (e.g., `fix/dashboard-auth-redirect`)
- `docs/` — documentation changes (e.g., `docs/api-endpoints`)

### Before Submitting a PR

```bash
# Type-check the entire monorepo
pnpm typecheck

# Run tests
pnpm test
```

Both must pass. CI will enforce this as well.

### PR Guidelines

- **Keep PRs focused.** One feature or fix per PR. If you find an unrelated issue along the way, open a separate PR for it.
- Write a clear description of what changed and why.
- Link any related GitHub Issues.
- If your change affects the UI, include a screenshot or short recording.

## Code Style

- **TypeScript** is used throughout the entire codebase. Avoid `any` where possible.
- **ESLint** is configured for `apps/dashboard` (`pnpm --filter dashboard lint`). The Hono backend (`apps/core`) and marketing site (`apps/web`) rely on the TypeScript compiler for static checks.
- **Functional patterns** are preferred — pure functions, immutability, composition over inheritance.
- **shadcn/ui** is the component library for the dashboard. Use existing components before building custom ones.

### General Conventions

- Name files and directories in `kebab-case`.
- Co-locate tests next to the code they test.
- Keep modules small and focused on a single responsibility.

## Reporting Issues

Use [GitHub Issues](../../issues) to report bugs or request features.

When reporting a bug, please include:

- **Steps to reproduce** the problem
- **Expected behavior** vs. **actual behavior**
- Your environment (OS, Node.js version, browser if relevant)
- Any relevant logs or error messages

## Getting Help

- **Discord:** [discord.gg/HK7gFaVRJ](https://discord.gg/HK7gFaVRJ)
- **Discussions:** [GitHub Discussions](https://github.com/tomastruben/Talome/discussions)

## License

By contributing to Talome, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](LICENSE) license.
