/**
 * Copy Dashboard.jsx → src/App.jsx (fix import paths for Vite src/).
 * Run after editing Dashboard.jsx at project root.
 */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dash = path.join(root, "Dashboard.jsx");
const app = path.join(root, "src", "App.jsx");

let s = readFileSync(dash, "utf8");
s = s
  .replace(/from "\.\/src\/lib\//g, 'from "./lib/')
  .replace(/from "\.\/src\/components\//g, 'from "./components/');
writeFileSync(app, s);
console.log("Synced Dashboard.jsx → src/App.jsx");
