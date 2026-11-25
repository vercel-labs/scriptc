// A getter-backed member the target shape does not declare: the conversion
// copies the fields it reads and leaves the extra member to the instance,
// which keeps answering it through its getter.

interface Shown {
  readonly label: string;
  readonly value: number;
}

class Meter {
  private current: number;
  readonly label: string;
  readonly unit = "mw";
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
  get hidden(): string {
    return `${this.label}:${this.current}`;
  }
}

function describe(value: unknown): string {
  const shown = value as Shown;
  return `${shown.label}=${shown.value}`;
}

const meter = new Meter(5, "a");
console.log(describe(meter as unknown));
console.log(Object.keys(meter as unknown as object).join(","));
meter.value = 9;
console.log(describe(meter as unknown));
console.log(Object.getOwnPropertyNames(meter as unknown as object).join(","));
