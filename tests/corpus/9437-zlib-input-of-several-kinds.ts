// A zlib input whose static type is one of several byte-input kinds
// (`string | Buffer`, `string | Uint8Array`): the call reads the kind the
// value has.
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";

function squeeze(text: string | Buffer): number {
  return inflateSync(deflateSync(text)).length;
}
console.log(squeeze("nuts"), squeeze(Buffer.from("pins!")));

function roundTrip(data: string | Uint8Array): string {
  return gunzipSync(gzipSync(data)).toString("utf8");
}
console.log(roundTrip("bolts"), roundTrip(new Uint8Array([111, 97, 107])));

function either(data: string | Buffer | undefined): string {
  if (data === undefined) return "nothing";
  return gunzipSync(gzipSync(data)).toString("utf8");
}
console.log(either("fir"), either(Buffer.from("yew")), either(undefined));

function pack(text: string | undefined): number {
  return gunzipSync(gzipSync(text ?? "none")).length;
}
console.log(pack("crate"), pack(undefined));
