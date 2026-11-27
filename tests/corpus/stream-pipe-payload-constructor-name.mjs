// A stream subclass with a long name, piped to a destination whose untyped
// pipe listener keeps the source: the kept value names its class.
import { Readable, Writable } from "node:stream";

class ThisIsAVeryLongStreamSubclassNameForTheTypeKeyOverflowCheck12345 extends Readable {
  _read() {
    this.push(null);
  }
}

const kept = [];
const destination = new Writable({
  write(chunk, encoding, callback) {
    callback();
  },
});
/** @param {any} target */
function listen(target) {
  target.on("pipe", (source) => {
    kept.push(source);
  });
}
listen(destination);
const source = new ThisIsAVeryLongStreamSubclassNameForTheTypeKeyOverflowCheck12345();
source.pipe(destination);
await new Promise((resolve) => setTimeout(resolve, 100));
console.log("kept", kept.length, "name", kept.length > 0 ? kept[0].constructor.name.length : 0);
console.log("readable", kept.length > 0 && typeof kept[0].readableHighWaterMark === "number");
