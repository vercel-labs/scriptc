import { Writable } from "node:stream";

// Node passes write and end callbacks an error argument (null on success).
// Both error-first forms (`(error?: Error | null)`) and the plain `() => void`
// callbacks are supported; an end callback whose parameter is neither has no
// lowering.
const sink = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
sink.end((note?: string) => console.log("ended", note));
