// @requires-libnode
// A test of a Node island's value needs no native form of the value. Its
// truthiness, its `typeof` and its strict equality with a primitive are
// answered from the value the island handed out, also where the declared
// type has no native representation (a boolean or a thenable) or names a
// library object the island made (a number or a Date). Where the type has no
// native representation at all, an untyped slot takes the island's value too.
import { asked, epoch, last, moment, settled, verdict } from "probe-kit";

function kind(value: unknown): string {
  return typeof value;
}
function always(): boolean {
  return asked() >= 0;
}

for (let i = 0; i < 3; i++) {
  // Conditions, `!`, and operands of `&&` and `||` that are only tested.
  const lines: string[] = [];
  if (verdict(i)) lines.push("if");
  if (!verdict(i)) lines.push("not");
  lines.push(verdict(i) ? "then" : "else");
  if (verdict(i) && always()) lines.push("and");
  if (!always() || verdict(i)) lines.push("or");
  let turns = 0;
  while (verdict(i)) {
    turns++;
    if (turns > 1) break;
  }
  lines.push("turns " + turns);
  // Strict equality with a primitive, and `typeof`.
  lines.push(String(verdict(i) === true), String(verdict(i) !== true), String(false === verdict(i)));
  lines.push(String(verdict(i) === true || "pending"));
  lines.push(typeof verdict(i));
  if (typeof verdict(i) === "boolean") lines.push("flag");
  // An untyped slot.
  lines.push(kind(verdict(i)), JSON.stringify(verdict(i)));
  const held: unknown = verdict(i);
  lines.push(typeof held, kind(verdict(i) as unknown));
  console.log(i, lines.join(" "));
}

for (let i = 0; i < 3; i++) {
  const lines: string[] = [];
  if (moment(i)) lines.push("if");
  if (!moment(i)) lines.push("not");
  lines.push(moment(i) ? "then" : "else");
  if (moment(i) && always()) lines.push("and");
  lines.push(String(moment(i) === 5), String(moment(i) !== 0));
  if (typeof moment(i) === "number") lines.push("ticks");
  else lines.push("date");
  console.log(i, lines.join(" "));
}

// Members of an island object, and names the island exports.
console.log(
  !last.verdict,
  last.verdict === true,
  typeof last.verdict,
  !last.plain,
  last.plain === false,
  last.moment ? "set" : "unset",
  typeof last.moment === "number",
);
console.log(!settled, settled === true, typeof settled, kind(settled), epoch ? "set" : "unset", epoch === 0);
if (settled && last.verdict && !last.plain) console.log("all");
console.log("asked", asked());
