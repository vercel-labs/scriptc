// Readable.from's runtime encoding option is converted for its error, and an
// application conversion may remove the object's own last reference while it
// runs: the validation still reports the unknown encoding.
import { Readable } from "node:stream";

const opts = {
  encoding: {
    toString() {
      delete opts.encoding;
      return {};
    },
    valueOf() {
      return "utf8";
    },
  },
};
try {
  Readable.from(["a"], opts);
  console.log("no-throw");
} catch (e) {
  console.log(e.code, e.message);
}
