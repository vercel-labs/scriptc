// A dynamic slot read in a loop: SC6101 names the slot, and coverage
// counts the dynamic operations on it. The intersection arm has no
// canonical form, so `Hook` stays a dynamic piece of `Plugin[]`.
type Hook = (() => number) | (AbortSignal & { tag?: string }) | Map<string, (x: number) => string>;

interface Plugin {
  name: string;
  hook: Hook;
}

const plugins: Plugin[] = [
  { name: "one", hook: () => 1 },
  { name: "two", hook: () => 2 },
];

function sum(rounds: number): number {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    for (const p of plugins) {
      const hook = p.hook;
      if (typeof hook === "function") total += hook();
      else total += (hook as { size?: number }).size ?? 0;
    }
  }
  return total;
}

console.log(sum(10));
