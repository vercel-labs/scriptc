// Reading a directory fails in read(2), on the descriptor: Node's EISDIR
// names no path, in the message or as a property, whichever call read it.
const fs = require("fs");
const os = require("os");

const dir = os.tmpdir();

function show(label, e) {
  console.log(
    label,
    e instanceof Error,
    e.name,
    e.code,
    e.errno === -os.constants.errno.EISDIR,
    e.syscall,
    e.path,
    JSON.stringify(e.message),
    Object.keys(e).join(","),
  );
}

try {
  fs.readFileSync(dir);
  console.log("readFileSync: no throw");
} catch (e) {
  show("readFileSync", e);
}
try {
  fs.readFileSync(dir, "utf8");
  console.log("readFileSync utf8: no throw");
} catch (e) {
  show("readFileSync utf8", e);
}
try {
  fs.readFileSync(dir, { encoding: "utf8" });
  console.log("readFileSync options: no throw");
} catch (e) {
  show("readFileSync options", e);
}

// A missing file still fails in open(2), with its path.
const missing = dir + "/definitely-not-here-8726";
try {
  fs.readFileSync(missing);
} catch (e) {
  console.log("missing", e.code, e.syscall, e.path === missing, Object.keys(e).join(","));
}

fs.readFile(dir, (first) => {
  show("readFile", first);
  fs.readFile(dir, "utf8", (second) => {
    show("readFile utf8", second);
    fs.promises.readFile(dir).then(
      () => console.log("promises.readFile: no rejection"),
      (third) => {
        show("promises.readFile", third);
        fs.promises.readFile(dir, "utf8").then(
          () => console.log("promises.readFile utf8: no rejection"),
          (fourth) => {
            show("promises.readFile utf8", fourth);
            const stream = fs.createReadStream(dir);
            stream.on("error", (fifth) => show("createReadStream", fifth));
            stream.on("data", () => console.log("createReadStream: data"));
          },
        );
      },
    );
  });
});
