// A generic function instantiated with `void` for its argument type keeps
// the void parameter's slot: callers still pass it, and dropping it would
// shift the options argument into the wrong position. The async handler
// returning a promise is accepted where the handler type answers `unknown`.
// Differentially vs Node.
interface Options {
  input: string;
  retries: number;
}
function action<A, O>(handler: (argument: A, options: O) => unknown): (argument: A, options: O) => void {
  return (argument: A, options: O): void => {
    void handler(argument, options);
  };
}
const decide = action<void, Options>(async (argument: void, options: Options): Promise<void> => {
  console.log("run", String(argument), options.input, options.retries);
});
decide(undefined, { input: "question", retries: 2 });
console.log("queued");
