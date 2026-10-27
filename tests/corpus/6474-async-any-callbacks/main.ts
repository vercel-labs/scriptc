// Async callbacks whose result the checker types `Promise<any>` handed to
// a JavaScript library typed `(...) => A | Promise<A>` (A = any collapses
// the slot to `any`): the callback value still returns a promise, and its
// payload is the checked-dynamic value the body produced.
import retry from "retry-lite";

function loose(attempt: number): any {
  if (attempt < 3) throw new Error(`attempt ${attempt} failed`);
  return { text: `ok after ${attempt}`, size: attempt * 10 };
}

async function main(): Promise<void> {
  const got = await retry(async (_bail, attempt) => loose(attempt), {
    retries: 5,
    onRetry: (e: Error) => console.log("retry:", e.message),
  });
  console.log(got.text, got.size);

  const parsed = await retry(
    async () => {
      const value = JSON.parse('{"items":[1,2,3]}');
      return value;
    },
    { retries: 1 },
  );
  console.log(parsed.items.length);

  try {
    await retry(
      async (bail) => {
        bail(new Error("gave up"));
        throw new Error("ignored");
      },
      { retries: 2 },
    );
  } catch (e) {
    console.log("caught:", (e as Error).message);
  }
}

main();
