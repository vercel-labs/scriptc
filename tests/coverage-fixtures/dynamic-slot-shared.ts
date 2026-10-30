// A type that degrades as a piece of a container (`Plugin.hook`) and as a
// slot of its own (`current`): the operations on `current` belong to
// `current`, not to the container.
type Hook = (() => number) | AbortSignal | Map<string, (x: number) => string>;

interface Plugin {
  name: string;
  hook: Hook;
}

const plugins: Plugin[] = [{ name: "one", hook: () => 1 }];

let current: Hook = () => 2;

function run(rounds: number): number {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    if (typeof current === "function") total += current();
  }
  return total;
}

console.log(run(10), plugins.length);
