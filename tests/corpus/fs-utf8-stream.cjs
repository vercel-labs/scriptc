// fs.Utf8Stream: Node's buffered file writer. Its listeners are registered
// before the ready callback runs, so the write/flush/end chain reports the
// same event set Node does.
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function run() {
  const dir = fs.mkdtempSync(join(tmpdir(), "scr-utf8-stream-"));
  const file = join(dir, "out.log");
  const events = [];
  const s = new fs.Utf8Stream({ dest: file, mkdir: true });
  s.on("write", () => events.push("write"));
  s.on("finish", () => events.push("finish"));
  s.on("close", () => {
    events.push("close");
    console.log(
      "events",
      ["ready", "write", "finish", "close"]
        .map((n) => `${n}=${events.filter((e) => e === n).length > 0 ? 1 : 0}`)
        .join(" "),
    );
    console.log("file", JSON.stringify(fs.readFileSync(file, "utf8")));
    const bfile = join(dir, "buf.log");
    const b = new fs.Utf8Stream({ dest: bfile, contentMode: "buffer", minLength: 4 });
    b.on("finish", () => {
      console.log("buffer file", JSON.stringify(fs.readFileSync(bfile, "utf8")));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    b.on("ready", () => {
      b.write(Buffer.from("ab"));
      b.write(Buffer.from("cd"));
      b.end();
    });
  });
  s.on("ready", () => {
    events.push("ready");
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
}
run();
