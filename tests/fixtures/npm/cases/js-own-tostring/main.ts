// A JavaScript package (the TypeScript namespace downlevel zod uses) whose
// namespace object assigns its own `toString` returning string | undefined;
// Number.parseInt with one argument; and a `then` whose handler result the
// declared union types (zod's ParseStatus.mergeArray pattern).
import { check, direct, mergeLater, note, show, showRadix, wholePart } from "nsutil";

console.log(String(direct("a")), String(direct({ message: "b" })), String(direct(undefined)));
console.log(JSON.stringify(check(undefined)), JSON.stringify(check("m")));
console.log(wholePart(1.23), wholePart(0.35), wholePart(-4.5), wholePart(12));
const values: unknown[] = [12, "s", true, 1.5];
console.log(values.map((value) => show(value)).join(" "), showRadix(5, 2), note.length);
async function main(): Promise<void> {
  console.log(JSON.stringify(await mergeLater([Promise.resolve(1), Promise.resolve("two")], { ok: true })));
  console.log(JSON.stringify(await mergeLater([Promise.resolve(3), Promise.resolve("four")], { ok: false })));
}
void main();
