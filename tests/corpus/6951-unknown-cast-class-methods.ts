// Methods of a class instance read through `unknown` cast to a structural
// type: the read finds the prototype method, as Node's property lookup does.

class Greeter {
  label = "greeter";
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  describe(): string {
    return `${this.label}:${this.name}`;
  }
  shout(): string {
    return this.describe().toUpperCase();
  }
}

class LoudGreeter extends Greeter {
  extra(): number {
    return 42;
  }
}

type Describable = { describe?: () => string; shout?: () => string; label?: string };

function inspect(value: unknown): void {
  const shaped = value as Describable;
  console.log(typeof shaped.describe, typeof shaped.shout, shaped.label);
  console.log(shaped.describe?.() ?? "no describe");
  console.log(shaped.shout?.() ?? "no shout");
}

inspect(new Greeter("ada"));
inspect(new LoudGreeter("grace"));
inspect({ label: "plain", describe: () => "own function" });
inspect({ label: "bare" });

const loud: unknown = new LoudGreeter("lin");
const withExtra = loud as { extra?: () => number; missing?: () => number };
console.log(withExtra.extra?.(), withExtra.missing?.() ?? "no missing");
