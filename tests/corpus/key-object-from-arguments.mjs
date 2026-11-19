// KeyObject.from's argument count and non-CryptoKey values, called without
// the optional-argument cast a TypeScript program needs.
import { KeyObject } from "node:crypto";
for (const [label, run] of [
  ["no argument", () => KeyObject.from()],
  ["undefined", () => KeyObject.from(undefined)],
  ["string", () => KeyObject.from("key")],
]) {
  let result;
  try {
    run();
    result = "resolved";
  } catch (error) {
    result = `${error.name} ${error.message}`;
  }
  console.log(label, result);
}
