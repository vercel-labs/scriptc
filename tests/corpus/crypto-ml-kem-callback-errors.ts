// crypto.encapsulate/decapsulate failures in their callback forms: the call
// answers undefined and the callback receives the operation error alone in a
// later macrotask, while the key-shape checks still throw synchronously.
// @normalize-pid
import { decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const kp = generateKeyPairSync("ml-kem-768");
const ed = generateKeyPairSync("ed25519");
const initial = encapsulate(kp.publicKey);
const ct = initial.ciphertext;

// The result parameter is read as a value of any type: the failure call
// passes the error alone, so it is undefined there (Node's own omission).
type Failure = Error & { code?: string };

const report = (label: string, error: Error | null, value: unknown): void => {
  const typed = error as Failure | null;
  console.log(label, typed === null ? "null" : `${typed.name} ${typed.code ?? "no-code"} | ${typed.message}`,
    value === undefined ? "no value" : typeof value);
};

const refused = encapsulate(ed.publicKey, (error: Error | null, value?: unknown) => {
  report("refused key", error, value);
  const short = decapsulate(kp.privateKey, Buffer.alloc(4), (nextError: Error | null, next?: unknown) => {
    report("short ciphertext", nextError, next);
    const text = decapsulate(kp.privateKey, "abc" as never, (textError: Error | null, textValue?: unknown) => {
      report("string ciphertext", textError, textValue);
      decapsulate(kp.privateKey, ct, (lastError: Error | null, lastValue?: unknown) => {
        report("valid ciphertext", lastError, lastValue);
      });
    });
    console.log("string call returned", text === undefined);
  });
  console.log("short call returned", short === undefined);
});
console.log("refused call returned", refused === undefined);

setTimeout(() => console.log("end"), 50);
