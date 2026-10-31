// Groups built through virtual calls and sorted with callbacks, nested
// groups inside a group, and temporaries the group does not keep.
abstract class Shape {
  abstract area(): number;
  abstract scaled(k: number): Shape;
}
class Square extends Shape {
  side: number;
  constructor(side: number) {
    super();
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
  scaled(k: number): Shape {
    return new Square(this.side * k);
  }
}
class Circle extends Shape {
  radius: number;
  constructor(radius: number) {
    super();
    this.radius = radius;
  }
  area(): number {
    return Math.round(Math.PI * this.radius * this.radius * 100) / 100;
  }
  scaled(k: number): Shape {
    return new Circle(this.radius * k);
  }
}

interface Box {
  label: string;
  shapes: Shape[];
}

function measure(s: Shape): { area: number } {
  return { area: s.area() };
}

function boxes(n: number): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const shapes: Shape[] = [];
    for (let j = 0; j < 4; j++) {
      const base: Shape = j % 2 === 0 ? new Square(j + i) : new Circle(j + 1);
      shapes.push(base.scaled(2));
    }
    // Temporaries the group does not keep.
    let total = 0;
    for (const s of shapes) total += measure(s).area;
    shapes.sort((a, b) => a.area() - b.area());
    out.push({ label: `box${i}:${Math.round(total)}`, shapes });
  }
  return out;
}

function summarize(n: number): string {
  const list = boxes(n);
  let largest = "";
  let best = -1;
  for (const b of list) {
    const top = b.shapes[b.shapes.length - 1]!.area();
    if (top > best) {
      best = top;
      largest = b.label;
    }
  }
  return `${largest}@${best}`;
}

let out = "";
for (let round = 1; round < 30; round++) {
  const all = boxes(round);
  out = `${all.length} ${all[0]!.label} ${all[round - 1]!.shapes[0]!.area()} ${summarize(round)}`;
  if (round % 7 === 0) console.log(out);
}
console.log(out);
