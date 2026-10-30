// util.debounce and util.throttle through their TypeScript types.
import { debounce, throttle } from "node:util";

async function main(): Promise<void> {
  const save = debounce((text: string, times: number): string => text.repeat(times), 10);
  const first = save("a", 1);
  const last = save("b", 3);
  console.log(save.pendingCount, save.pending !== null);
  const results: string[] = await Promise.all([first, last]);
  console.log(results, save.pendingCount);

  const doubled = throttle(async (n: number): Promise<number> => n * 2, 2, 20);
  const values: number[] = await Promise.all([doubled(1), doubled(2), doubled(3)]);
  console.log(values, doubled.activeCount, doubled.hasImmediateCapacity());

  const later = debounce((n: number) => n, 1000);
  const pending = later(5);
  later.cancel("stopped");
  try {
    await pending;
  } catch (e) {
    const err = e as Error;
    console.log(err.name, err.message, err.cause);
  }
  console.log(later.ref() === later, later.unref() === later);
}
main();
