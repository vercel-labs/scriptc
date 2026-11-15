// The F & P intersection type, built through a declared variable, then passed around.
type Handler = ((x: number) => number) & { kind: string; hits: number };
function wrap(f: (x: number) => number, kind: string): Handler {
  const h = ((x: number) => {
    h.hits++;
    return f(x);
  }) as Handler;
  h.kind = kind;
  h.hits = 0;
  return h;
}
const h = wrap((x) => x * 2, "double");
const list: Handler[] = [h];
console.log(list[0]!(4), h.hits, list[0] === h, Object.keys(h));
