// A 'pipe' listener attached through an untyped value is handed the source
// stream itself: a listener that keeps the value reads the same stream on a
// later pipe of that source, and the stream's members stay readable.
import { Readable, Writable } from "node:stream";

const kept = [];
/** @param {any} dst */
function listen(dst) {
  dst.on("pipe", (source) => {
    kept.push(source);
  });
}

const src = new Readable({
  read() {
    this.push(null);
  },
});
const dst = new Writable({
  write(chunk, encoding, callback) {
    callback();
  },
});
listen(dst);
src.pipe(dst);
src.unpipe(dst);
src.pipe(dst);
console.log("pipes", kept.length, kept[0] === kept[1]);
console.log("member", typeof kept[0].readableHighWaterMark);
