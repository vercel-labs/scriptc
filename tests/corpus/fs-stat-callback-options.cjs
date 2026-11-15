// The stat family's callback options: only fs.stat reads throwIfNoEntry,
// and only the literal false suppresses the throw — the completion is
// then (null, undefined) with two arguments. lstat and fstat ignore the
// option and keep reporting ENOENT, bigint answers BigIntStats, and a
// non-object options value falls back to the defaults.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stat-cb-"));
const present = path.join(dir, "a.txt");
const missing = path.join(dir, "nope");
fs.writeFileSync(present, "hello");

const steps = [
  (next) =>
    fs.stat(missing, { throwIfNoEntry: false }, (...args) => {
      console.log("stat false", args.length, args[0], args[1]);
      next();
    }),
  (next) =>
    fs.stat(missing, { throwIfNoEntry: 0 }, (...args) => {
      console.log("stat zero", args.length, args[0] && args[0].code, args[1]);
      next();
    }),
  (next) =>
    fs.stat(missing, { throwIfNoEntry: undefined }, (...args) => {
      console.log("stat undefined", args.length, args[0] && args[0].code, args[1]);
      next();
    }),
  (next) =>
    fs.stat(missing, { bigint: true, throwIfNoEntry: false }, (...args) => {
      console.log("stat bigint false", args.length, args[0], args[1]);
      next();
    }),
  (next) =>
    fs.stat(missing, (...args) => {
      console.log("stat default", args.length, args[0].code, args[0].syscall, args[1]);
      next();
    }),
  (next) => {
    try {
      fs.lstat(missing, { throwIfNoEntry: false }, (...args) => {
        console.log("lstat false", args.length, args[0] && args[0].code);
        next();
      });
    } catch (error) {
      console.log("lstat false threw", error.code);
      next();
    }
  },
  (next) =>
    fs.stat(present, { throwIfNoEntry: false }, (...args) => {
      const stats = args[1];
      console.log("stat present", args.length, args[0], stats.size, stats.isFile());
      next();
    }),
  (next) =>
    fs.stat(present, { bigint: true }, (...args) => {
      const stats = args[1];
      console.log("stat bigint", args.length, args[0], typeof stats.size, stats.isFile());
      next();
    }),
  (next) =>
    fs.stat(present, 5, (...args) => {
      console.log("stat number options", args.length, args[0], args[1].size);
      next();
    }),
  (next) => {
    const fd = fs.openSync(present, "r");
    fs.fstat(fd, { throwIfNoEntry: false }, (...args) => {
      console.log("fstat false", args.length, args[0], args[1].size);
      fs.fstat(fd, (...inner) => {
        console.log("fstat default", inner.length, inner[0], inner[1].size);
        fs.closeSync(fd);
        next();
      });
    });
  },
  (next) =>
    fs.stat(path.join(present, "below"), { throwIfNoEntry: false }, (...args) => {
      console.log("stat below a file", args.length, args[0], args[1]);
      next();
    }),
];

let index = 0;
function step() {
  if (index === steps.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  steps[index++](step);
}
step();
