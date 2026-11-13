// A crypto call whose callback the checker sees only as a checked-dynamic
// value still keeps the program alive until the callback runs: the dynamic
// callback entries run on the crypto defer queue, which holds the event
// loop open.
import * as crypto from "node:crypto";

const hex = (value: any): string => Buffer.from(value).toString("hex");

// The error a successful job passes: Node passes null, except randomInt's
// undefined.
const errName = (err: any): string =>
  err === null ? "null" : err === undefined ? "undefined" : String(err.code ?? err.name);

// Starts one operation with a callback no declaration types, and waits for
// it.
function run(
  label: string,
  start: (callback: any) => void,
  show: (value: any) => string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const callback: any = (err: any, value: any) => {
      console.log(label, errName(err), show(value));
      resolve();
    };
    start(callback);
  });
}

await run("randomBytes", (cb) => crypto.randomBytes(4, cb), (value) => `${value.length} bytes`);
await run("randomInt", (cb) => crypto.randomInt(1, cb), String);
await run("randomInt range", (cb) => crypto.randomInt(0, 1, cb), String);
await run("pbkdf2", (cb) => crypto.pbkdf2("p", "s", 1, 8, "sha256", cb), hex);
await run("hkdf", (cb) => crypto.hkdf("sha256", "k", "s", "i", 8, cb), hex);
await run("scrypt", (cb) => crypto.scrypt("p", "s", 8, cb), hex);
await run("scrypt options", (cb) => crypto.scrypt("p", "s", 8, { N: 16 }, cb), hex);
await run("randomFill", (cb) => crypto.randomFill(Buffer.alloc(4), cb), (value) => `${value.length} bytes`);
await run("generateKey", (cb) => crypto.generateKey("hmac", { length: 64 }, cb), (value) => value.type);
console.log("sync done");
