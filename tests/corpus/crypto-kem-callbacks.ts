// crypto.encapsulate/decapsulate callback forms over raw RSA and DHKEM: the
// call answers undefined, the callback runs from the deferred crypto queue
// with (null, result), and a refused key type or an unusable ciphertext
// delivers the operation error to the callback instead of throwing.
//
// The refusal chain and the RSA-2048 chain below run on the thread pool at
// the same time, and their callbacks reach the queue in whatever order the
// host's pool completes them — Node included. The synchronous lines print as
// they happen; each chain's callback lines are recorded in the chain's own
// order and the two chains are reported in a fixed order once both have
// completed, so the comparison pins the values, not the pool's scheduling.
import { decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const x = generateKeyPairSync("x25519");
const ed = generateKeyPairSync("ed25519");
const sync = encapsulate(x.publicKey);
const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));

const refusedEvents: string[] = [];
const rsaEvents: string[] = [];
let remaining = 2;
const finish = () => {
  if (--remaining > 0) return;
  for (const line of [...refusedEvents, ...rsaEvents]) console.log(line);
  console.log("end");
};
const line = (...parts: unknown[]) => parts.map(String).join(" | ");

const refused = encapsulate(ed.publicKey, (error: Error | null, value?: unknown) => {
  refusedEvents.push(
    line("refused key", error === null ? "null" : error.message, value === undefined ? "no value" : typeof value),
  );
  const short = decapsulate(rsa.privateKey, Buffer.alloc(4), (next: Error | null, nextValue?: unknown) => {
    refusedEvents.push(
      line("short ciphertext", next === null ? "null" : next.message, nextValue === undefined ? "no value" : typeof nextValue),
    );
    const valid = decapsulate(x.privateKey, sync.ciphertext, (last: Error | null, lastValue?: unknown) => {
      const shared = lastValue as Buffer;
      refusedEvents.push(
        line("valid ciphertext", last === null ? "null" : last.message, shared.length, shared.equals(sync.sharedKey)),
      );
      finish();
    });
    refusedEvents.push(line("valid call returned", valid === undefined));
  });
  refusedEvents.push(line("short call returned", short === undefined));
});
log("refused call returned", refused === undefined);

const enc = encapsulate(rsa.publicKey, (error: Error | null, value?: unknown) => {
  const result = value as { sharedKey: Buffer; ciphertext: Buffer };
  rsaEvents.push(
    line("rsa callback", error === null ? "null" : error.message, result.ciphertext.length, result.sharedKey.length),
  );
  const shared = decapsulate(rsa.privateKey, result.ciphertext);
  rsaEvents.push(line("rsa callback roundtrip", shared.equals(result.sharedKey)));
  finish();
});
log("rsa call returned", enc === undefined);
