// The report-only tier assignment of `scriptc coverage --explain-dynamic`.
class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

// Reflection on a class: the dynamic tier would give Point a prototype object.
(Point.prototype as any).norm = function () {
  return 0;
};

// Already dynamic: a property read on an `any` value.
function readName(text: string): string {
  const data: any = JSON.parse(text);
  return String(data.name);
}

// An operation without a static lowering (the host's default locale), on a parameter.
function precise(n: number): string {
  return n.toLocaleString();
}

console.log(readName('{"name":"a"}'), precise(1.5), new Point(1, 2).x);
