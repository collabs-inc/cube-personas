import { build } from "esbuild";

await build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
