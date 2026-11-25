// The project's tsconfig lists "dom" in "lib". A type that only that library
// declares is opaque in compiled code: no native value has it, and a value
// that flows through it is checked dynamically, as under Node.

// A slot that only ever holds null.
interface Tile {
  id: number;
  anchor: Element | null;
}
const tiles: Tile[] = [
  { id: 1, anchor: null },
  { id: 2, anchor: null },
];
console.log(tiles.filter((tile) => tile.anchor === null).length);

// An alias of a primitive.
const marks: DOMHighResTimeStamp[] = [1.5, 2.25, 4];
let elapsed: DOMHighResTimeStamp = 0;
for (const mark of marks) elapsed += mark;
console.log(elapsed, typeof elapsed);

// A function that is never called.
function paint(canvas: HTMLCanvasElement, at: DOMPoint): void {
  canvas.getContext("2d")?.fillRect(at.x, at.y, 1, 1);
}
console.log(typeof paint);

// A look-alike object handed to a parameter of such a type.
function area(box: DOMRectReadOnly): number {
  return box.width * box.height;
}
const box = { width: 3, height: 4 } as unknown as DOMRectReadOnly;
console.log(area(box));

// A callback typed with such a type, called with a look-alike.
type Describe = (event: KeyboardEvent) => string;
const describe: Describe = (event) => `${event.key}:${event.repeat}`;
console.log(describe({ key: "a", repeat: false } as unknown as KeyboardEvent));

// A generic container of such a type.
const registry = new Map<string, Node | null>();
registry.set("root", null);
console.log(registry.size, registry.get("root") === null, registry.has("leaf"));

// A class with such a field, method parameter and `implements` clause.
class Tracker implements EventListenerObject {
  seen = 0;
  last: UIEvent | null = null;
  handleEvent(event: UIEvent): void {
    this.last = event;
    this.seen++;
  }
}
const tracker = new Tracker();
console.log(tracker.seen, tracker.last === null);
tracker.handleEvent({ detail: 7 } as unknown as UIEvent);
console.log(tracker.seen, tracker.last === null, tracker.last?.detail);

// A type query of a global of that library.
function sameHost(host: typeof window | undefined): boolean {
  return host === undefined;
}
console.log(sameHost(undefined));
