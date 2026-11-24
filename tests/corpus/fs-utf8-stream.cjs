// fs.Utf8Stream: Node's buffered file writer. The program pins the event
// timing (ready and the write/finish/close chain arrive after the caller's
// own statements, in registration order for several listeners), the byte
// count 'write' reports, a synchronous stream that keeps writes buffered
// below minLength until end(), the descriptor the close releases (a supplied
// one, but never stdout), flush(cb), destroy(), the drop of a write past
// maxLength, reopen(), the octal-string mode, and the null-byte path.
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function run() {
  const dir = fs.mkdtempSync(join(tmpdir(), "scr-utf8-stream-"));

  // One file, the default mode: 'ready' is deferred, so the line printed
  // here comes first and both listeners still see the event.
  const file = join(dir, "out.log");
  const events = [];
  const s = new fs.Utf8Stream({ dest: file, mkdir: true });
  s.on("ready", () => {
    events.push("ready-1");
    console.log("props", s.append, s.contentMode, s.fsync, s.minLength, s.writing, s.file === file);
    try {
      s.write(Buffer.from("x"));
    } catch (err) {
      console.log("utf8 buffer", err.name, err.code);
    }
    s.write("hello\n");
    s.flushSync();
    s.end();
  });
  s.on("ready", () => events.push("ready-2"));
  console.log("registered");
  s.on("write", (n) => events.push("write:" + n));
  s.on("finish", () => events.push("finish"));
  s.on("close", () => {
    events.push("close");
    console.log("events", events.join(","));
    console.log("file", JSON.stringify(fs.readFileSync(file, "utf8")));
    syncStream(dir);
  });
}

// sync: true with a minLength keeps the write buffered until end(), which
// flushes it synchronously (the 'write' event fires at the call) and closes
// on the deferred completion.
function syncStream(dir) {
  const file = join(dir, "sync.log");
  const events = [];
  const s = new fs.Utf8Stream({ dest: file, sync: true, minLength: 8 });
  s.on("write", (n) => events.push("write:" + n));
  s.on("ready", () => {
    console.log("sync write", s.write("ab"), "size", fs.statSync(file).size, "writing", s.writing);
    s.end();
    console.log("sync after end size", fs.statSync(file).size);
  });
  s.on("close", () => {
    console.log("sync events", events.join(","), "size", fs.statSync(file).size);
    stdioStream(dir);
  });
}

// A stdio descriptor is never closed by the stream; a supplied one is.
function stdioStream(dir) {
  const out = new fs.Utf8Stream({ fd: 1, sync: true });
  out.on("ready", () => {
    console.log("stdio ready file", out.file, "fd", out.fd);
    out.end();
  });
  out.on("close", () => {
    console.log("stdio after close", descriptorState(1));
    suppliedFd(dir);
  });
}

function suppliedFd(dir) {
  const file = join(dir, "fd.log");
  const fd = fs.openSync(file, "w");
  const s = new fs.Utf8Stream({ fd, sync: true });
  s.on("ready", () => {
    s.write("fd data");
    s.end();
  });
  s.on("close", () => {
    console.log("supplied fd after close", descriptorState(fd));
    console.log("supplied fd file", JSON.stringify(fs.readFileSync(file, "utf8")));
    flushStream(dir);
  });
}

// flush(cb) writes the buffer and answers the callback on the drain, after
// the write completion.
function flushStream(dir) {
  const file = join(dir, "flush.log");
  const events = [];
  const s = new fs.Utf8Stream({ dest: file, minLength: 4 });
  s.on("write", (n) => events.push("write:" + n));
  s.on("ready", () => {
    // Past the open's own completion: a flush inside a 'ready' listener
    // would also be run by the open handler.
    setImmediate(() => {
      console.log("flush write", s.write("ab"), "size", fs.statSync(file).size);
      s.flush((err) => {
        events.push("flush-cb");
        console.log("flush cb", err, JSON.stringify(fs.readFileSync(file, "utf8")));
        s.end();
      });
    });
  });
  s.on("close", () => {
    console.log("flush events", events.join(","));
    destroyStream(dir);
  });
}

// destroy() drops the buffered bytes and closes: 'close' without 'finish'.
function destroyStream(dir) {
  const file = join(dir, "destroy.log");
  const events = [];
  const s = new fs.Utf8Stream({ dest: file, minLength: 100 });
  s.on("finish", () => events.push("finish"));
  s.on("ready", () => {
    console.log("destroy write", s.write("dropped"));
    s.destroy();
  });
  s.on("close", () => {
    events.push("close");
    console.log("destroy events", events.join(","), "size", fs.statSync(file).size);
    dropStream(dir);
  });
}

// A write past maxLength is refused at the call: 'drop' carries the value
// and write() reports the buffer against Node's high-water mark.
function dropStream(dir) {
  const file = join(dir, "drop.log");
  const s = new fs.Utf8Stream({ dest: file, maxLength: 4, minLength: 100, sync: true });
  s.on("drop", (data) => console.log("drop", JSON.stringify(data)));
  s.on("ready", () => {
    console.log("drop ret", s.write("abc"), s.write("def"));
    s.end();
  });
  s.on("close", () => {
    console.log("drop file", JSON.stringify(fs.readFileSync(file, "utf8")));
    reopenStream(dir);
  });
}

// reopen() moves the stream to a new path; the descriptor it held is
// released and the file property follows.
function reopenStream(dir) {
  const one = join(dir, "one.log");
  const two = join(dir, "two.log");
  const s = new fs.Utf8Stream({ dest: one, sync: true });
  let readies = 0;
  s.on("ready", () => {
    // The open after reopen() raises 'ready' again.
    if (readies++ !== 0) return;
    s.write("first");
    s.reopen(two);
    s.write("second");
    s.end();
  });
  s.on("close", () => {
    console.log(
      "reopen files",
      JSON.stringify(fs.readFileSync(one, "utf8")),
      JSON.stringify(fs.readFileSync(two, "utf8")),
      s.file === two,
    );
    modeAndPath(dir);
  });
}

function descriptorState(fd) {
  try {
    fs.fstatSync(fd);
    return "open";
  } catch (err) {
    return err.code;
  }
}

// parseFileMode reads an octal string, and a null byte in the path is
// Node's invalid-path TypeError before anything is created.
function modeAndPath(dir) {
  const file = join(dir, "mode.log");
  const s = new fs.Utf8Stream({ dest: file, mode: "0640", sync: true });
  s.on("ready", () => {
    console.log("mode", (fs.statSync(file).mode & 0o777).toString(8), "getter", s.mode);
    s.end();
  });
  s.on("close", () => {
    try {
      new fs.Utf8Stream({ dest: "\0" });
      console.log("nul accepted");
    } catch (err) {
      console.log("nul", err.name, err.code, err.message);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("done");
  });
}

run();
