// `left ?? right` where the right side's type is wider than the left's
// present value: an array of one record type defaulted to an array of a
// union that includes it, and the same for numbers and single records.
interface Text {
  type: "text";
  text: string;
  sig?: string;
}
interface Image {
  type: "image";
  data: string;
  mime: string;
}
interface Split {
  content: Text[];
  caption: string;
}
interface Msg {
  content: (Text | Image)[];
  isError: boolean;
}
function split(msg: Msg): Split | undefined {
  if (!msg.isError) return undefined;
  const content: Text[] = [];
  for (const c of msg.content) if (c.type === "text") content.push(c);
  return { content, caption: "images follow" };
}
function describe(content: (Text | Image)[]): string {
  return content.map((c) => (c.type === "image" ? `image:${c.mime}` : `text:${c.text}`)).join(",");
}
function show(msg: Msg, selective: boolean): string {
  const parts = selective ? split(msg) : undefined;
  return describe(parts?.content ?? msg.content);
}
const m: Msg = {
  content: [
    { type: "text", text: "a" },
    { type: "image", data: "d", mime: "image/png" },
  ],
  isError: true,
};
console.log(show(m, true));
console.log(show(m, false));
console.log(show({ content: m.content, isError: false }, true));

function count(xs: (Text | Image)[]): number {
  return xs.length;
}
function a(l: Text[] | undefined, r: (Text | Image)[]): number {
  return count(l ?? r);
}
function b(l: Text | undefined, r: Text | Image): string {
  const v = l ?? r;
  return v.type;
}
function c(l: number[] | undefined, r: (number | string)[]): string {
  return (l ?? r).join("|");
}
function d(l: Text[] | null | undefined, r: (Text | Image)[]): number {
  return (l ?? r).length;
}
const texts: Text[] = [{ type: "text", text: "a" }];
const mixed: (Text | Image)[] = [
  { type: "image", data: "", mime: "m" },
  { type: "text", text: "b" },
];
console.log(a(texts, mixed), a(undefined, mixed));
console.log(b(texts[0], mixed[0]!), b(undefined, mixed[0]!));
console.log(c([1, 2], ["x", 3]), c(undefined, ["x", 3]));
console.log(d(texts, mixed), d(null, mixed), d(undefined, mixed));

// The default is evaluated only when the left is missing, and the left once.
let lefts = 0;
let rights = 0;
function left(present: boolean): Text[] | undefined {
  lefts++;
  return present ? texts : undefined;
}
function right(): (Text | Image)[] {
  rights++;
  return mixed;
}
console.log(count(left(true) ?? right()), count(left(false) ?? right()), lefts, rights);
