// Harness-only descriptor-error probes. The harness controls stdout's pipe
// state and, through a tiny native launcher, O_NONBLOCK and RLIMIT_FSIZE.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mode = process.argv.length > 2 ? process.argv[2] : "sigpipe";
if (mode === "sigpipe" || mode === "stream-sigpipe" || mode === "stream-then-sync-sigpipe") {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, 100);
}

if (mode === "stream-sigpipe") {
  // a write stream's writes run on the fs pool's threads
  const out = fs.createWriteStream("", { fd: 1 });
  out.on("error", (err: NodeJS.ErrnoException) => {
    console.error("stream caught:", err.name, err.code, err.message);
  });
  out.write("probe\n");
} else if (mode === "stream-then-sync-sigpipe") {
  // a pool thread writes first; the calling thread's writeSync after it
  // keeps its own guard
  const scratch = path.join(os.tmpdir(), `scr-write-then-sync-${process.pid}`);
  const file = fs.createWriteStream(scratch);
  file.end("pool\n", () => {
    fs.unlinkSync(scratch);
    try {
      fs.writeSync(1, "probe\n");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error("sync caught:", err.name, err.code);
    }
  });
} else if (mode === "stream-efbig") {
  const scratch = path.join(os.tmpdir(), `scr-write-stream-${process.pid}`);
  const out = fs.createWriteStream(scratch);
  out.on("error", (err: NodeJS.ErrnoException) => {
    console.error("stream caught:", err.name, err.code, err.message);
    fs.unlinkSync(scratch);
  });
  out.write(Buffer.alloc(512));
  out.write(Buffer.alloc(4096));
} else if (mode === "eagain") {
  const data = Buffer.alloc(65536);
  for (;;) {
    try {
      fs.writeSync(1, data, 0, data.length, null);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      console.error("caught:", err.name, err.code, err.message);
      break;
    }
  }
} else if (mode === "efbig") {
  const data = Buffer.alloc(4096);
  function probe(label: string, positioned: boolean): void {
    const scratch = path.join(os.tmpdir(), `scr-write-sync-${label}-${process.pid}`);
    const fd = fs.openSync(scratch, "w");
    try {
      const first = positioned
        ? fs.writeSync(fd, data, 0, data.length, 0)
        : fs.writeSync(fd, data, 0, data.length, null);
      console.error(`${label} first:`, first);
      try {
        if (positioned) fs.writeSync(fd, data, 0, data.length, 512);
        else fs.writeSync(fd, data, 0, data.length, null);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        console.error(`${label} caught:`, err.name, err.code, err.message);
      }
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(scratch);
    }
  }
  probe("current", false);
  probe("positioned", true);
} else {
  try {
    if (mode === "positioned") {
      console.error("write returned:", fs.writeSync(1, "probe\n", 0));
    } else {
      console.error("write returned:", fs.writeSync(1, "probe\n"));
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (mode === "positioned") {
      console.error("caught:", err.name, err.code, err.message);
    } else {
      console.error("caught:", err.name, err.code);
    }
  }
}
