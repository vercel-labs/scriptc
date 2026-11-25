// An untyped package function is compiled for the callback it is handed, so
// the call inside it has the type of the slot the callback came from. The
// package wrote no type: a callback that only passed through that slot is
// checked against what the callback itself declares.
import { callBack, callEach } from "callback-caller";

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

const definition: { name: string; show: Show } = { name: "loose", show: loose };
const narrow: { name: string; show: Show } = { name: "partial", show: partial };

const payloads: [string, any][] = [
  ["matching", { diff: "d", path: "p" }],
  ["lacking a member", {}],
  ["wrong primitive", { diff: 1, path: "p" }],
  ["extra member", { diff: "d", path: "p", more: true }],
  ["undefined", undefined],
];
for (const [kind, payload] of payloads) {
  console.log(`${kind}: ${callBack(definition.show, payload)}`);
}
console.log(callEach(definition.show, payloads.map(([, payload]) => payload)));
// The callback's own declaration holds: the empty object is a record of
// optional members.
const empty: any = {};
console.log(callBack(narrow.show, empty));
