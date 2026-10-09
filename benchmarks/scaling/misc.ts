// Scaling probes: JSON, closures, exceptions, regex, generators, dates. Usage: misc <case> <n>
type Rec = { id: number; name: string; tags: string[]; score: number; active: boolean };
function records(n: number): Rec[] {
  const out: Rec[] = [];
  for (let i = 0; i < n; i++)
    out.push({ id: i, name: "user" + i, tags: ["a" + (i % 5), "b"], score: i * 0.5, active: i % 3 === 0 });
  return out;
}
type Node2 = { v: number; kids: Node2[] };
function tree(depth: number, fan: number): Node2 {
  const kids: Node2[] = [];
  if (depth > 0) for (let i = 0; i < fan; i++) kids.push(tree(depth - 1, fan));
  return { v: depth, kids };
}
function jsonWide(n: number): string {
  const s = JSON.stringify(records(n));
  const back = JSON.parse(s) as Rec[];
  return `${s.length} ${back.length} ${back[n - 1]!.name}`;
}
function jsonIndent(n: number): string {
  const s = JSON.stringify(records(n), null, 2);
  return `${s.length}`;
}
function jsonNested(n: number): string {
  // ~n nodes in a fan-4 tree
  let depth = 0;
  let count = 1;
  while (count * 4 < n) {
    count *= 4;
    depth++;
  }
  const t = tree(depth, 4);
  const s = JSON.stringify(t);
  const back = JSON.parse(s) as Node2;
  return `${s.length} ${back.kids.length}`;
}
function jsonDeep(n: number): string {
  // A deep chain (linked list) of n/100 levels... capped to stay under Node's recursion limit.
  const depth = Math.min(n, 3000);
  let s = "0";
  for (let i = 0; i < depth; i++) s = "[" + s + "]";
  let total = 0;
  for (let k = 0; k < Math.max(1, Math.floor(n / depth)); k++) {
    const v = JSON.parse(s) as unknown;
    total += JSON.stringify(v).length;
  }
  return `${total}`;
}
function jsonManySmall(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const s = JSON.stringify({ i, s: "x" + i, ok: true });
    const o = JSON.parse(s) as { i: number; s: string; ok: boolean };
    t += o.i + s.length;
  }
  return `${t}`;
}
function jsonBigString(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("line \"" + i + "\"\n\t");
  const big = parts.join("");
  const s = JSON.stringify({ big });
  const back = JSON.parse(s) as { big: string };
  return `${s.length} ${back.big.length}`;
}
function closures(n: number): string {
  const fns: (() => number)[] = [];
  for (let i = 0; i < n; i++) fns.push(() => i * 2);
  let s = 0;
  for (const f of fns) s += f();
  return `${s}`;
}
function closureCounter(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) {
    let c = i;
    const inc = (): number => ++c;
    inc();
    s += inc();
  }
  return `${s}`;
}
function tryNoThrow(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try {
      s += i;
    } catch (e) {
      s -= 1;
    }
  }
  return `${s}`;
}
function tryThrow(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try {
      if (i >= 0) throw new Error("bad " + i);
    } catch (e) {
      s += (e as Error).message.length;
    }
  }
  return `${s}`;
}
function throwDeep(n: number): string {
  function rec(d: number): number {
    if (d === 0) throw new RangeError("deep");
    return rec(d - 1) + 1;
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    try {
      s += rec(20);
    } catch (e) {
      s += 1;
    }
  }
  return `${s}`;
}
function finallyLoop(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) {
    try {
      s += i & 3;
    } finally {
      s += 1;
    }
  }
  return `${s}`;
}
function regexNew(n: number): string {
  let c = 0;
  for (let i = 0; i < n; i++) {
    const re = new RegExp("^item-(\\d+)$");
    if (re.test("item-" + i)) c++;
  }
  return `${c}`;
}
function regexLiteral(n: number): string {
  let c = 0;
  for (let i = 0; i < n; i++) if (/^item-(\d+)$/.test("item-" + i)) c++;
  return `${c}`;
}
function regexExecG(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("k" + i + "=v" + i);
  const s = parts.join("&");
  const re = /(\w+)=(\w+)/g;
  let m: RegExpExecArray | null;
  let c = 0;
  while ((m = re.exec(s)) !== null) c += m[2]!.length;
  return `${c}`;
}
function matchAll(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("k" + i + "=v" + i);
  const s = parts.join("&");
  let c = 0;
  for (const m of s.matchAll(/(\w+)=(\w+)/g)) c += m[1]!.length;
  return `${c}`;
}
function regexSplit(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push("a" + i);
  const s = parts.join(" ,  ");
  return `${s.split(/\s*,\s*/).length}`;
}
function generator(n: number): string {
  function* gen(k: number): Generator<number> {
    for (let i = 0; i < k; i++) yield i;
  }
  let s = 0;
  for (const v of gen(n)) s += v;
  return `${s}`;
}
function manyGenerators(n: number): string {
  function* pair(a: number): Generator<number> {
    yield a;
    yield a + 1;
  }
  let s = 0;
  for (let i = 0; i < n; i++) for (const v of pair(i)) s += v;
  return `${s}`;
}
function destructure(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [i, i + 1];
    const { x, y } = { x: a, y: b };
    s += x + y;
  }
  return `${s}`;
}
function dateNew(n: number): string {
  let ok = 0;
  for (let i = 0; i < n; i++) if (new Date().getTime() > 0) ok++;
  return `${ok}`;
}
function dateNow(n: number): string {
  let ok = 0;
  for (let i = 0; i < n; i++) if (Date.now() > 0) ok++;
  return `${ok}`;
}
function perfNow(n: number): string {
  let ok = 0;
  for (let i = 0; i < n; i++) if (performance.now() >= 0) ok++;
  return `${ok}`;
}
function dateFormat(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(1700000000000 + i * 3600000);
    t += d.toISOString().length + d.getUTCHours();
  }
  return `${t}`;
}
function dateParse(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) t += Date.parse("2024-01-" + String((i % 28) + 1).padStart(2, "0") + "T10:00:00Z") / 1e9;
  return `${Math.round(t)}`;
}
function dateLocal(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) {
    const d = new Date(1700000000000 + i * 3600000);
    t += d.getHours() + d.getDate() + d.getTimezoneOffset();
  }
  return `${t}`;
}
function mathRandom(n: number): string {
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.random();
  return `${s > 0}`;
}
function mathOps(n: number): string {
  let s = 0;
  for (let i = 1; i < n; i++) s += Math.sqrt(i) + Math.log(i) + Math.sin(i) + Math.floor(i / 3) + (i % 7);
  return `${s.toFixed(3)}`;
}
function errorStack(n: number): string {
  let t = 0;
  for (let i = 0; i < n; i++) t += new Error("e").message.length;
  return `${t}`;
}

