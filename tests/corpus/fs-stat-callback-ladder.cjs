// The stat callbacks' argument ladders before the request starts: fs.stat
// normalizes its options first (getOptions: the encoding and signal checks)
// and then checks the callback, while lstat and fstat read options.bigint
// directly (a null options value fails on that read). Every throw below is
// synchronous; the successes answer from the completion queue.
'use strict';
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stat-ladder-"));
const file = path.join(dir, "f.txt");
const missing = path.join(dir, "nope");
fs.writeFileSync(file, "abc");

const show = (label, fn) => {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, "throw", e.name, e.code, JSON.stringify(e.message));
  }
};

show("stat bogus encoding", () => {
  fs.stat(file, { encoding: "bogus" }, () => {
    console.log("stat bogus encoding callback");
  });
});
show("stat bad signal", () => {
  fs.stat(file, { signal: 5 }, () => {
    console.log("stat bad signal callback");
  });
});
show("stat bogus encoding and null callback", () => {
  fs.stat(file, { encoding: "bogus" }, null);
});
show("stat null callback", () => {
  fs.stat(file, null, null);
});
show("lstat null options", () => {
  fs.lstat(file, null, () => {});
});
show("fstat null options", () => {
  const fd = fs.openSync(file, "r");
  try {
    fs.fstat(fd, null, () => {});
  } finally {
    fs.closeSync(fd);
  }
});
show("fstat string fd", () => {
  fs.fstat("x", { bigint: "yes" }, () => {});
});
show("fstat fractional fd", () => {
  fs.fstat(1.5, () => {});
});
show("fstat negative fd", () => {
  fs.fstat(-1, () => {});
});

// Success answers run one at a time: independent stats complete in any
// order (libuv's threadpool), so each call starts from the last callback.
const openFd = fs.openSync(file, "r");
const steps = [
  (next) =>
    fs.stat(file, 7, (err, stats) => {
      console.log("stat number options", err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.stat(file, "utf8", (err, stats) => {
      console.log("stat string options", err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.stat(file, (err, stats) => {
      console.log("stat function options", err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.lstat(file, { encoding: "bogus" }, (err, stats) => {
      console.log("lstat bogus encoding ignored", err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.stat(file, { bigint: "yes" }, (err, stats) => {
      console.log("stat bigint yes", err, typeof stats.size);
      next();
    }),
  (next) =>
    fs.fstat(openFd, { bigint: true, throwIfNoEntry: false }, (err, stats) => {
      console.log("fstat bigint true", err && err.code, typeof stats.size, stats.isFile());
      fs.closeSync(openFd);
      next();
    }),
  (next) => {
    const controller = new AbortController();
    controller.abort("because");
    const abortResult = fs.stat(file, { bigint: true, signal: controller.signal }, (err, stats) => {
      console.log("aborted", err.name, err.code, JSON.stringify(err.message), stats, err.cause);
      next();
    });
    console.log("aborted call answered", abortResult);
  },
];
const runStep = (at) => {
  if (at === steps.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  steps[at](() => runStep(at + 1));
};
runStep(0);
