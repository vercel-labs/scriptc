// A stream's async iteration and disposal: for-await drains a readable and
// leaves readableEnded/readableDidRead set, setEncoding answers
// readableEncoding, a destroyed readable reports readableAborted, and the
// async disposal of a readable and of a writable destroys them (the
// writable reporting writableAborted).
import { Readable, Writable } from "node:stream";

const consumed = Readable.from(["a", "b"]);
const chunks = [];
for await (const chunk of consumed) chunks.push(String(chunk));
console.log(
  "for-await",
  chunks.join(","),
  consumed.readableEnded,
  consumed.readableAborted,
  consumed.readableDidRead,
);

const encoded = Readable.from(["c"]);
encoded.setEncoding("utf8");
console.log("encoding", encoded.readableEncoding, typeof encoded.readableEncoding);

const aborted = new Readable({ read() {} });
aborted.on("error", () => {});
aborted.destroy(new Error("x"));
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("aborted", aborted.destroyed, aborted.readableAborted);

const disposedReadable = Readable.from(["d"]);
await disposedReadable[Symbol.asyncDispose]();
console.log("dispose-readable", disposedReadable.destroyed);

const disposedWritable = new Writable({
  write(chunk, encoding, callback) {
    callback();
  },
});
await disposedWritable[Symbol.asyncDispose]();
console.log("dispose-writable", disposedWritable.destroyed, disposedWritable.writableAborted);
