// util.TextDecoder and util.TextEncoder: labels, fatal and ignoreBOM,
// streaming across chunk boundaries, every input kind decode accepts, and
// encodeInto's partial writes. Node's util exports are the WHATWG classes.
import { TextDecoder, TextEncoder } from "node:util";

const show = (label: string, run: () => unknown): void => {
  try {
    console.log(label, run());
  } catch (e: any) {
    console.log(label, e.name, e.code, e.message);
  }
};

for (const label of ["utf-8", " utf8 ", "utf-16le", "utf-16be", "latin1", "ascii", "base64", "base64url", "hex", "windows-1252"]) {
  show("label " + JSON.stringify(label), () => {
    const decoder = new TextDecoder(label);
    return decoder.encoding + "|" + decoder.fatal + "|" + decoder.ignoreBOM;
  });
}
show("bad label", () => new TextDecoder("nope").encoding);
show("empty label", () => new TextDecoder("").encoding);

const plain = new TextDecoder();
console.log(plain.encoding, plain.fatal, plain.ignoreBOM);
console.log(JSON.stringify(plain.decode()));
console.log(JSON.stringify(plain.decode(new Uint8Array([0x68, 0xc3, 0xa9]))));
console.log(JSON.stringify(plain.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))));
console.log(JSON.stringify(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))));
console.log(JSON.stringify(plain.decode(new Uint8Array([0x61, 0xe2, 0x82]), { stream: true })));
console.log(JSON.stringify(plain.decode(new Uint8Array([0xac, 0x21]))));
console.log(JSON.stringify(plain.decode(new Uint8Array([0xff, 0xfe]))));

const fatal = new TextDecoder("utf-8", { fatal: true });
show("fatal bytes", () => fatal.decode(new Uint8Array([0xff])));
show("fatal stream", () => fatal.decode(new Uint8Array([0xe2, 0x82]), { stream: true }));
console.log(JSON.stringify(fatal.decode(new Uint8Array([0xac]))));

console.log(JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x68, 0x00, 0x69, 0x00]))));
console.log(JSON.stringify(new TextDecoder("utf-16be").decode(new Uint8Array([0x00, 0x68, 0x00, 0x69]))));
console.log(JSON.stringify(new TextDecoder("latin1").decode(new Uint8Array([0xe9, 0xff]))));

// decode takes any ArrayBufferView, and a buffer's whole bytes.
const buffer = new Uint8Array([0x68, 0x69, 0x21]).buffer;
console.log(JSON.stringify(plain.decode(buffer)));
console.log(JSON.stringify(plain.decode(new DataView(buffer, 1))));
console.log(JSON.stringify(plain.decode(new Uint8Array([0x30, 0x68, 0x69, 0x30, 0x21, 0x30]), { stream: false })));

const encoder = new TextEncoder();
console.log(encoder.encoding);
console.log(JSON.stringify(Array.from(encoder.encode("hé"))));
console.log(JSON.stringify(Array.from(encoder.encode())));
console.log(JSON.stringify(Array.from(encoder.encode("\uD800"))));
console.log(JSON.stringify(Array.from(encoder.encode("\uDFFFx"))));

const small = new Uint8Array(3);
console.log(JSON.stringify(encoder.encodeInto("héllo", small)), JSON.stringify(Array.from(small)));
const exact = new Uint8Array(6);
console.log(JSON.stringify(encoder.encodeInto("héllo", exact)), JSON.stringify(Array.from(exact)));
const empty = new Uint8Array(0);
console.log(JSON.stringify(encoder.encodeInto("x", empty)));
show("bad dest", () => encoder.encodeInto("x", [] as any));
console.log(JSON.stringify(Array.from(encoder.encodeInto("abc", new Uint8Array(2)).read === 2 ? [1, 2] : [])));
