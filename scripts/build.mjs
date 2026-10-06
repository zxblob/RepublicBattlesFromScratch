import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const prod = process.env.NODE_ENV === "production";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/public", { recursive: true });

await build({
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/server.js",
  packages: "external",
  sourcemap: !prod,
});

await build({
  entryPoints: { main: "src/client/main.ts", editor: "src/client/editor.ts" },
  bundle: true,
  format: "esm",
  target: "es2020",
  outdir: "dist/public",
  minify: prod,
  sourcemap: !prod,
});

await cp("src/client/static", "dist/public", { recursive: true });
await cp("maps/premade", "dist/maps", { recursive: true });
console.log("built -> dist/");

// cache-bust the entry script so deploys are picked up immediately
import { readFile, writeFile } from "node:fs/promises";
const v = Date.now().toString(36);
let html = await readFile("dist/public/index.html", "utf8");
html = html.replace('src="main.js"', `src="main.js?v=${v}"`).replace('href="style.css"', `href="style.css?v=${v}"`);
await writeFile("dist/public/index.html", html);
let ed = await readFile("dist/public/editor.html", "utf8");
ed = ed.replace('src="editor.js"', `src="editor.js?v=${v}"`).replace('href="style.css"', `href="style.css?v=${v}"`);
await writeFile("dist/public/editor.html", ed);
