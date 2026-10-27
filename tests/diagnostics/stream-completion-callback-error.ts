import { Writable } from "node:stream";

// Node passes write and end callbacks an error argument (null on success);
// the native callbacks receive none, so a callback that names it refuses.
const sink = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
sink.write("a", (err) => console.log("written", err));
sink.end((err?: Error | null) => console.log("ended", err));
