// import.meta read as a value: the module's metadata object answers the same
// members as the direct reads, keeps its identity, and is the object a
// function typed with ImportMeta can be handed.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { meta as child } from "./child.mjs";

const meta = import.meta;
console.log("keys", Object.keys(meta).join(","));
console.log(
  "fields",
  typeof meta.url,
  typeof meta.filename,
  typeof meta.dirname,
  meta.main,
  typeof meta.resolve,
  meta.resolve.length,
  meta.resolve.name,
);
console.log(
  "identity",
  meta === import.meta,
  meta.url === import.meta.url,
  meta.resolve === import.meta.resolve,
);
console.log(
  "bridge",
  fileURLToPath(meta.url) === meta.filename,
  basename(meta.filename) === "main.ts",
  basename(meta.dirname) === "esm-import-meta-object",
);
console.log("json", Object.keys(JSON.parse(JSON.stringify(meta)) as object).join(","));
function read(m: ImportMeta): string {
  return basename(m.filename);
}
console.log("passed", read(meta), meta.main);
console.log("child", child !== meta, child.main, basename(child.filename), Object.keys(child).join(","));
