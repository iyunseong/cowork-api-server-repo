// Assemble www/ for the bus app. No bundler (native ES modules).
// Shares the operator-agnostic macro engine with the KTX app by copying it in.

import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "src");
const www = join(root, "www");
const sharedMacro = join(root, "..", "mobile", "src", "macro.js");

if (existsSync(www)) rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

cpSync(join(src, "ui"), www, { recursive: true });
cpSync(join(src, "app.js"), join(www, "app.js"));
cpSync(join(src, "client.js"), join(www, "client.js"));
cpSync(join(src, "bus"), join(www, "bus"), { recursive: true });
cpSync(sharedMacro, join(www, "macro.js")); // shared with the KTX app

console.log("www/ built:", www);
