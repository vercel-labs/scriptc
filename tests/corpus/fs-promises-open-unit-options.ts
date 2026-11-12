// fs.promises.open(path, flags, mode) with flags or mode supplied as an
// expression whose static type is only undefined/void: Node's stringToFlags
// answers the read-only default and parseFileMode the 0o666 default, but the
// expressions still evaluate after the path, before the open. An expression
// that throws reaches the caller instead of the defaulted open running.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-open-unit-"));
const file = path.join(dir, "file.txt");
const created = path.join(dir, "created.txt");
fs.writeFileSync(file, "seed");

const order: string[] = [];
function noFlags(): undefined {
  order.push("flags");
  return undefined;
}
function noMode(): undefined {
  order.push("mode");
  return undefined;
}

const readOnly = await fsp.open(file, noFlags(), noMode());
console.log("defaulted", order.join(","), typeof readOnly.fd);
console.log("content", await readOnly.readFile("utf8"));
await readOnly.close();

function boom(): undefined {
  order.push("boom");
  throw new Error("flag boom");
}
try {
  await fsp.open(file, boom());
  console.log("throwing flags unexpected");
} catch (error) {
  console.log("throwing flags", (error as Error).message, order.join(","));
}

// A void-typed expression: `void` discards the value, not the evaluation.
order.length = 0;
function bump(): number {
  order.push("bump");
  return 1;
}
const viaVoid = await fsp.open(file, void bump());
console.log("void flags", order.join(","));
await viaVoid.close();

// An effectful flags expression with a unit-typed mode: the flags argument
// evaluates first, and the value it answers is the one the open uses.
order.length = 0;
function pickReadFlags(): string {
  order.push("flags value");
  return "r";
}
const mixed = await fsp.open(file, pickReadFlags(), noMode());
console.log("effectful flags", order.join(","), await mixed.readFile("utf8"));
await mixed.close();

// The flags value still reaches the open when the mode argument contributes
// only its effect: "wx" creates a missing file, where the defaulted "r" fails
// with ENOENT.
order.length = 0;
const fresh = path.join(dir, "fresh.txt");
function pickWriteFlags(): string {
  order.push("flags write");
  return "wx";
}
function createMode(): undefined {
  order.push("mode create");
  return undefined;
}
const creator = await fsp.open(fresh, pickWriteFlags(), createMode());
await creator.writeFile("new");
await creator.close();
console.log(
  "effectful flags create",
  order.join(","),
  JSON.stringify(fs.readFileSync(fresh, "utf8")),
);

// Numeric flags take the runtime-read path; the order is the same there.
order.length = 0;
function pickNumericFlags(): number {
  order.push("flags numeric");
  return 0;
}
const numeric = await fsp.open(file, pickNumericFlags(), noMode());
console.log("numeric flags", order.join(","), await numeric.readFile("utf8"));
await numeric.close();

// Mode alone still takes the flags default; the "w" flag opens for writing
// so the mode's 0o666 can be observed through the created file.
order.length = 0;
function modeOnly(): undefined {
  order.push("mode only");
  return undefined;
}
const writeMode = await fsp.open(created, "w", modeOnly());
console.log("mode defaulted", order.join(","));
await writeMode.writeFile("q");
await writeMode.close();
console.log("written", JSON.stringify(fs.readFileSync(created, "utf8")));

// Two unit-typed expressions evaluate in argument order.
order.length = 0;
await (await fsp.open(file, noFlags(), noMode())).close();
console.log("order", order.join(","));

fs.rmSync(dir, { recursive: true, force: true });
