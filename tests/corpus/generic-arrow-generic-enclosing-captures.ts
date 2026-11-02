// A generic arrow or function-expression binding declared inside a GENERIC
// function or class body may capture that frame when the captured types read
// none of the enclosing type parameters: each instance's parameter holds the
// same type in every instantiation, so one shared instance serves them all.
// A capture whose type does read an enclosing type parameter keeps the
// refusal.
//
// The getSlot shape (a generic arrow closing over a Map and a counter inside a
// generic provider function) is the shape this rule was written for.

interface Slot {
  id: number;
  value: string;
}

function processStream<TApi extends { name: string; retries?: number }>(
  api: TApi,
  count: number,
): string[] {
  const slots = new Map<number, Slot>();
  const calls: number[] = [];
  const getSlot = <K extends number>(index: K): Slot => {
    calls.push(index);
    let slot = slots.get(index);
    if (slot === undefined) {
      slot = { id: slots.size + 1, value: `slot-${index}-${count}` };
      slots.set(index, slot);
    }
    return slot;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(getSlot(i % 3).value);
  out.push(calls.join("/"), api.name, String(slots.size));
  return out;
}

console.log(processStream({ name: "alpha", retries: 2 }, 5).join(","));
console.log(processStream({ name: "beta" }, 2).join(","));

// A class's type parameter keys the same decision from inside its methods.
class Registry<K extends string> {
  readonly name: K;

  constructor(name: K) {
    this.name = name;
  }

  describe(prefix: string): string {
    const seen = new Set<string>();
    const mark = <T extends string>(value: T): string => {
      const tag = `${prefix}:${value}`;
      seen.add(tag);
      return `${tag}/${seen.size}`;
    };
    return `${this.name} ${mark("a")} ${mark("b")} ${seen.has("p:a")} ${seen.has("p:z")}`;
  }
}

console.log(new Registry("r1").describe("p"));
console.log(new Registry("r2").describe("q"));
