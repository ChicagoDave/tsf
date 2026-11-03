# Project Instructions for Claude

## Overview

TSF (TypeScript Forge) is a multi-target TypeScript build tool for monorepos. It compiles one TypeScript source into multiple output targets with per-target import resolution, module format, and declaration handling.

## Key Problem

No existing tool rewrites `@scope/package` workspace imports to relative paths for npm publish while preserving them for local development. TSF solves the full matrix: targets x module formats x import resolution.

## Architecture

See `docs/work/architecture.md` for the full design document.

## Work Patterns

- Planning docs: `docs/work/`
- Session summaries: `docs/context/session-YYYYMMDD-HHMM-{branch}.md`
- Architecture decisions: `docs/adrs/` (ADR-NNNN-title.md, DEVARCH rule 11)

<!-- devarch:start -->
@~/.devarch/DEVARCH.md
<!-- devarch:end -->
