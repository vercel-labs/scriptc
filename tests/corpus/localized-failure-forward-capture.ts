// Localized failure, stage L1: a statement that declares a binding an
// earlier closure captures, and then a binding whose declared type has no
// static lowering, still initializes the captured binding.
type Callbacks = ((done: number) => void) | AbortSignal | Map<string, (x: number) => string> | Set<number>;

function run(): void {
  const read = (): number => total;
  const total = 3,
    hook: Callbacks = new Set<number>([1, 2]);
  console.log(read(), hook instanceof Set, hook instanceof Set && hook.size);
  let late = (): string => label;
  let label = "first",
    other: Callbacks = new Set<number>([3]);
  console.log(late(), other instanceof Set);
  label = "second";
  late = (): string => label + "!";
  console.log(late());
}
run();
