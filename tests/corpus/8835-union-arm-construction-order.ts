// Two arms of one union declare the same keys in different orders: `While`
// declares `cond` before `body` and `DoWhile` declares `body` before `cond`,
// so the two constructors below build one shape in two orders. A static copy
// enumerates the shape's declaration order, which is only one of them, so
// each record keeps the order its own literal wrote. Object.keys and
// JSON.stringify must match Node for both, with and without the maybe-absent
// `labels` spread.

interface While {
  kind: "while";
  cond: number;
  body: string[];
  labels?: string[];
  loc: number;
}

interface DoWhile {
  kind: "doWhile";
  body: string[];
  cond: number;
  labels?: string[];
  loc: number;
}

type Stmt = While | DoWhile;

function show(stmt: Stmt): string {
  return JSON.stringify(stmt) + " " + Object.keys(stmt).join(",");
}

function mkWhile(cond: number, body: string[], labels?: string[]): Stmt {
  const extra = labels && { labels };
  return { kind: "while", cond, body, ...extra, loc: 1 };
}

function mkDoWhile(body: string[], cond: number, labels?: string[]): Stmt {
  const extra = labels && { labels };
  return { kind: "doWhile", body, cond, ...extra, loc: 2 };
}

console.log(show(mkWhile(1, ["a"], ["L"])));
console.log(show(mkWhile(1, ["a"])));
console.log(show(mkDoWhile(["b"], 2, ["L"])));
console.log(show(mkDoWhile(["b"], 2)));

// A copy of either arm keeps the source value's order and rewrites an
// existing key in place.
function retarget(stmt: Stmt): string {
  return show({ ...stmt, loc: 3 });
}

console.log(retarget(mkDoWhile(["c"], 4, ["M"])));
console.log(retarget(mkWhile(5, ["c"], ["M"])));

// The sources are copied, never written.
const src: Stmt = mkDoWhile(["d"], 6);
console.log(JSON.stringify(src), JSON.stringify({ ...src, loc: 7 }));
