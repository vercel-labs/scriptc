// A class beside an interface it implements, in one union. The interface has
// optional members the class leaves out, so the checker does not fold the
// class into the interface: `swap ? new Label() : item` over a `Piece` is
// typed `Label | Piece`. The interface holds its objects by reference, and
// the class's instances are among them, so the union is the interface: the
// element a rebuild keeps (an instance of ANOTHER class of the interface) is
// still that object and still an instance of its class afterwards.
interface Piece {
  draw(width: number): string[];
  press?(key: string): void;
  wantsRelease?: boolean;
  reset(): void;
}

class Gap implements Piece {
  count: number;
  constructor(count = 1) {
    this.count = count;
  }
  reset(): void {}
  draw(_width: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.count; i++) out.push("");
    return out;
  }
}

class Label implements Piece {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  reset(): void {}
  draw(width: number): string[] {
    return [this.text.slice(0, width)];
  }
}

class Field implements Piece {
  value = "";
  reset(): void {}
  press(key: string): void {
    this.value += key;
  }
  draw(_width: number): string[] {
    return [`> ${this.value}`];
  }
}

class Box implements Piece {
  items: Piece[] = [];
  add(piece: Piece): void {
    this.items.push(piece);
  }
  reset(): void {
    for (const item of this.items) item.reset();
  }
  draw(width: number): string[] {
    const out: string[] = [];
    for (const item of this.items) out.push(...item.draw(width));
    return out;
  }
}

function report(name: string, pieces: Piece[], gap: Gap): void {
  const kept = pieces[0]!;
  console.log(
    name,
    (kept as unknown) === (gap as unknown),
    kept instanceof Gap,
    kept instanceof Label,
    JSON.stringify(pieces.map((piece) => piece.draw(8))),
  );
}

function fresh(): { box: Box; gap: Gap; field: Field } {
  const box = new Box();
  const gap = new Gap(1);
  const field = new Field();
  box.add(gap);
  box.add(new Label("name"));
  box.add(field);
  field.press("abc");
  return { box, gap, field };
}

// 1. The conditional as a map() callback's body.
{
  const { box, gap, field } = fresh();
  box.items = box.items.map((item) => (item === field ? new Label(`> ${field.value}`) : item));
  report("map:", box.items, gap);
  gap.count = 2;
  console.log(JSON.stringify(box.draw(8)), box.items[2] instanceof Label);
}

// 2. An `if` and two returns.
{
  const { box, gap, field } = fresh();
  box.items = box.items.map((item) => {
    if (item === field) return new Label("replaced");
    return item;
  });
  report("returns:", box.items, gap);
}

// 3. `??` with a new instance as the default.
function orLabel(item: Piece | undefined) {
  return item ?? new Label("default");
}
{
  const { box, gap } = fresh();
  const pieces: Piece[] = [orLabel(box.items[0]), orLabel(undefined)];
  report("nullish:", pieces, gap);
}

// 4. An array literal that holds both.
{
  const { box, gap } = fresh();
  const mixed = [box.items[0]!, new Label("beside")];
  const pieces: Piece[] = mixed;
  report("literal:", pieces, gap);
  console.log(mixed[0] instanceof Gap, mixed[1] instanceof Label);
}

// 5. The conditional's value held in a local, then stored.
{
  const { box, gap, field } = fresh();
  const pieces: Piece[] = [];
  for (const item of box.items) {
    const next = item === field ? new Label("local") : item;
    pieces.push(next);
  }
  report("local:", pieces, gap);
  const first = pieces[0]!;
  if (first instanceof Gap) first.count = 3;
  console.log(gap.count, JSON.stringify(gap.draw(1)));
}
