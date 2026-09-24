# Contributing to Project Darjeeling

Thank you for your interest in contributing to Project Darjeeling!

## Privacy & Security First

> [!CAUTION]
> **NEVER paste or commit API keys, bearer tokens, passwords, or personal vault note contents in issues, PRs, comments, or commit history.**
>
> When submitting bug reports or logs:
> - Scrub all bearer tokens and session IDs.
> - Redact private vault file paths, note titles, and note text.
> - Replace real IP addresses and network endpoints with placeholders (e.g. `127.0.0.1` or `server.tailnet.ts.net`).

Before submitting changes, ensure `scripts/ci/scrub-guard.sh` and `scripts/ci/egress-audit.sh` run cleanly.

---

## Development Setup

### Prerequisites

- **Node.js**: Version 22 LTS
- **Python**: Version 3.10+ (for the companion daemon)
- **Obsidian**: v1.11.5 or newer

### Building and Testing

<!-- not-run: developer environment commands -->
```bash
# Install dependencies
npm ci --ignore-scripts

# Run unit tests and type checks
npm test
npx tsc --noEmit

# Run linters
npm run lint:css
npx eslint src/

# Verify outbound network egress and privacy scrub
./scripts/ci/egress-audit.sh
./scripts/ci/scrub-guard.sh

# Build production bundle
npm run build
```

---

## Pull Request Guidelines

1. **Clean Commits**: Write concise, descriptive commit messages following Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).
2. **Reproducibility**: Ensure changes preserve byte reproducibility of builds and do not introduce unpinned or unverified external dependencies.
3. **No Tracked Build Artifacts**: Do not commit `main.js`, `styles.css`, or server virtual environments.
4. **All CI Checks Pass**: Pull requests must pass all checks defined in `./scripts/lab/lab.sh ci`.
