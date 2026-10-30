// A written type predicate usually names FEWER members than the receiver's
// element (`(b): b is { type: "text"; text: string }` over a block that
// also carries `textSignature`): the predicate's record is no arm of the
// element union, so each kept element converts to it by its own arm, tag
// by tag. An arm the predicate's record cannot be read from throws the
// checked TypeError, because a predicate that returned true for it lied.
type Block =
  | { type: "image"; data: string; mimeType: string }
  | { type: "text"; text: string; textSignature?: string };

const blocks: Block[] = [
  { type: "text", text: "first" },
  { type: "image", data: "AAAA", mimeType: "image/png" },
  { type: "text", text: "second", textSignature: "sig" },
];

function texts(list: Block[]): { type: "text"; text: string }[] {
  return list.filter((b): b is { type: "text"; text: string } => b.type === "text");
}
console.log("texts", texts(blocks).map((t) => `${t.type}:${t.text}`).join(","));

// The same narrowing through a guard function passed as a value.
function isText(b: Block): b is { type: "text"; text: string } {
  return b.type === "text";
}
console.log("guarded", blocks.filter(isText).length);

// Every arm converts when the predicate names members all of them carry:
// each kept element is read field by field into the predicate's record.
interface A {
  tag: "a";
  n: number;
}
interface B {
  tag: "b";
  n: number;
}
function numbers(list: (A | B)[]): { tag: "a" | "b"; n: number }[] {
  return list.filter((v): v is { tag: "a" | "b"; n: number } => v.n > 0);
}
console.log(
  "numbers",
  numbers([
    { tag: "a", n: 1 },
    { tag: "b", n: 0 },
    { tag: "a", n: 3 },
  ])
    .map((v) => `${v.tag}${v.n}`)
    .join(","),
);
