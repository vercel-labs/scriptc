// The properties Node documents on its errors: code on system and Node
// errors, the AssertionError class and its fields, a SystemError's info
// record and message, and the address and port of a failed connection.
import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

try {
  fs.readFileSync("/definitely/not/here");
} catch (error) {
  console.log(error.code, error.errno < 0, error.syscall, error.path);
}
try {
  new URL("nope");
} catch (error) {
  console.log(error.code, error.name);
}

try {
  assert.strictEqual(1, 2);
} catch (error) {
  console.log(error instanceof assert.AssertionError, error.name, error.code, error.actual, error.expected, error.operator, error.generatedMessage);
}
const built = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
console.log(built.message.split("\n")[0], built.code, built instanceof Error);

try {
  os.setPriority(999999, 0);
} catch (error) {
  console.log(error.name, error.code, error.info.code, error.info.syscall, typeof error.info.errno, error.errno === error.info.errno, error.syscall);
  console.log(error.message);
}

net.connect(1, "127.0.0.1").on("error", (error) => console.log(error.code, error.address, error.port, error.syscall, error.message));
