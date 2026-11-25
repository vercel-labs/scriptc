// node:stream/web's ReadableStreamTee(stream[, cloneForBranch2]): the two
// branches of the default tee, both under one import binding and under the
// module namespace, with the second branch reading a structuredClone of
// each chunk when cloneForBranch2 is truthy, and the argument errors Node
// raises from the call itself.
import { ReadableStream, ReadableStreamTee } from "node:stream/web";
import * as web from "node:stream/web";

// A Response body is a valid tee argument before the program has used any
// web stream class: the call installs the classes, and the body tag's
// alias to the readable class, itself.
const preinitBody = new Response("hello").body;
const preinitPair = ReadableStreamTee(preinitBody);
const preinitRead = async (reader) => {
  const { value, done } = await reader.read();
  return done ? "<done>" : new TextDecoder().decode(value);
};
console.log(
  "preinit",
  await preinitRead(preinitPair[0].getReader()),
  await preinitRead(preinitPair[1].getReader()),
);

const make = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const pair = ReadableStreamTee(make(["a", "b"]));
console.log(
  "pair",
  pair.length,
  pair[0] instanceof ReadableStream,
  pair[1] instanceof ReadableStream,
  pair[0] === pair[1],
  ReadableStreamTee.length,
);
const first = pair[0].getReader();
const second = pair[1].getReader();
console.log("chunks", (await first.read()).value, (await second.read()).value);
console.log("more", (await first.read()).value, (await second.read()).value);
console.log("done", (await first.read()).done, (await second.read()).done);

// Without the flag both branches read the same chunk; with it the second
// branch reads a clone.
const shared = { k: 1 };
const plainPair = web.ReadableStreamTee(make([shared]));
const plainFirst = (await plainPair[0].getReader().read()).value;
const plainSecond = (await plainPair[1].getReader().read()).value;
console.log("shared", plainFirst === plainSecond, plainFirst === shared, JSON.stringify(plainSecond));
const clonedPair = ReadableStreamTee(make([shared]), true);
const clonedFirst = (await clonedPair[0].getReader().read()).value;
const clonedSecond = (await clonedPair[1].getReader().read()).value;
console.log("cloned", clonedFirst === clonedSecond, clonedFirst === shared, JSON.stringify(clonedSecond));

// A view is cloned too, so the branches hold distinct views of distinct
// storage.
const views = ReadableStreamTee(make([new Uint8Array([1, 2])]), true);
const viewsFirst = (await views[0].getReader().read()).value;
const viewsSecond = (await views[1].getReader().read()).value;
console.log("views", viewsFirst === viewsSecond, viewsFirst[0], viewsSecond[1], viewsSecond.byteLength);

// Node's argument errors come from the call, not a returned promise.
try {
  ReadableStreamTee(1);
} catch (error) {
  console.log("bad", error.name, error.code, error.message);
}
const locked = make([]);
locked.getReader();
try {
  ReadableStreamTee(locked);
} catch (error) {
  console.log("locked", error.name, error.message);
}

// A fetch Response body is a web stream handle too: teeing it reads the
// body's content through the fetch stream's web view, with delayed and
// empty content, the cloned flag over its chunks, and Node's state error
// for a body that already has a reader.
const delayed = new ReadableStream({
  start(controller) {
    setTimeout(() => {
      controller.enqueue("late");
      controller.close();
    }, 10);
  },
});
const delayedPair = ReadableStreamTee(new Response(delayed).body);
console.log(
  "body-delayed",
  (await delayedPair[0].getReader().read()).value,
  (await delayedPair[1].getReader().read()).value,
);
const emptyBody = ReadableStreamTee(new Response(new ReadableStream({ start(c) { c.close(); } })).body);
console.log("body-empty", (await emptyBody[0].getReader().read()).done, (await emptyBody[1].getReader().read()).done);
const bodyChunks = new ReadableStream({ start(c) { c.enqueue({ n: 1 }); c.close(); } });
const bodyCloned = web.ReadableStreamTee(new Response(bodyChunks).body, true);
const bodyFirst = (await bodyCloned[0].getReader().read()).value;
const bodySecond = (await bodyCloned[1].getReader().read()).value;
console.log("body-cloned", bodyFirst === bodySecond, JSON.stringify(bodySecond));
const lockedBody = new Response(new ReadableStream({ start(c) { c.enqueue("x"); c.close(); } })).body;
lockedBody.getReader();
try {
  ReadableStreamTee(lockedBody);
} catch (error) {
  console.log("body-locked", error.name, error.message);
}
