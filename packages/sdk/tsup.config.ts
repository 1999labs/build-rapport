import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    // No "type": "module" in package.json, so tsup emits index.js (CJS) and
    // index.mjs (ESM).
    format: ["esm", "cjs"],
    // `resolve` inlines @rapport/protocol's types into the .d.ts (protocol now
    // emits real .d.ts files), so the published declarations are
    // self-contained.
    dts: { resolve: ["@rapport/protocol"] },
    clean: true,
    sourcemap: true,
    treeshake: true,
    // Inline @rapport/protocol and nanoid (and protocol's transitive crypto
    // deps) so the published SDK has zero runtime dependencies.
    noExternal: ["@rapport/protocol", "nanoid"],
  },
  {
    // Built as a separate entry so consumers who only import { Rapport }
    // never pay the CLI bundle cost. CJS-only — the file is executed via
    // shebang, not imported.
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    sourcemap: false,
    // Don't clean — that would erase the lib output produced above.
    clean: false,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["@rapport/protocol", "nanoid"],
  },
]);
