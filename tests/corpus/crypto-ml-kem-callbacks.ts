// crypto.encapsulate/decapsulate callback forms: validation happens up front,
// the callback runs from the deferred crypto queue with (null, result), and
// both the sync result and the refused key types answer Node's errors.
import { decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const kp = generateKeyPairSync("ml-kem-768");
const sync = encapsulate(kp.publicKey);
const attempt = (label: string, run: () => unknown): void => {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    const typed = error as Error & { code?: string };
    console.log(label, typed.name, typed.code, "|", typed.message);
  }
};
attempt("bad callback", () => encapsulate(kp.publicKey, 5 as never));
attempt("bad callback first", () => encapsulate("x" as never, 5 as never));
attempt("bad decapsulate callback", () => decapsulate(kp.privateKey, sync.ciphertext, 5 as never));
attempt("public decapsulate", () => decapsulate(kp.publicKey, sync.ciphertext));
attempt("short ciphertext", () => decapsulate(kp.privateKey, Buffer.alloc(4)));
const ed = generateKeyPairSync("ed25519");
attempt("ed25519 encapsulate", () => encapsulate(ed.publicKey));

let returned = false;
let shared = false;
encapsulate(kp.publicKey, (error, result) => {
  console.log("encapsulate callback", returned, error, result?.ciphertext.length);
  shared = decapsulate(kp.privateKey, result!.ciphertext).equals(result!.sharedKey);
});
returned = true;
let decapsulated = false;
decapsulate(kp.privateKey, sync.ciphertext, (error, value) => {
  console.log("decapsulate callback", error, value?.length, value?.equals(sync.sharedKey));
  decapsulated = true;
});
process.nextTick(() => console.log("tick"));
setTimeout(() => console.log("end", shared, decapsulated), 20);
console.log("returned");
