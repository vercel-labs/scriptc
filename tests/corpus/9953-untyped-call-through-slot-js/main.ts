// The same rule across JavaScript source: a function declared in an untyped
// module takes whatever it is given after it was stored in a typed slot,
// and an untyped module that is handed a slot's value and calls it makes no
// claim about the argument, so the function behind the slot is checked
// against its own declaration.
import { callBack, callWith, keep } from "./caller.mjs";
import { plain } from "./declared.mjs";

interface Payload {
  diff: string;
  path: string;
}
type Show = (payload: Payload) => string;

function loose(payload: any): string {
  return `loose ${JSON.stringify(payload)} diff=${String(payload?.diff)}`;
}
function partial(payload: { diff?: string; path?: string }): string {
  return `partial ${JSON.stringify(payload)} diff=${String(payload.diff)}`;
}

interface Definition {
  name: string;
  show: Show;
}
const fromJs: Definition = { name: "js", show: plain };
const fromTs: Definition = { name: "ts", show: loose };
const narrow: Definition = { name: "partial", show: partial };

const payloads: [string, any][] = [
  ["matching", { diff: "d", path: "p" }],
  ["lacking a member", {}],
  ["wrong primitive", { diff: 1, path: "p" }],
  ["extra member", { diff: "d", path: "p", more: true }],
  ["undefined", undefined],
];

for (const [kind, payload] of payloads) {
  // Declared in JavaScript, called at `any` and at a wider function type.
  const untyped: any = fromJs.show;
  const wide: (payload: any) => string = fromJs.show;
  console.log(`js function / any / ${kind}: ${untyped(payload)}`);
  console.log(`js function / wider function type / ${kind}: ${wide(payload)}`);
  // Called back by JavaScript.
  console.log(`js caller / js function / ${kind}: ${callBack(fromJs.show, payload)}`);
  console.log(`js caller / ts function / ${kind}: ${callBack(fromTs.show, payload)}`);
  console.log(`js caller, kept / ts function / ${kind}: ${callWith(keep(fromTs.show), payload)}`);
}
// The function's own declaration still holds: the empty object is a record
// of optional members.
console.log(`js caller / partial / lacking a member: ${callBack(narrow.show, {})}`);
console.log(`js caller / partial / matching: ${callBack(narrow.show, { diff: "d", path: "p" })}`);
console.log((fromJs.show as unknown) === (plain as unknown), keep(fromTs.show) === keep(fromTs.show));
