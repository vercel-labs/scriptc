// A union of a function type with a value the checked-dynamic tree holds
// (AbortSignal, `unknown`) rides that representation: the function is held
// by reference, `typeof x === "function"` narrows it back out, and calls,
// identity and the other arm's members behave as in Node.

type Progress = (loaded: number, total: number) => void;

function listAll(
  dirOrProgress?: string | Progress,
  progressOrSignal?: Progress | AbortSignal,
  signal?: AbortSignal,
): string {
  const dir = typeof dirOrProgress === "string" ? dirOrProgress : "/default";
  const progress =
    typeof dirOrProgress === "function"
      ? dirOrProgress
      : typeof progressOrSignal === "function"
        ? progressOrSignal
        : undefined;
  const abortSignal =
    typeof dirOrProgress === "string" || typeof progressOrSignal === "function"
      ? signal
      : (progressOrSignal ?? signal);
  progress?.(1, 3);
  progress?.(3, 3);
  return `${dir} aborted=${abortSignal?.aborted ?? "none"}`;
}

const seen: string[] = [];
const report: Progress = (loaded, total) => seen.push(`${loaded}/${total}`);
const controller = new AbortController();
console.log(listAll());
console.log(listAll("/x", report));
console.log(listAll(report, controller.signal));
controller.abort();
console.log(listAll("/y", undefined, controller.signal));
console.log(listAll(report, controller.signal), seen.join(" "));

function same(handler: Progress | AbortSignal | undefined): boolean {
  return handler === report;
}
console.log(same(report), same(controller.signal), same(undefined), same((a, b) => void (a + b)));

function describe(value: unknown | ((n: number) => string)): string {
  if (typeof value === "function") return `function -> ${(value as (n: number) => string)(7)}`;
  return `value ${JSON.stringify(value)}`;
}
console.log(describe((n: number) => `n=${n}`), describe({ a: 1 }), describe("s"));
