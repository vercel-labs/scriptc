// assert.strictEqual and notStrictEqual with a union operand against a side that
// holds only primitives: the union crosses as a checked-dynamic value, and
// failures render Node's messages.
import assert from "node:assert";
import { parse } from "node:querystring";

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(label, "ok");
  } catch (e) {
    const err = e as { name: string; code?: string; message: string };
    console.log(label, err.name, err.code, JSON.stringify(err.message));
  }
}

const parsed = parse("a=1&b=2&b=3&c=");
attempt("string arm", () => assert.strictEqual(parsed.a, "1"));
attempt("array arm", () => assert.strictEqual(parsed.b, "2"));
attempt("missing", () => assert.strictEqual(parsed.z, undefined));
attempt("missing vs string", () => assert.strictEqual(parsed.z, "x"));
attempt("not equal", () => assert.notStrictEqual(parsed.b, "2"));
const maybe: string | null = Math.random() > 2 ? "x" : null;
attempt("nullable", () => assert.strictEqual(maybe, null));
attempt("nullable fail", () => assert.strictEqual(maybe, "y", "custom message"));
const n: number | string = Math.random() > 2 ? "0" : -0;
attempt("signed zero", () => assert.strictEqual(n, 0));
attempt("signed zero ok", () => assert.strictEqual(n, -0));
const list: string[] | number = Math.random() > 2 ? 1 : ["x", "y"];
attempt("list vs number", () => assert.strictEqual(list, 1));
attempt("list not number", () => assert.notStrictEqual(list, 1));
