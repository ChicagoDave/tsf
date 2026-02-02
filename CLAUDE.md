# Project Instructions for Claude

## Overview

NSF (npm name TBD, working title "TypeScript Forge") is a multi-target TypeScript build tool for monorepos. It compiles one TypeScript source into multiple output targets with per-target import resolution, module format, and declaration handling.

## Key Problem

No existing tool rewrites `@scope/package` workspace imports to relative paths for npm publish while preserving them for local development. NSF solves the full matrix: targets x module formats x import resolution.

## Architecture

See `docs/work/architecture.md` for the full design document.

## Project Structure

```
src/
├── cli/              # CLI entry point, argument parsing
├── config/           # Config loading and validation
├── resolver/         # Workspace topology resolver (pnpm/npm/yarn)
├── orchestrator/     # Dependency ordering, parallel scheduling
├── compilers/        # Compiler adapters (tsc, esbuild, swc)
├── transform/        # Import and declaration rewriting
└── cache/            # Incremental build cache
tests/
docs/
├── work/             # Plans and implementation tracking
├── context/          # Session summaries
└── architecture/     # ADRs and design docs
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Work Patterns

- Planning docs: `docs/work/`
- Session summaries: `docs/context/session-YYYYMMDD-HHMM-{branch}.md`
- Architecture decisions: `docs/architecture/`
