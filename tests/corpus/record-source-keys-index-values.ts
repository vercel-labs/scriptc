// A checked conversion into an index-signature record whose values are
// closed records keeps each value's undeclared source keys, so converting
// such a value into an index-signature record later copies them. This
// program has no checked conversion into a closed record itself, so the
// capture learns that kept sources are possible from the index signature's
// values. Node prints "extra,x".
type H = Record<string, string | null>;
interface T {
  transformHeaders?: (h: H) => H | Promise<H>;
}
const parsed: Record<string, { x: string }> = JSON.parse('{"p":{"x":"1","extra":"e"}}');
async function viaArrow<O extends T>(o: O | undefined): Promise<H> {
  let h: H = { accept: "a" };
  if (o?.transformHeaders) h = await o.transformHeaders(h);
  return h;
}
viaArrow({ transformHeaders: async (h) => parsed["p"]! }).then((r) =>
  console.log(Object.keys(r).sort().join(",")),
);
