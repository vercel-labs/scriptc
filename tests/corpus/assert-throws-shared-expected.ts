// assert.throws and assert.rejects with an expected object held in a
// variable compare each of its keys with the thrown error's, own or
// inherited: an error's name is on its prototype, so { name, message, code }
// matches errors the runtime throws as well as errors the program throws.
import assert from "node:assert";

const invalidUrl = { code: "ERR_INVALID_URL", name: "TypeError", message: "Invalid URL" };
const outOfRange = { code: "ERR_OUT_OF_RANGE", name: "RangeError" };
const thrownType = { name: "TypeError", message: "bad input" };
const wrongName = { name: "RangeError", message: "bad input" };

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "passed");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "failed", e.name, e.code);
  }
}

check("url", () => assert.throws(() => new URL("not a url"), invalidUrl));
check("buffer", () => assert.throws(() => Buffer.alloc(-1), outOfRange));
check("thrown", () =>
  assert.throws(() => {
    throw new TypeError("bad input");
  }, thrownType),
);
check("mismatch", () =>
  assert.throws(() => {
    throw new TypeError("bad input");
  }, wrongName),
);

async function main(): Promise<void> {
  await assert.rejects(Promise.reject(new TypeError("bad input")), thrownType);
  console.log("rejects passed");
  try {
    await assert.rejects(Promise.reject(new TypeError("bad input")), wrongName);
    console.log("rejects mismatch passed");
  } catch (error) {
    console.log("rejects mismatch failed", (error as NodeJS.ErrnoException).code);
  }
}

void main();
