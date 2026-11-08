"use strict";
exports.onFinish = (cb) => process.stdout.write("island queued\n", cb);
exports.end = () => new Promise((resolve) => {
  const { Writable } = require("node:stream");
  const chunks = [];
  const w = new Writable({ write(chunk, enc, cb) { chunks.push(String(chunk)); setImmediate(cb); } });
  w.on("finish", () => resolve(chunks.join("|")));
  exports.sink = w;
});
