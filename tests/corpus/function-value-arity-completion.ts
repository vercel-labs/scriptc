// Calling a function value short is legal TypeScript whenever the omitted
// suffix is optional: the native callee still receives every parameter, so
// the call completes the missing slots with undefined exactly as the JS call
// would.
//
// The same holds for a call through an optional-chained property
// (`cb?.onRetryFinished?.(false, attempt)`), which evaluates the callee and
// its arguments once, in order.

interface RetryCallbacks {
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void;
  onAttempt?: (attempt: number, ...notes: string[]) => string;
}

function finish(callbacks: RetryCallbacks | undefined, ok: boolean, attempt: number): string[] {
  const log: string[] = [];
  const sink: RetryCallbacks = {
    onRetryFinished: (success, n, finalError) => {
      log.push(`finished ${success ? "ok" : "no"} ${n} ${finalError === undefined ? "none" : finalError}`);
    },
    onAttempt: (n, ...notes) => `${n}:${notes.join("+")}`,
  };
  sink.onRetryFinished?.(ok, attempt);
  sink.onRetryFinished?.(ok, attempt, "boom");
  callbacks?.onRetryFinished?.(ok, attempt + 1);
  callbacks?.onAttempt?.(attempt, "a", "b");
  return log;
}

console.log(finish(undefined, true, 1).join("; "));
console.log(
  finish(
    {
      onRetryFinished: (success, attempt, finalError) => {
        console.log(`callback ${success} ${attempt} ${finalError ?? "-"}`);
      },
      onAttempt: (attempt, ...notes) => {
        console.log(`attempt ${attempt} ${notes.length}`);
        return "ignored";
      },
    },
    false,
    2,
  ).join("; "),
);

// An omitted trailing argument for a callback whose parameter is optional in
// the middle of a longer signature.
type Reporter = (message: string, code?: number, detail?: string) => string;

function report(to: Reporter): void {
  console.log(to("first"));
  console.log(to("second", 42));
  console.log(to("third", undefined, "why"));
}

report((message, code, detail) => `${message}/${code ?? 0}/${detail ?? "-"}`);
