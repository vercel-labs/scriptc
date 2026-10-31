// TextDecoder and TextEncoder as Node prints them: Object.prototype.toString
// answers their Symbol.toStringTag, util.inspect prints a decoder's encoding
// and flags (with util.inspect's default options) and an encoder's encoding,
// and both print [TextDecoder] and [TextEncoder] past the depth limit.
import * as util from "node:util";

const decoder = new TextDecoder("utf-16le", { fatal: true });
const encoder = new TextEncoder();
const options: { fatal?: boolean; ignoreBOM?: boolean } = { ignoreBOM: true };
const configured = new TextDecoder("latin1", options);
const none = new TextDecoder(undefined, null as never);

console.log(Object.prototype.toString.call(decoder), Object.prototype.toString.call(encoder));
console.log(String(decoder), `${encoder}`);
console.log(configured.encoding, configured.fatal, configured.ignoreBOM, none.encoding, none.fatal);
console.log(util.inspect(decoder));
console.log(util.inspect(configured));
console.log(util.inspect(encoder));
console.log(util.inspect([decoder, encoder]));
console.log(util.inspect({ a: { b: { c: decoder, d: encoder } } }));
console.log(util.inspect(decoder, { depth: -1 }), util.inspect(encoder, { depth: -1 }));
console.log(util.inspect(configured, { showHidden: false }));
console.log(util.inspect({ a: { b: { c: decoder, d: encoder } } }, { customInspect: false }));
console.log(JSON.stringify(util.inspect({ decoder, encoder }, { colors: true })));
console.log(JSON.stringify(util.inspect({ decoder, encoder }, { colors: true, depth: 0 })));
console.log(util.inspect({ x: encoder, y: decoder }, { compact: false }));
console.log(util.format("%O %s", decoder, encoder));
console.log(decoder, [encoder]);

const streamOptions: { stream?: boolean } = { stream: true };
const streaming = new TextDecoder();
console.log(JSON.stringify([streaming.decode(new Uint8Array([0xe2, 0x82]), streamOptions), streaming.decode(new Uint8Array([0xac]))]));
const view: Uint16Array | DataView = new Uint16Array([0x6968]);
console.log(new TextDecoder().decode(view), new TextDecoder("utf-16le").decode(view));
