// TextDecoder.decode(undefined) decodes no bytes, as decode() does: it
// returns "" and, after streamed input, flushes the pending bytes.
const decoder = new TextDecoder();
const encoded = new TextEncoder().encode("bytes");
const inputs = new Map<string, Uint8Array | undefined>([
  ["present", encoded],
  ["absent", undefined],
]);

console.log(JSON.stringify(decoder.decode(undefined)));
console.log(JSON.stringify(decoder.decode(inputs.get("present"))), JSON.stringify(decoder.decode(inputs.get("absent"))));
console.log(JSON.stringify(decoder.decode(inputs.get("absent")!)), JSON.stringify(decoder.decode(inputs.get("missing")!)));
console.log(JSON.stringify(new TextDecoder("utf-8").decode(undefined)));
console.log(JSON.stringify(new TextDecoder("utf-8").decode(inputs.get("absent"))));

let calls = 0;
function nothing(): undefined {
  calls++;
  return undefined;
}
console.log(JSON.stringify(decoder.decode(nothing())), calls);

interface Chunk {
  done: boolean;
  value?: Uint8Array;
}
const chunks: Chunk[] = [{ done: false, value: new Uint8Array([0xe2, 0x82]) }, { done: true }];
const streaming = new TextDecoder();
let text = "";
for (const chunk of chunks) text += streaming.decode(chunk.value, { stream: !chunk.done });
console.log(JSON.stringify(text), text.length);

// Other typed arrays decode their bytes, with or without the assertion.
const wide = new Map<string, Uint16Array | undefined>([["present", new Uint16Array([0x6968])]]);
const asserted = wide.get("present")!;
console.log(JSON.stringify(decoder.decode(asserted)), JSON.stringify(decoder.decode(wide.get("present")!)));
console.log(JSON.stringify(decoder.decode(wide.get("present"))), JSON.stringify(decoder.decode(wide.get("absent"))));
console.log(JSON.stringify(new TextDecoder("utf-8").decode(wide.get("absent")!)));
