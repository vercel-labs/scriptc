// A getter and a setter over one field: the view answers the member through
// the getter, which reads the instance's state when the field is copied, so
// a write through the setter shows up in a conversion made afterwards.

interface Counted {
  readonly label: string;
  readonly value: number;
}

class Box {
  private current: number;
  readonly label: string;
  constructor(current: number, label: string) {
    this.current = current;
    this.label = label;
  }
  get value(): number {
    return this.current;
  }
  set value(next: number) {
    this.current = next;
  }
}

function describe(value: unknown): string {
  const counted = value as Counted;
  return `${counted.label}=${counted.value}`;
}

const box = new Box(1, "count");
console.log(describe(box as unknown));
box.value = 41;
console.log(describe(box as unknown));
const again = box as unknown as Counted;
console.log(again.value + again.value);
