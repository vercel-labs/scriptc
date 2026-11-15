// Methods that never read `this` stay callable when detached, so each has
// a receiverless copy beside it. Their bodies add, subtract, compare,
// interpolate and key with untyped values, in a program where a class
// with a `toString` and a `valueOf` reaches untyped code, so every such
// operand converts through the class's own methods. The method, its
// detached value and the call through an untyped receiver agree.

class Money {
  readonly cents: number;
  constructor(cents: number) {
    this.cents = cents;
  }
  toString(): string {
    return `$${(this.cents / 100).toFixed(2)}`;
  }
  valueOf(): number {
    return this.cents;
  }
}

const paint: any = {
  fg(kind: string, text: string): string {
    return `<${kind}>${text}</${kind}>`;
  },
  w(): number {
    return 5;
  },
  k(): string {
    return "tone";
  },
  tone: "warm",
};

function hint(key: string, what: string): string {
  return paint.fg("dim", key) + paint.fg("muted", ` ${what}`);
}

class Picker {
  private scope = "all";
  scopeHint(): string {
    return hint("tab", "scope") + paint.fg("muted", " (all/scoped)");
  }
  render(): string {
    return `${this.scope}: ${this.scopeHint()}`;
  }
  label(): string {
    return "a" + paint.fg("x", "y");
  }
  width(): number {
    return paint.w() - 1;
  }
  wide(): boolean {
    return paint.w() > 3;
  }
  text(): string {
    return `${paint.fg("m", "t")}!`;
  }
  tone(): unknown {
    const k: any = paint.k();
    return paint[k];
  }
  nested(): string {
    return paint.fg("a", "b") + (paint.fg("c", "d") + paint.fg("e", "f"));
  }
  static tag(): string {
    return "s" + paint.fg("a", "b");
  }
  get hint(): string {
    return "g" + paint.fg("a", "b");
  }
  async later(): Promise<string> {
    return "l" + paint.fg("a", "b");
  }
  *each(): Generator<string> {
    yield "e" + paint.fg("a", "b");
  }
  arrow = (): string => "w" + paint.fg("a", "b");
}

const picker = new Picker();
const loosePicker: any = picker;
console.log(picker.render());
console.log(picker.scopeHint(), loosePicker.scopeHint());
console.log(picker.label(), picker.width(), picker.wide(), picker.text(), picker.tone(), picker.nested());
console.log(
  loosePicker.label(),
  loosePicker.width(),
  loosePicker.wide(),
  loosePicker.text(),
  loosePicker.tone(),
  loosePicker.nested(),
);
const scopeHint = picker.scopeHint;
const label = picker.label;
const width = picker.width;
const wide = picker.wide;
const text = picker.text;
const tone = picker.tone;
const nested = picker.nested;
console.log(scopeHint(), label(), width(), wide(), text(), tone(), nested());
console.log(Picker.tag(), picker.hint, loosePicker.hint, picker.arrow(), loosePicker.arrow());
const tag = Picker.tag;
console.log(tag(), [...picker.each()].join(","));

const boxed: any = new Money(1250);
console.log("total " + boxed, boxed + 1, `${boxed}`, boxed > 1000);

class Stack extends Array<string> {}
const stack = new Stack();
stack.push("1", "a", "b");
const truthy = (x: string): any => (x === "a" ? boxed : x === "b" ? 0 : paint.k());
console.log(stack.filter(truthy).join(","), stack.map((x) => x + paint.k()).join(","));
const plain: string[] = ["1", "a", "b"];
console.log(plain.filter(truthy).join(","), plain.map((x) => x + paint.k()).join(","));
const mixed: any[] = [1, "b", boxed];
console.log(mixed.map((x) => x + 1).join(","), mixed.filter((x) => x + 1 !== "b1").length);

picker.later().then((v) => console.log(v));
loosePicker.later().then((v: string) => console.log(v));
