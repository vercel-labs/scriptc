"use strict";
// The island half of the Node island ordering programs (scope-B design
// §5.2): `run(src)` interprets a small scheduling language inside Node,
// the same in a scriptc build (Node loaded in-process, one event loop) and
// under Node (@scriptc/node calls the module directly). Each program's
// main.ts is the native half. Ops (bodies in braces):
//   L name        log a line (synchronous write to fd 1)
//   J             log the AsyncLocalStorage store
//   Y { .. }      run the body inside als.run("s", ..)
//   T ms { .. }   setTimeout          I { .. }  setImmediate
//   M { .. }      queueMicrotask      K { .. }  process.nextTick
//   P { .. }      Promise.resolve().then(body)
//   R { .. }      fs.readFile, then the body
//   A { .. }      fs.promises.readFile, then the body
//   F n { .. }    n sequential fs.stat callbacks, then the body
//   N { .. }      a TCP round trip on localhost, the body on client data
//   C { .. }      child_process.execFile("/bin/true"), the body in its callback
//   D { .. }      dns.lookup("localhost")
//   Z { .. }      zlib.gzip
//   W { .. }      worker_threads: the body on the worker's first message
//   S { .. }      a socket idle timeout (a Node-internal timer)
//   O { .. }      an unref'd TCP server, the body on 'listening'
//   E             throw; G installs an uncaughtException handler that logs
//   B ms          busy-wait
const fs = require("node:fs");
const { AsyncLocalStorage } = require("node:async_hooks");

const als = new AsyncLocalStorage();

function parse(src) {
  const toks = src.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  function body() {
    if (toks[i++] !== "{") throw new Error(`expected { at ${i}`);
    const start = i;
    let depth = 1;
    while (depth) {
      const t = toks[i++];
      if (t === "{") depth++;
      else if (t === "}") depth--;
    }
    return toks.slice(start, i - 1).join(" ");
  }
  const out = [];
  while (i < toks.length) {
    const k = toks[i++];
    if (k === "L") out.push({ k, s: toks[i++] });
    else if (k === "J" || k === "E" || k === "G") out.push({ k });
    else if (k === "B") out.push({ k, ms: +toks[i++] });
    else if (k === "T" || k === "F") {
      const ms = +toks[i++];
      out.push({ k, ms, body: body() });
    } else out.push({ k, body: body() });
  }
  return out;
}

const log = (s) => fs.writeSync(1, `${s}\n`);
const busy = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

function exec(src) {
  for (const op of parse(src)) {
    switch (op.k) {
      case "L":
        log(op.s);
        break;
      case "J":
        log(`store=${als.getStore()}`);
        break;
      case "E":
        throw new Error("boom");
      case "G":
        process.on("uncaughtException", (e) => log(`uncaught-${e.message}`));
        break;
      case "Y":
        als.run("s", () => exec(op.body));
        break;
      case "B":
        busy(op.ms);
        break;
      default:
        schedule(op);
    }
  }
}

function schedule(op) {
  const run = () => exec(op.body);
  switch (op.k) {
    case "T":
      setTimeout(run, op.ms);
      break;
    case "I":
      setImmediate(run);
      break;
    case "M":
      queueMicrotask(run);
      break;
    case "K":
      process.nextTick(run);
      break;
    case "P":
      Promise.resolve().then(run);
      break;
    case "R":
      fs.readFile(__filename, run);
      break;
    case "A":
      fs.promises.readFile(__filename).then(run);
      break;
    case "F": {
      let n = op.ms;
      const next = () => (n-- > 0 ? fs.stat(__filename, next) : run());
      next();
      break;
    }
    case "N": {
      const net = require("node:net");
      const srv = net
        .createServer((s) => s.end("x"))
        .listen(0, "127.0.0.1", () => {
          const c = net.connect(srv.address().port, "127.0.0.1");
          c.once("data", () => {
            c.destroy();
            srv.close();
            run();
          });
        });
      break;
    }
    case "C":
      require("node:child_process").execFile("/bin/true", run);
      break;
    case "D":
      require("node:dns").lookup("localhost", run);
      break;
    case "Z":
      require("node:zlib").gzip("hello", run);
      break;
    case "W": {
      const { Worker } = require("node:worker_threads");
      const w = new Worker('require("node:worker_threads").parentPort.postMessage(1)', {
        eval: true,
      });
      w.once("message", () => {
        w.terminate();
        run();
      });
      break;
    }
    case "S": {
      const net = require("node:net");
      const srv = net
        .createServer((s) =>
          s.setTimeout(10, () => {
            s.destroy();
            srv.close();
            run();
          }),
        )
        .listen(0, "127.0.0.1", () => {
          const c = net.connect(srv.address().port, "127.0.0.1");
          c.on("error", () => {});
          c.on("close", () => {});
        });
      break;
    }
    case "O": {
      const s = require("node:net").createServer().listen(0, "127.0.0.1", run);
      s.unref();
      break;
    }
    default:
      throw new Error(`op ${op.k}`);
  }
}

exports.run = function run(src) {
  exec(src);
};
