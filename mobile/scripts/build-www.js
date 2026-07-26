// Assemble the Capacitor web assets (www/) from src/.
// No bundler: the app uses native ES modules, so we just copy the module tree
// preserving relative import paths (app.js -> ./macro.js, ./korail/*.js).

import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "src");
const www = join(root, "www");

if (existsSync(www)) rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

// UI shell (index.html, styles.css) at the www root.
cpSync(join(src, "ui"), www, { recursive: true });
// App + macro modules at the root so their relative imports resolve.
cpSync(join(src, "app.js"), join(www, "app.js"));
cpSync(join(src, "macro.js"), join(www, "macro.js"));
// Korail client tree under www/korail/.
cpSync(join(src, "korail"), join(www, "korail"), { recursive: true });

console.log("www/ built:", www);
