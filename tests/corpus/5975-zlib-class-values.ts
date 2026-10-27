// The zlib stream classes as values: const aliases construct, instanceof
// tests each class against stream, EventEmitter and plain operands, and
// typeof, .name and === answer as in Node.
import * as zlib from "node:zlib";
import { Gunzip, Unzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { EventEmitter } from "node:events";

function makeLate() {
  return new Late();
}

const Gz = zlib.Gzip;
const Gun = Gunzip;
const Again = Gz;
const Late = zlib.Inflate;

const gz = new Gz();
console.log("new alias", gz instanceof zlib.Gzip, gz instanceof Gz, gz instanceof Again);
console.log("other classes", gz instanceof Gun, gz instanceof Gunzip, gz instanceof zlib.Deflate);
console.log("factory", zlib.createGzip() instanceof Gz, zlib.createGunzip() instanceof Gz);
console.log("hoisted use", makeLate() instanceof zlib.Inflate, makeLate() instanceof Gun);

const asTransform: Transform = new zlib.DeflateRaw();
console.log("transform-typed", asTransform instanceof zlib.DeflateRaw, asTransform instanceof Gz);
const plain = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk);
  },
});
console.log("plain transform", plain instanceof Gz, plain instanceof Transform);
const readable = new Readable({ read() {} });
console.log("readable", readable instanceof zlib.Unzip);

const emitter: EventEmitter = zlib.createDeflate();
console.log("emitter-typed", emitter instanceof zlib.Deflate, emitter instanceof zlib.Inflate);
const bare = new EventEmitter();
console.log("bare emitter", bare instanceof zlib.Deflate);
const record = { kind: "gzip" };
console.log("object", record instanceof Gz);

console.log("typeof", typeof Gz, typeof zlib.Inflate, typeof Unzip);
console.log("name", Gz.name, Again.name, Gun.name, zlib.DeflateRaw.name, Unzip.name);
console.log("identity", Gz === zlib.Gzip, Again === Gz, Gz === Gun, Gz !== zlib.Gunzip);

const chunks: Buffer[] = [];
const roundTrip = new Again();
roundTrip.on("data", (chunk: Buffer) => chunks.push(chunk));
roundTrip.on("end", () => {
  console.log("round trip", zlib.gunzipSync(Buffer.concat(chunks)).toString());
});
roundTrip.end("class values");
