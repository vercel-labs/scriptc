// crypto.encapsulate/decapsulate callback forms over raw RSA and DHKEM: the
// call answers undefined, the callback runs from the deferred crypto queue
// with (null, result), and a refused key type or an unusable ciphertext
// delivers the operation error to the callback instead of throwing.
import { decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const x = generateKeyPairSync("x25519");
const ed = generateKeyPairSync("ed25519");
const sync = encapsulate(x.publicKey);
const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));

const refused = encapsulate(ed.publicKey, (error: Error | null, value?: unknown) => {
  log("refused key", error === null ? "null" : error.message, value === undefined ? "no value" : typeof value);
  const short = decapsulate(rsa.privateKey, Buffer.alloc(4), (next: Error | null, nextValue?: unknown) => {
    log("short ciphertext", next === null ? "null" : next.message, nextValue === undefined ? "no value" : typeof nextValue);
    const valid = decapsulate(x.privateKey, sync.ciphertext, (last: Error | null, lastValue?: unknown) => {
      const shared = lastValue as Buffer;
      log("valid ciphertext", last === null ? "null" : last.message, shared.length, shared.equals(sync.sharedKey));
    });
    log("valid call returned", valid === undefined);
  });
  log("short call returned", short === undefined);
});
log("refused call returned", refused === undefined);

const enc = encapsulate(rsa.publicKey, (error: Error | null, value?: unknown) => {
  const result = value as { sharedKey: Buffer; ciphertext: Buffer };
  log("rsa callback", error === null ? "null" : error.message, result.ciphertext.length, result.sharedKey.length);
  const shared = decapsulate(rsa.privateKey, result.ciphertext);
  log("rsa callback roundtrip", shared.equals(result.sharedKey));
});
log("rsa call returned", enc === undefined);

setTimeout(() => log("end"), 50);
