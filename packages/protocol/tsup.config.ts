import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // A bundled, single-file .d.ts. build-rapport's build inlines this so the
  // published SDK is self-contained and needs no @rapport/protocol dependency.
  dts: true,
  clean: true,
});
