# nsf

Multi-target TypeScript build tool for monorepos.

Compiles one TypeScript source into multiple output targets with per-target import resolution, module format, and declaration handling.

## The Problem

TypeScript monorepos need different builds for different consumers:
- **Local development**: workspace imports (`@scope/pkg`) resolved via symlinks
- **npm publish**: workspace imports rewritten to relative paths or peer dependencies
- **Bundling**: all imports resolved and inlined into a single file
- **Browser**: ESM output with bundled or mapped imports

No existing tool handles the full matrix. nsf does.

## Quick Start

```bash
npx nsf init          # Generate nsf.config.json from existing tsconfig files
npx nsf build         # Build default target
npx nsf build --all   # Build all targets
```

## Configuration

`nsf.config.json`:

```json
{
  "projects": ["packages/*/tsconfig.json"],
  "targets": {
    "local": {
      "module": "commonjs",
      "outDir": "dist",
      "imports": "preserve"
    },
    "npm": {
      "module": "commonjs",
      "outDir": "dist-npm",
      "imports": "relative",
      "condition": "publish"
    }
  }
}
```

## Import Resolution Strategies

| Strategy | Use Case | What Happens |
|---|---|---|
| `preserve` | Local dev | Imports left as-is |
| `relative` | npm publish | `@scope/pkg` → relative paths |
| `bundle` | Browser/CLI | All imports inlined |
| `specifier-map` | Deno | Rewritten per import map |

## Status

Early development. See `docs/work/architecture.md` for the full design.

## License

MIT
