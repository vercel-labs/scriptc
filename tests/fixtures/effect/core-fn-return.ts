import { Effect } from "effect";
const tagged = Effect.fn("tagged")(function* (n: number): Effect.fn.Return<number, never> {
  const a = yield* Effect.succeed(n + 1);
  return a * 2;
});
const plain = Effect.fn(function* (s: string): Effect.fn.Return<string, never> {
  const t = yield* Effect.succeed(s + "!");
  return t + "?";
});
const program = Effect.gen(function* () {
  const a = yield* tagged(4);
  const b = yield* plain("hi");
  return `${a} ${b}`;
});
Effect.runPromise(program).then((v) => console.log(v));
