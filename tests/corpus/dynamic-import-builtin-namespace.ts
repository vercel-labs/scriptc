// A literal dynamic import of a builtin module yields that module's
// namespace: destructuring the awaited namespace binds the same members a
// named import does (`const { createHash } = await import("node:crypto")`,
// renames included), and a member read on the awaited namespace dispatches
// like `ns.member`. The await itself still evaluates where the declaration
// sits: the import's microtask hop lands before the code that follows it.
const order: string[] = [];
order.push("start");
void Promise.resolve().then(() => order.push("microtask"));

const { createHash, createHash: hash } = await import("node:crypto");
const { EOL, platform: plat } = await import("node:os");
const { win32 } = await import("node:path");
order.push("after-import");

console.log(createHash("sha256").update("x").digest("hex"), hash("sha256").update("x").digest("hex"));
console.log(typeof EOL, EOL === (await import("node:os")).EOL, typeof plat() === "string");
console.log(win32.join("a", "b"));
console.log((await import("node:path")).basename("/x/y.ts"));
console.log(order.join(","));

// The same binding shape inside an async function: the namespace resolves
// at the await, and the destructured member is a callable value.
async function inside(): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  return randomUUID();
}
const uuid = await inside();
console.log(uuid.length, uuid.split("-").length);

// Bare builtin specifiers spell the same module.
const bare = await import("crypto");
console.log(typeof bare.createHash);

// Node's namespace `default` is the module's CommonJS exports object.
const { default: cryptoDefault } = await import("node:crypto");
console.log(typeof cryptoDefault.createHash);

// The destructured form binds every module the same way, not just the two
// above: a class (`Buffer`), a plain function (`format`) and an assertion
// helper reached through the awaited namespace all behave like their named
// imports.
const { format } = await import("node:util");
const { strictEqual } = await import("node:assert");
const { Buffer } = await import("node:buffer");
const { join } = await import("node:path");
strictEqual(format("%s:%d", join("a", "b"), 3), "a/b:3");
console.log(Buffer.from("hi").toString("hex"), format("%o", { a: 1 }));

// A member call or read on the awaited namespace evaluates the await where
// the member is used, not merely the member it names: the import's
// microtask hop lands before the call's arguments and the next statement,
// including through a module-valued member (`path.posix`).
const seen: string[] = [];
void Promise.resolve().then(() => seen.push("call-microtask"));
const query = (await import("node:querystring")).stringify({ a: 1 });
seen.push("call");
console.log(query, seen.join(","));
void Promise.resolve().then(() => seen.push("chain-microtask"));
const nested = (await import("node:path")).posix.join("c", "d");
seen.push("chain");
console.log(nested, seen.join(","));
void Promise.resolve().then(() => seen.push("read-microtask"));
const sep: string = (await import("node:path")).sep;
seen.push("read");
console.log(sep, seen.join(","));
