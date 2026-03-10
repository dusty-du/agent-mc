import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const botDir = dirname(scriptDir);
const watcherSourceDir = join(botDir, "watcher");
const outputDir = join(botDir, "dist", "watcher");
const prismarinePublicDir = join(botDir, "..", "node_modules", "prismarine-viewer", "public");
const pathShim = join(scriptDir, "path-browser-shim.cjs");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

await build({
  entryPoints: [join(watcherSourceDir, "client.ts")],
  outfile: join(outputDir, "watcher.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  alias: {
    path: pathShim
  },
  define: {
    "__dirname": "\"\"",
    "process.platform": "\"browser\"",
    "globalThis.isElectron": "false"
  }
});

await Promise.all([
  copyFile(join(watcherSourceDir, "index.html"), join(outputDir, "index.html")),
  copyFile(join(watcherSourceDir, "styles.css"), join(outputDir, "styles.css")),
  cp(join(prismarinePublicDir, "worker.js"), join(outputDir, "worker.js")),
  cp(join(prismarinePublicDir, "textures"), join(outputDir, "textures"), { recursive: true }),
  cp(join(prismarinePublicDir, "blocksStates"), join(outputDir, "blocksStates"), { recursive: true })
]);
