# I built a tool that rewrites workspace imports to relative paths for npm publish

If you maintain a TypeScript monorepo with workspace packages, you've hit this problem: your code uses `@myorg/logger` imports that resolve via symlinks locally, but when you `npm publish`, consumers get broken imports pointing at packages that don't exist in their node_modules.

The usual solutions are all painful:

- A custom build script (ours was 800 lines of bash) that rewrites imports, manages declarations, and coordinates builds across 30+ packages
- A bundler that inlines everything, which defeats the purpose of publishing separate packages
- Maintaining parallel tsconfig files per output target

**tsf** solves this with a single config file:

```json
{
  "projects": ["packages/*/tsconfig.json"],
  "targets": {
    "local": {
      "module": "commonjs",
      "outDir": "dist",
      "imports": "preserve",
      "declarations": true
    },
    "npm": {
      "module": "commonjs",
      "outDir": "dist-npm",
      "imports": "relative",
      "declarations": true,
      "condition": "publish"
    }
  }
}
```

The `local` target preserves workspace imports for development. The `npm` target rewrites `@myorg/logger` to `../logger/dist-npm/index.js` — in both JS and declaration files. The `condition: "publish"` scoping means it only applies to packages that actually get published (those with `publishConfig`).

It builds packages in dependency order, caches unchanged packages, and works with pnpm, npm, and yarn workspaces. You can also use esbuild or swc as the transpiler if tsc is too slow.

```bash
tsf init                    # detect your project, generate config
tsf build --all             # build all targets
tsf version 1.0.0 --condition publish  # bump versions on npm packages
tsf validate                # verify nothing leaked
```

GitHub: https://github.com/ChicagoDave/tsf

Happy to answer questions about the approach or take feedback on what's missing.
