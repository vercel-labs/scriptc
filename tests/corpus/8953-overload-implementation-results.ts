// Implementations filling an overloaded member's one stored function with
// an optional or defaulted parameter, whose own result the stored
// function's result converts: an inferred async result (`Promise<string>`)
// narrower than the overloads' (`Promise<string | undefined>`), a record
// result that widens into the overloads' record, and an `any` result that
// each call converts to its resolved overload's type.
export {};

interface Model {
  provider: string;
  id: string;
}
interface Overrides {
  env?: string;
}
interface Auth {
  getAuth(providerId: string, overrides?: Overrides): Promise<string | undefined>;
  getAuth(model: Model, overrides?: Overrides): Promise<string | undefined>;
}

const optional: Auth = {
  async getAuth(target: string | Model, overrides?: Overrides) {
    return typeof target === "string" ? `id:${target}:${overrides?.env ?? "-"}` : `model:${target.id}`;
  },
};
const defaulted: Auth = {
  async getAuth(target: string | Model, overrides: Overrides = { env: "default" }) {
    return typeof target === "string" ? `id:${target}:${overrides.env}` : `model:${target.provider}`;
  },
};

interface Point {
  x: number;
  y?: number;
}
interface Shapes {
  make(x: number): Point;
  make(x: string): Point;
}
const shapes: Shapes = {
  make(x: number | string, scale?: number) {
    return { x: (typeof x === "number" ? x : x.length) * (scale ?? 1) };
  },
};

interface Picker {
  pick(kind: "s"): string;
  pick(kind: "n"): number;
}
const picker: Picker = {
  pick(kind: "s" | "n", fallback?: string): any {
    return kind === "s" ? (fallback ?? "str") : 41;
  },
};

async function main(): Promise<void> {
  for (const auth of [optional, defaulted]) {
    console.log(await auth.getAuth("anthropic"), await auth.getAuth("openai", { env: "ci" }));
    console.log(await auth.getAuth({ provider: "google", id: "gemini" }));
  }
  const a = shapes.make(3);
  const b = shapes.make("four");
  console.log(a.x + b.x, a.y === undefined, JSON.stringify([a, b]));
  console.log(picker.pick("s").toUpperCase(), picker.pick("n") + 1);
}

await main();
