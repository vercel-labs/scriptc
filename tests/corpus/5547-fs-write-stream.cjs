// fs.createWriteStream: event order, buffered writes before the open,
// bytesWritten, flags/start, close(cb), errors and option checks.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-ws-"));
const file = path.join(dir, "out.txt");

// Prints a block's log once its stream closes (the stream's own
// listener reads its members, then calls this).
function report(label, log, bytesWritten, pending) {
  log.push(`close bytesWritten=${bytesWritten} pending=${pending}`);
  console.log(label);
  for (const l of log) console.log(`  ${l}`);
}

function check(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (err) {
    console.log(label, err.name, err.code, err.message);
  }
}

(async () => {
  {
    const log = [];
    const ws = fs.createWriteStream(file);
    log.push(`pending=${ws.pending} path=${ws.path === file} bytesWritten=${ws.bytesWritten}`);
    ws.on("open", (fd) => log.push(`open ${typeof fd}`));
    ws.on("ready", () => log.push("ready"));
    ws.on("finish", () => log.push(`finish bytesWritten=${ws.bytesWritten}`));
    log.push(`write1 ${ws.write("hello ", () => log.push("cb1"))}`);
    log.push(`write2 ${ws.write(Buffer.from("world"), () => log.push("cb2"))}`);
    ws.end("!", () => log.push("end cb"));
    await new Promise((resolve) => ws.on("close", () => resolve(report("basic", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file, { flags: "a" });
    ws.write("+append");
    ws.end();
    await new Promise((resolve) => ws.on("close", () => resolve(report("append", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file, { flags: "r+", start: 2 });
    ws.end("XY");
    await new Promise((resolve) => ws.on("close", () => resolve(report("start 2", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file, { highWaterMark: 4 });
    ws.on("drain", () => log.push("drain"));
    log.push(`write ${ws.write("abcdef")}`);
    ws.once("drain", () => {
      log.push(`after drain ${ws.write("gh")}`);
      ws.end();
    });
    await new Promise((resolve) => ws.on("close", () => resolve(report("hwm 4", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file);
    ws.write("closed");
    ws.close(() => log.push("close cb"));
    await new Promise((resolve) => ws.on("close", () => resolve(report("close(cb)", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(path.join(dir, "missing", "x.txt"));
    ws.on("error", (err) => log.push(`error ${err.code} ${err.syscall}`));
    ws.write("lost", () => log.push("write cb"));
    await new Promise((resolve) => ws.on("close", () => resolve(report("missing dir", log, ws.bytesWritten, ws.pending))));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file, { flags: "bogus" });
    ws.on("error", (err) => log.push(`error ${err.name} ${err.code} ${err.message}`));
    await new Promise((resolve) => ws.on("close", () => resolve(report("bad flags", log, ws.bytesWritten, ws.pending))));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file);
    ws.destroy();
    log.push(`destroyed ${ws.destroyed}`);
    await new Promise((resolve) => ws.on("close", () => resolve(report("destroy before open", log, ws.bytesWritten, ws.pending))));
  }
  {
    const log = [];
    const ws = fs.createWriteStream(file, { flush: true });
    ws.end("flushed");
    await new Promise((resolve) => ws.on("close", () => resolve(report("flush", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    // close() through an untyped value
    const shut = (stream) => stream.close();
    const log = [];
    const ws = fs.createWriteStream(file);
    ws.write("shut");
    shut(ws);
    await new Promise((resolve) => ws.on("close", () => resolve(report("close untyped", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  check("flush string", () => fs.createWriteStream(file, { flush: "yes" }));
  check("start negative", () => fs.createWriteStream(file, { start: -1 }));
  check("path null", () => fs.createWriteStream(null));
  check("fd string", () => fs.createWriteStream(file, { fd: "3" }));
  // Node's constructor throws here after scheduling the open, so the
  // stream still opens (and truncates) its file later: keep it off `file`.
  check("encoding buffer", () => fs.createWriteStream(path.join(dir, "unknown-encoding.txt"), { encoding: "buffer" }));
  check("hwm string", () => fs.createWriteStream(file, { highWaterMark: "4" }));
  {
    const log = [];
    const fd = fs.openSync(file, "w");
    const ws = fs.createWriteStream(null, { fd });
    log.push(`pending=${ws.pending}`);
    ws.on("open", () => log.push("open"));
    ws.end("by fd");
    await new Promise((resolve) => ws.on("close", () => resolve(report("fd", log, ws.bytesWritten, ws.pending))));
    console.log("content", JSON.stringify(fs.readFileSync(file, "utf8")));
  }
  {
    const src = path.join(dir, "src.txt");
    fs.writeFileSync(src, "x".repeat(100000));
    const ws = fs.createWriteStream(file);
    fs.createReadStream(src).pipe(ws);
    await new Promise((resolve) => ws.on("close", () => resolve(report("pipe", [], ws.bytesWritten, ws.pending))));
    console.log("piped", fs.statSync(file).size);
  }
  // Nothing can wait for that stream: its constructor threw, and its open
  // runs on the thread pool when a thread gets to it. Under load that has
  // been later than everything above (in the native program, whose reads
  // and writes of cached files do not pass through the pool), so the check
  // waits for the file, and so does the removal of the directory the open
  // creates it in. An open that was never scheduled runs into the limit and
  // prints false.
  const opened = path.join(dir, "unknown-encoding.txt");
  const limit = Date.now() + 60000;
  while (!fs.existsSync(opened) && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 1));
  console.log("unknown-encoding stream opened its file", fs.existsSync(opened));
  fs.rmSync(dir, { recursive: true });
})();
