// Writes and pushes of a chunk that is a string or null: a null write throws
// ERR_STREAM_NULL_VALUES, and a null push ends the readable.
const { Writable, Readable } = require("node:stream");
const written = [];
const sink = new Writable({
  write(chunk, _encoding, callback) {
    written.push(chunk.toString());
    callback();
  },
});
for (let i = 0; i < 3; i++) {
  const chunk = i === 1 ? null : `c${i}`;
  try {
    console.log("write", JSON.stringify(chunk), sink.write(chunk));
  } catch (error) {
    console.log("write threw", error.name, error.code, error.message);
  }
}
const r = new Readable({ read() {} });
for (let i = 0; i < 3; i++) r.push(i === 2 ? null : `r${i}`);
r.on("data", (d) => console.log("data", String(d)));
r.on("end", () => console.log("end"));
sink.end(() => console.log("written", JSON.stringify(written.join(""))));
