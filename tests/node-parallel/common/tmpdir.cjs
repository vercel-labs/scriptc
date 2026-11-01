"use strict";
// test/common/tmpdir.js for the minimal test/common: a per-run directory
// beside test/parallel, with the semantics of Node's helper.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const testRoot = path.resolve(__dirname, "..");
let tmpPath = path.join(testRoot, `.tmp.${process.env.TEST_SERIAL_ID || process.env.TEST_THREAD_ID || "0"}`);

let firstRefresh = true;
function refresh() {
  fs.rmSync(tmpPath, { maxRetries: 3, recursive: true, force: true });
  fs.mkdirSync(tmpPath);
  if (firstRefresh) {
    firstRefresh = false;
    process.on("exit", () => {
      process.chdir(testRoot);
      fs.rmSync(tmpPath, { maxRetries: 3, recursive: true, force: true });
    });
  }
}

function resolve(...paths) {
  return path.resolve(tmpPath, ...paths);
}

function hasEnoughSpace(size) {
  const { bavail, bsize } = fs.statfsSync(tmpPath);
  return bavail >= Math.ceil(size / bsize);
}

function fileURL(...paths) {
  return pathToFileURL(resolve(...paths));
}

module.exports = {
  fileURL,
  hasEnoughSpace,
  refresh,
  resolve,
  get path() {
    return tmpPath;
  },
  set path(newPath) {
    tmpPath = path.resolve(newPath);
  },
};
