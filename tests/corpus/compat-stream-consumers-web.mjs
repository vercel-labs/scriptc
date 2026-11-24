// stream/consumers over a web ReadableStream: Node's consumers iterate
// their argument, so a web stream's chunks reach text(), bytes(),
// arrayBuffer() and blob() the way a Node readable's do, and so does a
// constructor-function Node stream; a locked web stream rejects the
// returned promise with its state error. Every call goes through an
// untyped parameter, the argument shape Node accepts for any async
// iterable.
import { Readable } from "node:stream";
import { arrayBuffer, blob, bytes, text } from "node:stream/consumers";
import { inherits } from "node:util";

const web = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const failing = (reason) =>
  new ReadableStream({
    start(controller) {
      controller.error(reason);
    },
  });

const collectBytes = (source) => bytes(source);
const collectText = (source) => text(source);
const collectArrayBuffer = (source) => arrayBuffer(source);
const collectBlob = (source) => blob(source);

const decoder = new TextDecoder();
const strings = await collectBytes(web(["ab", "cd"]));
console.log("strings", strings.constructor === Uint8Array, decoder.decode(strings));
const views = await collectBytes(web([new Uint8Array([1, 2]), new Uint8Array([3])]));
console.log("views", Array.from(views).join(","));
const utf8 = await collectBytes(web(["é", "x"]));
console.log("utf8", Buffer.from(utf8).toString("hex"));
console.log("text", await collectText(web(["hello ", "world"])));
console.log("mixed", await collectText(web(["a", new Uint8Array([98])])));
console.log("empty", (await collectBytes(web([]))).length);
const buffer = await collectArrayBuffer(web([new Uint8Array([65, 66])]));
console.log("arrayBuffer", buffer.byteLength, decoder.decode(new Uint8Array(buffer)));
const binary = await collectBlob(web(["hello ", "world"]));
console.log("blob", binary.size, JSON.stringify(binary.type), await binary.text());
const emptyBlob = await collectBlob(web([]));
console.log("empty blob", emptyBlob.size, JSON.stringify(emptyBlob.type));

// The stream's own error rejects the consumer with that same error.
const failure = new Error("web stream failed");
try {
  await collectText(failing(failure));
  console.log("error resolved");
} catch (error) {
  console.log("error rejected", error === failure, error.message);
}

// A constructor-function stream (Readable.call in a plain function) reads
// as a Node readable's does, and a locked web stream rejects the returned
// promise with its state error instead of the call throwing.
function Source() {
  Readable.call(this);
  this.sent = false;
}
inherits(Source, Readable);
Source.prototype._read = function () {
  if (this.sent) return;
  this.sent = true;
  this.push("constructor");
  this.push(null);
};
console.log("constructor", await collectText(new Source()));
const locked = web(["a"]);
locked.getReader();
const pending = collectBytes(locked);
console.log("locked promise", pending instanceof Promise);
await pending.then(
  (value) => console.log("locked resolved", value.length),
  (error) => console.log("locked rejected", error.name, error.message),
);
console.log("locked after");
