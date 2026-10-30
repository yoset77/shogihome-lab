---
name: dependency-update
description: Review or update ShogiHome Lab dependencies, including Dependabot proposals, npm and Cargo security fixes, and GitHub Actions updates. Not for upstream feature ports.
---

# Dependency Updates

Treat Dependabot PRs as leads, not changes to merge directly. Normally update locally from current
`main` or the user-specified base, without copying bot lockfiles or cherry-picking bot commits.
Review-only requests make no edits. An update request authorizes work within its scope; ask before
materially expanding it or making unresolved migration or security-policy decisions.
Commit, push, create/merge PRs, or close Dependabot PRs only when requested.

## 1. Choose the Updates

- Check the working tree and base; preserve user changes. Inspect relevant manifests and lockfiles,
  using [Dependabot configuration](../../../.github/dependabot.yaml) to locate update targets.
- Compare proposals with current resolved versions, advisories, and official release/migration notes.
  Use `gh` for PR context. Bot CI is only a lead.
- Identify what to update, defer, or consider already resolved. Prefer supported, compatible versions,
  not necessarily the bot's proposed version or every latest release. Explain non-obvious deferrals.
- Group coupled packages and required compatibility fixes; separate independent risky migrations.
  Do not require one local change per bot PR or identical versions across separate projects.

## 2. Update Locally

- Use a normal work branch. Prefer targeted updates; change manifests and lockfiles together when
  requirements change. Include only necessary code adaptations and meaningful regression tests.
- Check the intent of exact pins and `overrides` before changing or removing them. Do not default to
  forced audit fixes, ignored peer constraints, or an application version bump.
- Preserve `shogihome/.npmrc`'s `ignore-scripts=true` and the existing script audit policy. Do not
  assume launcher UI has the same configuration or bypass script restrictions to make a build pass.
- `engine-wrapper/` and `engine-wrapper/launcher-app/src-tauri/` have independent Cargo lockfiles.
  Check both when shared local crates are affected; resolving one does not validate the other.
- Review unexpected dependency churn, new install scripts, runtime/toolchain requirements, and
  license changes. Do not relax security gates or license policy to force an update through.

## 3. Verify and Report

Use [AGENTS.md](../../../AGENTS.md), package scripts, [CI](../../../.github/workflows/test.yml), and
the [release workflow](../../../.github/workflows/release.yml) as the command/policy sources of truth.
Choose checks by affected area and risk; do not require every platform or release build for each patch.

- Web/Server: script audit, lint, tests, and frontend build; check Server build/runtime assembly when affected.
- Launcher UI: typecheck, tests, and build; check native integration for Tauri-related changes.
- Rust: audit affected lockfiles, format, clippy, and tests with locked dependency resolution;
  add relevant contract/native/GUI checks for runtime or Tauri changes.
- Actions/tools: inspect changed inputs, outputs, permissions, runner requirements, and artifacts.
  PR CI does not prove a release-only workflow was executed.
- Compare relevant security findings before/after, including build/CI exposure of dev dependencies.
  Check license notice generation when distributed dependencies change.

Review the final diff, including automatic lint fixes. Report updates, deferrals with reasons,
related Dependabot PRs, completed checks, and unavailable or CI-only verification. Do not claim an
unrun check passed. No separate dependency ledger, generated report, or update automation is required.
