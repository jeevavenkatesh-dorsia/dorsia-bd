/** Copy src/App.jsx → Dashboard.jsx (adjust import paths for project root). */
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "src", "App.jsx");
const dash = path.join(root, "Dashboard.jsx");

let s = readFileSync(app, "utf8");
s = s
  .replace(/from "\.\/lib\//g, 'from "./src/lib/')
  .replace(/from "\.\/components\//g, 'from "./src/components/');
writeFileSync(dash, s);
console.log("Synced src/App.jsx → Dashboard.jsx");
