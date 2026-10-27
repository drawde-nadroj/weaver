import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.env.WEAVER_VAULT ?? "/Users/jordan/Knowledge";
const destination = join(vault, ".obsidian", "plugins", "weaver");

// Files the plugin needs at runtime. data.json is owned by Obsidian and is
// never copied, replaced, or deleted here.
const files = ["main.js", "manifest.json", "styles.css"];

await mkdir(destination, { recursive: true });

for (const file of files) {
  await copyFile(join(root, file), join(destination, file));
}

console.log(`Deployed Weaver to ${destination}`);
