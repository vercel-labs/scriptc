// The TypeScript twin of compat-error-properties.mjs: the properties Node
// documents on its errors, from a typed source. code on system and Node
// errors, the AssertionError class and its fields, and a SystemError's
// message. A SystemError's info record and the address and port of a
// failed connection have no declared spelling, so this twin leaves them
// to the JavaScript program.
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";

try {
  fs.readFileSync("/definitely/not/here");
} catch (thrown) {
  const error = thrown as NodeJS.ErrnoException;
  console.log(error.code, (error.errno ?? 0) < 0, error.syscall, error.path);
}
try {
  new URL("nope");
} catch (thrown) {
  const error = thrown as NodeJS.ErrnoException;
  console.log(error.code, error.name);
}

try {
  assert.strictEqual(1, 2);
} catch (error) {
  if (error instanceof assert.AssertionError)
    console.log(true, error.name, error.code, error.actual, error.expected, error.operator, error.generatedMessage);
}
const built = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
console.log(built.message.split("\n")[0], built.code, built instanceof Error);

try {
  os.setPriority(999999, 0);
} catch (thrown) {
  const error = thrown as NodeJS.ErrnoException;
  console.log(error.name, error.code, error.syscall);
  console.log(error.message);
}
