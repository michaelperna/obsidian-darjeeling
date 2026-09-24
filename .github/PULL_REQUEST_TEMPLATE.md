## Description

Please provide a summary of the changes and the related issue/context.

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Refactoring / optimization
- [ ] Documentation update
- [ ] CI / tooling update

## Privacy & Quality Checklist

- [ ] **Privacy Guard**: No API keys, tokens, personal vault excerpts, or sensitive data are committed.
- [ ] **Scrub Guard**: `./scripts/ci/scrub-guard.sh` passes locally.
- [ ] **Tests**: `npm test` passes cleanly.
- [ ] **Types & Build**: `npx tsc --noEmit` and `npm run build` succeed with no errors.
- [ ] **Reproducibility**: Build artifacts are not tracked in git and build produces reproducible output.
