import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/frontend");
const destination = resolve(root, "packages/tokal/frontend");

if (!existsSync(source)) {
  throw new Error(`Frontend source not found: ${source}`);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, {
  recursive: true,
  filter: (path) => {
    const normalized = path.replaceAll("\\", "/");
    return !normalized.includes("/node_modules") &&
      !normalized.includes("/.next") &&
      !normalized.includes("/coverage") &&
      !normalized.endsWith("/.env.local");
  },
});

console.log(`Copied frontend into ${destination}`);
