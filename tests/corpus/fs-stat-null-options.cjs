// fs.promises.stat/lstat with an options value typed null (a possibility a
// JavaScript program reaches that the strict TypeScript surface refuses):
// Node's default parameter covers only undefined, so the call validates the
// path, evaluates the options expression, then reads options.bigint off the
// null and rejects with that TypeError. The expression's own throw still
// replaces the rejection.
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-stat-null-"));
const file = path.join(dir, "file.txt");
const missing = path.join(dir, "missing.txt");
fs.writeFileSync(file, "x");
const log = [];

function pathExpr() {
  log.push("path");
  return file;
}
/** @returns {null} */
function nullOpts() {
  log.push("opts");
  return null;
}
/** @returns {null} */
function throwingOpts() {
  log.push("throwing");
  throw new Error("options boom");
}

(async () => {
  try {
    await fsp.stat(file, null);
    console.log("stat literal", "fulfilled");
  } catch (error) {
    console.log("stat literal", error.message, log.join(","));
  }
  log.length = 0;

  try {
    await fsp.stat(pathExpr(), nullOpts());
    console.log("stat call", "fulfilled");
  } catch (error) {
    console.log("stat call", error.message, log.join(","));
  }
  log.length = 0;

  try {
    await fsp.lstat(pathExpr(), nullOpts());
    console.log("lstat call", "fulfilled");
  } catch (error) {
    console.log("lstat call", error.message, log.join(","));
  }
  log.length = 0;

  try {
    await fsp.stat(missing, nullOpts());
    console.log("missing", "fulfilled");
  } catch (error) {
    console.log("missing", error.message, log.join(","));
  }
  log.length = 0;

  try {
    await fsp.lstat(missing, null);
    console.log("missing lstat", "fulfilled");
  } catch (error) {
    console.log("missing lstat", error.message, log.join(","));
  }
  log.length = 0;

  // The options expression throws synchronously, before stat returns its
  // promise: the throw reaches this frame, keeping the evaluated path.
  try {
    await fsp.stat(pathExpr(), throwingOpts());
    console.log("throwing unexpected");
  } catch (error) {
    console.log("throwing", error.message, log.join(","));
  }
  log.length = 0;

  console.log("plain stat", (await fsp.stat(file)).size);
  fs.rmSync(dir, { recursive: true, force: true });
})();
