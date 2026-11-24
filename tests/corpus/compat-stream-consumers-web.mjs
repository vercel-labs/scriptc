// stream/consumers over a web ReadableStream: Node's consumers iterate
// their argument, so a web stream's chunks reach text(), bytes(),
// arrayBuffer() and blob() the way a Node readable's do. Every call goes
// through an untyped parameter, the argument shape Node accepts for any
// async iterable.
import { arrayBuffer, blob, bytes, text } from "node:stream/consumers";

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
