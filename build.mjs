import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

// On Windows the dev server keeps `public/` open and re-caching a wiped
// directory breaks asset serving, so we overwrite files instead of wiping.
async function cleanDir() {
  /* intentionally a no-op during local dev; use `npm run build:fresh` to wipe */
}

await cleanDir();
await mkdir("public", { recursive: true });

await build({
  entryPoints: ["src/worker.ts"],
  outfile: "worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});

await cp("src/web", "public", { recursive: true });

// Item 7 packaging guard: the shippable bundle (worker.js + public/) must
// never contain local secrets or stray dotfiles — .dev.vars and friends stay
// on the dev machine, out of git and out of every package.
const FORBIDDEN = [/^\.dev\.vars/, /^\.env/, /^\.wrangler/];
const publicFiles = await readdir("public");
for (const name of publicFiles) {
  if (name.startsWith(".") || FORBIDDEN.some((re) => re.test(name))) {
    throw new Error(`refusing to package public/${name}: secrets must never ship`);
  }
}

// Palette bridge: expose the shared src/palette.ts list to the browser as a
// plain ES module so app.js imports the identical palette without bundling.
const paletteSrc = await readFile("src/palette.ts", "utf8");
const paletteJson = paletteSrc
  .match(/ART_PALETTE: readonly string\[\] = \[([\s\S]*?)\];/)?.[1]?.trim() ?? "";
if (!paletteJson) throw new Error("could not extract ART_PALETTE from src/palette.ts");
const paletteContent =
  `export const ART_PALETTE = [${paletteJson}];\n` +
  `export const ART_PALETTE_VERSION = 1;\n`;
await writeFile("src/web/palette.js", paletteContent);
await writeFile("public/palette.js", paletteContent);

// Cache-busting: give app.js/style.css a content-hash query in index.html so a
// browser (or the preview webview) can never serve a stale file after a rebuild.
const assetHash = createHash("sha256")
  .update(await readFile("public/app.js"))
  .update(await readFile("public/style.css"))
  .update(await readFile("public/palette.js"))
  .digest("hex")
  .slice(0, 8);
{
  const htmlPath = "public/index.html";
  let html = await readFile(htmlPath, "utf8");
  html = html.replace(
    /(src|href)="\/(app\.js|style\.css|palette\.js)"/g,
    (_m, attr, file) => `${attr}="/${file}?v=${assetHash}"`,
  );
  await writeFile(htmlPath, html);
}

const manifest = {
  entrypoint: "index.js",
  compatibilityDate: "2026-10-01",
  compatibilityFlags: ["nodejs_compat"],
  modules: [{ name: "index.js", type: "esm", path: "./worker.js" }],
  assetsDirectory: "./public",
  spa: true,
};

await writeFile("deploy.manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("built: worker.js + public/ + deploy.manifest.json");
