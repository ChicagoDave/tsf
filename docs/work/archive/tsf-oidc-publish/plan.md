# Plan: TSF changes for GitHub workflow (trusted publishing) usage

**Source**: `../sharpee_v2/docs/publish/npm-ci.md` (Part A + §10.3), read 2026-07-25.
**Goal**: Release `@davidcornelson/tsf@1.0.1` so Sharpee's CI can run `tsf publish`
under npm trusted publishing (OIDC), where `npm whoami` always fails.
**Status**: COMPLETE — 1.0.1 published to npm 2026-07-25; remaining work is sharpee-side (Parts B–E)

## References consulted

- `../sharpee_v2/docs/publish/npm-ci.md` — the driving proposal (Part A, §5, §10.3)
- `src/cli/publish.ts` — verified: whoami gate at lines 130–138, `--no-git-checks` at line 199
- `docs/context/session-20260516-2214-main.md` — 1.0.0 publish record
- Memory: `project_publish_scope.md` — scoped public package, `prepublishOnly: pnpm build`

## Why 1.0.1 is needed

The published `1.0.0` predates two committed fixes (`dffd580` drop "type" from
publish manifest; `821d1e6` honor publish-import style) and contains the hard
`npm whoami` gate. Under trusted publishing there is no logged-in user — only
`npm publish` itself accepts OIDC credentials — so tsf exits before publishing
anything. Sharpee consumes tsf from npm in CI, so the fix must be released, not
just committed.

## Phase 1 — Skip the login gate under OIDC

`src/cli/publish.ts:129-138`. Detect GitHub Actions OIDC availability via
`process.env.ACTIONS_ID_TOKEN_REQUEST_URL` (set only when the job grants
`id-token: write`). When present, skip `npm whoami` and log
`OIDC credentials detected — skipping npm whoami check`; otherwise keep the
existing gate unchanged.

- Extract the decision into a small pure helper (e.g. `isOidcPublish(env)`)
  so it is unit-testable without shelling out.
- Safety argument (from the proposal): if auth is actually broken, the first
  `npm publish` fails loudly and tsf's existing error path exits non-zero.
- Behavior Statement + tests per rules 12/13: gate skipped when env var set;
  gate enforced and `process.exit(1)` path preserved when unset and `whoami`
  fails; dry-run still never checks login. Add `tests/publish.test.ts`.

## Phase 2 — Drop `--no-git-checks` from the npm invocation

`src/cli/publish.ts:199`. `--no-git-checks` is a pnpm flag; `npm publish`
warns and ignores it (§10.3 of the proposal). Remove it from the command
string. No behavior change intended.

## Phase 3 — Verify, bump, commit

1. `pnpm build && pnpm test` — full suite green before commit (rule 14).
2. Bump `package.json` version `1.0.0` → `1.0.1` (patch: two publish fixes +
   OIDC gate relaxation, no API change).
3. Commit; optionally tag `v1.0.1` (the 1.0.0 tag was never cut — user's call).

## Phase 4 — Publish 1.0.1 (David, manual)

`npm publish` from this repo — `prepublishOnly` rebuilds automatically. This is
the **last** publish requiring the 5-minute 2FA link. Verify with
`npm view @davidcornelson/tsf version`.

Optional follow-up (out of scope here): register a trusted publisher for tsf
itself so future tsf releases are also link-free — requires this repo to have a
GitHub remote + workflow.

## Out of scope (lives in sharpee_v2)

- Part A4: bump Sharpee's devDependency to `^1.0.1`, `pnpm install`, commit lockfile.
- Parts B–E: `publish-npm.yml` workflow, trusted-publisher registration ×32,
  first-run verification, token revocation.

## Risks

- **False OIDC detection**: `ACTIONS_ID_TOKEN_REQUEST_URL` is only set by the
  runner when `id-token: write` is granted; a workflow without that permission
  keeps the whoami gate. Local runs are unaffected (var never set).
- **No real-path test for the OIDC branch until Sharpee's Part D dry-run**: the
  unit tests cover the branch logic; the end-to-end proof is Sharpee's
  `dry_run: true` workflow run, which is the proposal's own Part D gate.
