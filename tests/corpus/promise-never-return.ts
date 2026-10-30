// `return fatal(...)` where `fatal` is declared `Promise<never>`: the promise
// can never settle, so the awaited value is unreachable and fills the async
// function's record result instead of failing a void-to-record conversion.

interface Outcome {
  cancelled: boolean;
}

async function fatal(message: string): Promise<never> {
  throw new Error(message);
}

async function run(flag: boolean): Promise<Outcome> {
  try {
    if (flag) throw new Error(`zap ${flag}`);
    return { cancelled: false };
  } catch (error: unknown) {
    return fatal(error instanceof Error ? error.message : "unknown");
  }
}

async function passthrough(): Promise<number> {
  try {
    throw new Error("always");
  } catch {
    return fatal("passthrough");
  }
}

run(false)
  .then((outcome) => console.log("resolved:", outcome.cancelled))
  .catch((error) => console.log("rejected:", error instanceof Error ? error.message : error));
run(true)
  .then((outcome) => console.log("resolved:", outcome.cancelled))
  .catch((error) => console.log("rejected:", error instanceof Error ? error.message : error));
passthrough()
  .then((value) => console.log("value:", value))
  .catch((error) => console.log("rejected:", error instanceof Error ? error.message : error));
