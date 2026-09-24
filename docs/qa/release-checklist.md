# Darjeeling Release Verification Checklist

This checklist defines the release criteria for Project Darjeeling releases. It replaces ad-hoc or unverified testing protocols with automated verification gates and a clean, non-identifying manual device test pass.

---

## 1. Automated Release Gates (Blocking)

All automated gates must pass cleanly prior to cutting a release tag or distributing artifacts.

| Gate | Command | Passing Criteria |
|---|---|---|
| **CI Suite** | `./scripts/lab/lab.sh ci` | 0 failures, 0 warnings across plugin (tsc, build, tests, manifest, mobile requires) and server (pyflakes, compile, pytest, shellcheck). |
| **Outbound Egress Audit** | `./scripts/ci/egress-audit.sh` | 0 unannotated network call sites in `src/`. All declared egress IDs match rows in `README.md` ("Network use and data"). |
| **Privacy & Scrub Guard** | `./scripts/ci/scrub-guard.sh` | 0 personal names, internal IPs, private tokens, or vault-specific paths in codebase and documentation. |
| **E2E Acceptance Suite** | `./scripts/lab/lab.sh e2e` | >= 14 end-to-end Playwright tests pass against headless Obsidian instance in clean container. |
| **Oldest Obsidian Compatibility** | `./scripts/lab/lab.sh e2e --obsidian 1.11.5` | Happy path and core chat pass on minimum supported Obsidian version (`minAppVersion`). |
| **Server Installation Matrix** | `./scripts/lab/lab.sh install all` | Automated installer succeeds on Debian 12, Debian 13, Ubuntu 22.04, and Ubuntu 24.04 (fresh and rerun scenarios). |
| **Documentation Executability** | `./scripts/lab/lab.sh docs-check` | Shell blocks in `docs/install-server.md` run verbatim in a fresh container to authenticated `/api/agents`. |
| **Release Reproducibility** | `./scripts/lab/lab.sh release-dry-run <version>` | Two successive clean builds produce byte-identical `main.js` and identical `SHA256SUMS` for server tarball. |

---

## 2. Manual Device Verification Pass

Before tagging a release, verify basic UX flows manually on target platforms using a sterile test vault. Do not include any personal notes or sensitive configuration.

### Desktop (macOS / Linux / Windows)
- [ ] **Clean Install**: Install `main.js`, `manifest.json`, `styles.css` into `.obsidian/plugins/darjeeling/`. Enable plugin; verify load time <= 300 ms without exceptions in developer console.
- [ ] **Host Connection & Pairing**:
  - [ ] Connect to local or remote companion server using 8-digit pairing code.
  - [ ] Verify token is saved to device-local storage and not written to `data.json`.
- [ ] **Chat Surface**:
  - [ ] Send prompt to host-backed agent (e.g. Claude Code or bash runner). Verify token streaming and tool call rendering.
  - [ ] Trigger interrupt mid-turn; verify turn halts cleanly and UI restores prompt box.
- [ ] **Direct API Mode**:
  - [ ] Configure provider API key (Anthropic, Gemini, DeepSeek, or Ollama).
  - [ ] Run test prompt; verify model response, reasoning extraction (if applicable), and token accounting.
- [ ] **Plan Surface**:
  - [ ] Create a multi-phase architectural plan.
  - [ ] Verify interactive phase checklist transitions.
  - [ ] Export plan to Markdown note and Obsidian Canvas (`.canvas`); verify visual rendering in Obsidian.
- [ ] **Terminal Surface**:
  - [ ] Open embedded PTY terminal.
  - [ ] Verify shell interactivity, bracketed paste, and external link handling.

### Mobile & Tablet (iOS / iPadOS / Android)
- [ ] **Onboarding & Responsive Layout**:
  - [ ] Open Darjeeling sidebar / leaf in mobile Obsidian.
  - [ ] Verify views conform to narrow mobile viewports without horizontal overflow.
- [ ] **Pairing Flow**:
  - [ ] Test pairing via manual code entry or deep-link callback (`obsidian://darjeeling/pair?code=...`).
- [ ] **Composer Interaction**:
  - [ ] Tap composer input on virtual keyboard; verify input remains visible and focused without viewport clipping or obscuring.
- [ ] **Accessory Bar**:
  - [ ] Verify mobile accessory keys insert expected markdown markers and quick slash commands.

---

## 3. Artifact Validation & Sign-Off

- [ ] `manifest.json` version matches release git tag and `package.json`.
- [ ] Server distribution package `darjeeling-server-<version>.tar.gz` created with deterministic metadata (`SOURCE_DATE_EPOCH`, sorted archive, numeric ownership, `gzip -n`).
- [ ] Checksums published: `SHA256SUMS` contains checksums for `darjeeling-server-<version>.tar.gz`, `main.js`, `manifest.json`, and `styles.css`.
- [ ] `CHANGELOG.md` updated with release highlights, breaking changes, and bug fixes.
