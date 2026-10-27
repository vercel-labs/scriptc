// Promise.race with a Promise<never> deadline entry under a typed result:
// the never entry can only reject, so it races with any result type. A
// read that settles first wins; a deadline that fires first rejects.
class Deadline extends Error {}
async function readWithDeadline(read: () => Promise<{ done: boolean; value?: Uint8Array }>, ms: number): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Deadline()), ms);
      }),
    ]);
  } catch (error) {
    if (error instanceof Deadline) return { done: true };
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
readWithDeadline(async () => ({ done: false, value: new Uint8Array([1, 2]) }), 1000).then((r) => console.log(r.done, r.value?.length));
readWithDeadline(() => new Promise((res) => setTimeout(() => res({ done: false }), 200)), 20).then((r) => console.log("deadline", r.done));
