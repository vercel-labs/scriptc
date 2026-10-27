// pipeline() with an async function destination in JavaScript: the
// callback receives undefined and the destination's value on success.
import { pipeline, Readable } from "node:stream";

pipeline(
  Readable.from(["x", "y"]),
  async function (src) {
    const out = [];
    for await (const c of src) out.push(c);
    return out.join("-");
  },
  (err, value) => {
    console.log("callback", err, typeof err, value);
    pipeline(
      Readable.from(["z"]),
      async function (src) {
        for await (const c of src) void c;
      },
      (...args) => console.log("no value", args),
    );
  },
);
