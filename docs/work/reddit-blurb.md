# Reddit r/typescript Announcement

**Title:** I built tsf — a multi-target TypeScript build tool that rewrites workspace imports for npm publish

---

I've been working on a monorepo with ~20 TypeScript packages. The local dev experience is great — `import { Thing } from '@myorg/core'` just works via workspace symlinks.

But publishing to npm? Pain. That `@myorg/core` import means nothing to consumers. They need actual relative paths. So I had a 200-line bash script that:
- Built packages in dependency order
- Rewrote imports in .js files
- Rewrote imports in .d.ts files (different regex!)
- Updated package.json fields
- Hoped nothing broke

I finally mass-deleted it and built **tsf** instead.

**The idea:** One source, multiple build targets. Each target can have different import resolution.

```json
{
  "targets": {
    "local": { "outDir": "dist", "imports": "preserve" },
    "npm": { "outDir": "dist-npm", "imports": "relative", "condition": "publish" }
  }
}
```

**What it does to your code:**

Source:
```typescript
import { createLogger } from '@myorg/logger';
```

Local build (unchanged):
```javascript
const { createLogger } = require("@myorg/logger");
```

npm build (rewritten):
```javascript
const { createLogger } = require("../logger/dist-npm/index.js");
```

Declarations get rewritten too. It builds packages in dependency order, caches based on content hashes, and has commands for versioning/publishing in the right order.

**Not a bundler.** Your consumers still get tree-shaking. It just rewrites the specifiers.

Still early but stable enough that I'm using it for real projects. Would love feedback from anyone dealing with similar monorepo publishing pain.

GitHub: [TODO: add link]
