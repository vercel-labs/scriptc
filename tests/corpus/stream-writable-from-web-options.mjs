// Writable.fromWeb options: highWaterMark, objectMode, decodeStrings and an
// AbortSignal each take effect on the native Writable. JavaScript keeps the
// web WritableStream untyped, so a decodeStrings: false write reaches its
// sink as the string the program wrote.
import { Writable } from "node:stream";

const log = [];

const chunks = [];
const web = new WritableStream({
  write(chunk) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    chunks.push(`${typeof chunk}:${text}`);
  },
});
const decoded = Writable.fromWeb(web, { highWaterMark: 2, decodeStrings: false });
log.push(`hwm ${decoded.writableHighWaterMark} objectMode ${decoded.writableObjectMode}`);
await new Promise((resolve) => decoded.write("ab", () => resolve()));
log.push(`chunks ${chunks.join("|")}`);

const objectMode = Writable.fromWeb(new WritableStream({ write() {} }), { objectMode: true });
log.push(`objectMode hwm ${objectMode.writableHighWaterMark} ${objectMode.writableObjectMode}`);

const controller = new AbortController();
const signalled = Writable.fromWeb(new WritableStream({ write() {} }), {
  signal: controller.signal,
});
const aborted = new Promise((resolve) =>
  signalled.on("error", (error) => resolve(`${error.name} ${error.code}`)),
);
controller.abort(new Error("stop"));
log.push(`abort ${await aborted} destroyed ${signalled.destroyed}`);

const preset = new AbortController();
preset.abort();
const already = Writable.fromWeb(new WritableStream({ write() {} }), { signal: preset.signal });
const presetError = new Promise((resolve) =>
  already.on("error", (error) => resolve(`${error.name} ${error.code}`)),
);
log.push(`preset ${await presetError} destroyed ${already.destroyed}`);

for (const line of log) console.log(line);
