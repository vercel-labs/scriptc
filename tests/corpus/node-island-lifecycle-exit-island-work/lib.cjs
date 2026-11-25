"use strict";
const fs = require("node:fs");
const net = require("node:net");
exports.start = () => {
  setInterval(() => {}, 1);
  fs.readFile(__filename, () => {});
  for (let i = 0; i < 50; i++) fs.stat(__filename, () => {});
  const srv = net.createServer(() => {}).listen(0, "127.0.0.1", () => {
    const c = net.connect(srv.address().port, "127.0.0.1");
    c.on("error", () => {});
  });
  require("node:zlib").gzip(Buffer.alloc(1 << 20), () => {});
  require("node:crypto").pbkdf2("p", "s", 50000, 32, "sha256", () => {});
  require("node:dns").lookup("localhost", () => {});
  const { Worker } = require("node:worker_threads");
  new Worker("setInterval(() => {}, 1000)", { eval: true });
  require("node:child_process").spawn("sleep", ["5"], { stdio: "ignore" }).on("error", () => {});
};
