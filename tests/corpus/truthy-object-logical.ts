// `&&` and `||` whose left operand is an object, array or function value:
// every object is truthy, so `o && x` evaluates `o` and answers `x`, and
// `o || x` answers `o` without evaluating `x`.
interface Stream {
  isTTY: boolean;
  columns: number;
}
let reads = 0;
const stream = (): Stream => {
  reads++;
  return { isTTY: reads % 2 === 1, columns: 80 };
};
function tty(s: Stream): boolean {
  return s && s.isTTY;
}
console.log(tty({ isTTY: true, columns: 1 }), tty({ isTTY: false, columns: 2 }));
const width = stream() && stream().columns;
console.log(width, reads);
const list = [3, 1, 2];
const first = list && list.length;
console.log(first);
const fn = (n: number): number => n * 2;
const doubled = fn && fn(21);
console.log(doubled);
let evaluated = false;
const fallback = (): Stream => {
  evaluated = true;
  return { isTTY: false, columns: 0 };
};
const chosen = stream() || fallback();
console.log(chosen.columns, evaluated, reads);
