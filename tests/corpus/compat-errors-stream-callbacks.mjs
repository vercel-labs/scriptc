// ERR_MULTIPLE_CALLBACK: a stream implementation calls the callback its
// transform (or construct/flush/destroy) was given more than once. The
// stream emits the error instead of accepting the second answer.
import { Transform, Writable } from "node:stream";

const describe = (error) =>
  `${error instanceof Error ? (error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : "Error") : typeof error} | ${error.name} | ${error.code} | ${JSON.stringify(error.message)}`;

await new Promise((resolve) => {
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      callback(null, chunk);
      callback(new Error("second answer"));
    },
  });
  stream.on("data", (chunk) => console.log("data", String(chunk)));
  stream.on("error", (error) => {
    console.log("transform", describe(error));
    resolve(undefined);
  });
  stream.end("x");
});

// The write callback of a Writable's implementation takes one answer too.
await new Promise((resolve) => {
  const stream = new Writable({
    write(chunk, encoding, callback) {
      callback();
      callback(new Error("twice"));
    },
  });
  stream.on("finish", () => console.log("finish"));
  stream.on("error", (error) => {
    console.log("writable", describe(error));
    resolve(undefined);
  });
  stream.end("x");
  // The second callback reaches the stream after the write completed.
  setTimeout(() => resolve(undefined), 50);
});