const which = process.argv[2] ?? "";
const n = Number(process.argv[3] ?? "1000");
const t0 = performance.now();
let out = "";
switch (which) {
  case "json-wide": out = jsonWide(n); break;
  case "json-indent": out = jsonIndent(n); break;
  case "json-nested": out = jsonNested(n); break;
  case "json-deep": out = jsonDeep(n); break;
  case "json-many-small": out = jsonManySmall(n); break;
  case "json-big-string": out = jsonBigString(n); break;
  case "closures": out = closures(n); break;
  case "closure-counter": out = closureCounter(n); break;
  case "try-no-throw": out = tryNoThrow(n); break;
  case "try-throw": out = tryThrow(n); break;
  case "throw-deep": out = throwDeep(n); break;
  case "finally": out = finallyLoop(n); break;
  case "regex-new": out = regexNew(n); break;
  case "regex-literal": out = regexLiteral(n); break;
  case "regex-exec-g": out = regexExecG(n); break;
  case "match-all": out = matchAll(n); break;
  case "regex-split": out = regexSplit(n); break;
  case "generator": out = generator(n); break;
  case "many-generators": out = manyGenerators(n); break;
  case "destructure": out = destructure(n); break;
  case "date-new": out = dateNew(n); break;
  case "date-now": out = dateNow(n); break;
  case "perf-now": out = perfNow(n); break;
  case "date-format": out = dateFormat(n); break;
  case "date-parse": out = dateParse(n); break;
  case "date-local": out = dateLocal(n); break;
  case "math-random": out = mathRandom(n); break;
  case "math-ops": out = mathOps(n); break;
  case "error-new": out = errorStack(n); break;
  default: out = "unknown case";
}
const t1 = performance.now();
console.log(which, n, out);
console.error("T=" + (t1 - t0).toFixed(3));
