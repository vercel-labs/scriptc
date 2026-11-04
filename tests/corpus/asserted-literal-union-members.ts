/* An object literal carrying an asserted type whose union-valued member
 * holds an arm the asserted target excludes. The assertion is what admits
 * the member (`Source` is not assignable to `Slot`; `Payload` is not
 * assignable to `Target` because `Content` keeps an arm `WireContent` does
 * not), and a conforming value converts. Node erases the assertion, so the
 * output is the same value. */
type A = { kind: "a"; a: number };
type B = { kind: "b"; b: number };
type Source = A | B;
type Slot = A | string;
type Claim = { slot: Slot };

function claimed(message: Claim, source: Source): Claim {
  return { ...message, slot: source } as Claim;
}

function parenthesized(message: Claim, source: Source): Claim {
  return ({ ...message, slot: source }) as Claim;
}

type ArgText = { type: "text"; text: string };
type ArgImage = { type: "image"; data: string };
type ArgTool = { type: "tool"; id: string; arguments: unknown };
type Content = ArgText | ArgImage | ArgTool;
type WireText = { type: "text"; text: string };
type WireImage = { type: "image"; data: string };
type WireContent = WireText | WireImage;
type Payload = { body: Content | string };
type Target = { body: WireContent | string };
type Wire = { payload: Target | number };

function nested(payload: Payload | number): Wire {
  return { payload } as Wire;
}

const a: A = { kind: "a", a: 1 };
const text: ArgText = { type: "text", text: "hello" };
const image: ArgImage = { type: "image", data: "AAAA" };

console.log(JSON.stringify(claimed({ slot: "x" }, a)));
console.log(JSON.stringify(parenthesized({ slot: "y" }, a)));
console.log(JSON.stringify(nested({ body: text })));
console.log(JSON.stringify(nested({ body: image })));
console.log(JSON.stringify(nested({ body: "plain" })));
console.log(JSON.stringify(nested(7)));
