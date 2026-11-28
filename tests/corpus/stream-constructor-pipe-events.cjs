// A stream made through a constructor the program holds as a checked-dynamic
// value (a factory's return) still runs its pipe/unpipe listeners: both
// receive the source stream, as Node's destination events do.
const { Readable, Writable } = require("node:stream");

function streamClasses() {
  return { Readable: Readable, Writable: Writable };
}
const classes = streamClasses();
const src = new classes.Readable({
  read() {
    this.push("x");
    this.push(null);
  },
});
const dst = new classes.Writable({
  write(chunk, encoding, callback) {
    callback();
  },
});
dst.on("pipe", (source) => console.log("pipe heard", typeof source));
dst.on("unpipe", (source) => console.log("unpipe heard", typeof source));
src.pipe(dst);
src.unpipe(dst);
setTimeout(() => console.log("done"), 10);
