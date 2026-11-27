// execFileSync with its options in a const object: the options resolve at
// compile time as if the literal sat at the call (encoding, capture, input),
// because nothing in the program writes the binding's properties. The child
// reads stdin from the input option and prints it back.
import { execFileSync } from "node:child_process";

const options = {
  encoding: "utf-8" as const,
  stdio: "pipe" as const,
  timeout: 15_000,
  input: "piped in",
};
const out = execFileSync("/bin/sh", ["-c", "cat; echo; echo done"], options);
console.log(JSON.stringify(out));
console.log(typeof out);
