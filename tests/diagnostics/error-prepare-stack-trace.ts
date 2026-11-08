// Error.prepareStackTrace is V8's hook for formatting a stack from call
// sites. A compiled program has no call sites to pass a formatter, so
// installing one is refused by name; assigning undefined is nothing.
declare global {
  interface ErrorConstructor {
    prepareStackTrace?: ((error: Error, frames: unknown[]) => unknown) | undefined;
  }
}

function keepFrames(_error: Error, frames: unknown[]): unknown {
  return frames;
}

Error.prepareStackTrace = undefined;
Error.prepareStackTrace = (_error, frames) => frames;
Error.prepareStackTrace = keepFrames;
Error.prepareStackTrace = function (_error: Error, frames: unknown[]): unknown {
  return frames.length;
};
console.log(typeof new Error("x").stack);

export {};
