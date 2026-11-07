// What an unassigned binding does when it is used rather than tested:
// a member read throws Node's TypeError, arithmetic gives NaN, and the
// undefined passes on to a parameter, a string and a template.

let s: string;
let n: number;
let m: Map<string, number>;
let a: number[];
let o: { size: number };

function useS(): number {
  return s.length;
}
function useN(): number {
  return n + 1;
}
function useM(): number {
  return m.size;
}
function useA(): number {
  return a.length;
}
function useO(): number {
  return o.size;
}
function passN(x: number): string {
  return typeof x + ":" + x;
}
function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", e instanceof TypeError ? "TypeError" : "other");
  }
}
function all(): void {
  attempt("s.length", useS);
  attempt("n + 1", useN);
  attempt("m.size", useM);
  attempt("a.length", useA);
  attempt("o.size", useO);
  attempt("pass", () => passN(n));
  attempt("typeof", () => typeof s + typeof n + typeof m + typeof a + typeof o);
  attempt("truthy", () => (s ? 1 : 0) + (n ? 1 : 0) + (m ? 1 : 0) + (a ? 1 : 0) + (o ? 1 : 0));
  attempt("string", () => String(s) + String(n) + `${s}`);
  attempt("optional", () => [s?.length, a?.length, o?.size, m?.size].join(","));
}
all();
s = "x";
n = 1;
m = new Map();
a = [];
o = { size: 2 };
all();
