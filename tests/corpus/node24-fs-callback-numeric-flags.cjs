// The callback fs forms take numeric open(2) flags too: Node's stringToFlags
// passes a number through validateInt32 and the binding opens with those bits,
// for open, readFile and writeFile alike. The creation mode keeps
// parseFileMode's 0o666 default when it is omitted, null or undefined.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "numflags-"));
const clean = (text) => text.split(dir).join("<dir>");
const bits = (name) => (fs.statSync(path.join(dir, name)).mode & 0o777).toString(8);
function t(label, run) {
  try {
    run();
    console.log(label, "accepted");
  } catch (error) {
    console.log(label, error.code, clean(error.message));
  }
}
const O = fs.constants;
const created = path.join(dir, "created.txt");

// fs.open's numeric flags run validateInt32, and the mode runs parseFileMode,
// at the call, before Node starts the request.
t("open fraction flags", () => fs.open(created, 1.5, () => {}));
t("open int32 overflow flags", () => fs.open(created, 2 ** 31, () => {}));
t("open boolean flags", () => fs.open(created, true, () => {}));
t("open negative mode", () => fs.open(created, O.O_WRONLY, -1, () => {}));
t("open bad octal mode", () => fs.open(created, O.O_WRONLY, "999", () => {}));
t("open boolean mode", () => fs.open(created, O.O_WRONLY, true, () => {}));

const steps = [
  (next) => {
    fs.open(created, O.O_WRONLY | O.O_CREAT | O.O_EXCL, 0o600, (error, fd) => {
      if (error) {
        console.log("open create", error.code);
      } else {
        fs.writeSync(fd, "abc");
        fs.closeSync(fd);
        console.log("open create", fs.readFileSync(created, "utf8"), bits("created.txt"));
      }
      next();
    });
  },
  (next) => {
    const flags = O.O_WRONLY | O.O_TRUNC;
    fs.open(created, flags, (error, fd) => {
      if (error) {
        console.log("open truncate", error.code);
      } else {
        fs.closeSync(fd);
        console.log("open truncate", fs.statSync(created).size);
      }
      next();
    });
  },
  (next) => {
    fs.open(path.join(dir, "null-mode.txt"), "w", null, (error, fd) => {
      if (error) {
        console.log("open null mode", error.code);
      } else {
        fs.closeSync(fd);
        console.log("open null mode", bits("null-mode.txt"));
      }
      next();
    });
  },
  (next) => {
    const flags = O.O_WRONLY | O.O_CREAT | O.O_EXCL;
    fs.open(path.join(dir, "string-mode.txt"), flags, "640", (error, fd) => {
      if (error) {
        console.log("open octal mode", error.code);
      } else {
        fs.closeSync(fd);
        console.log("open octal mode", bits("string-mode.txt"));
      }
      next();
    });
  },
  (next) => {
    fs.readFile(created, { flag: O.O_RDONLY }, (error, data) => {
      console.log("readFile numeric flag", error && error.code, data && data.length);
      next();
    });
  },
  (next) => {
    const flag = O.O_WRONLY | O.O_CREAT | O.O_TRUNC;
    fs.writeFile(path.join(dir, "written.txt"), "xy", { flag, mode: 0o600 }, (error) => {
      const name = "written.txt";
      console.log("writeFile numeric flag", error && error.code, fs.readFileSync(path.join(dir, name), "utf8"), bits(name));
      next();
    });
  },
  (next) => {
    const flag = O.O_WRONLY | O.O_APPEND | O.O_CREAT;
    fs.appendFile(created, "d", { flag }, (error) => {
      console.log("appendFile numeric flag", error && error.code, fs.readFileSync(created, "utf8"));
      next();
    });
  },
  (next) => {
    fs.open(path.join(dir, "missing-dir", "f.txt"), O.O_WRONLY | O.O_CREAT, (error) => {
      console.log("open missing parent", error && error.code, error && error.syscall);
      next();
    });
  },
];

let index = 0;
function next() {
  const step = steps[index++];
  if (step) step(next);
  else {
    console.log("leftovers", fs.readdirSync(dir).sort().join(","));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
next();
