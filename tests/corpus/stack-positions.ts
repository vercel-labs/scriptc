// Error.stack positions: the top frame names the call or throw site that
// is running — a `new Error` call, a throwing expression, the call whose
// callee raised — and every caller names the call still running in it.
// Frames print function, line and column (the file is elided here so the
// Node oracle and the compiled binary compare like for like); V8's own
// loader frames are not program frames and are dropped.
const self = "stack-positions.ts";

function frames(stack: string): string {
  const out: string[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    const match = /^\s*at (?:(.+?) \()?(?:.*[\\/])?([^\\/():]+):(\d+):(\d+)\)?$/.exec(line);
    if (match === null) continue;
    if (match[2] !== self) continue;
    const name = match[1] === undefined || match[1] === "Object.<anonymous>" ? "module" : match[1];
    out.push(`${name} ${match[3]} ${match[4]}`);
  }
  return out.join(" | ");
}

function fail(): string {
  return new Error("boom").stack ?? "";
}

function middle(): string {
  return fail();
}

class Holder {
  fetch(): string {
    return middle();
  }
}

function thrower(): string {
  throw new Error("thrown");
}

function captureInto(target: { stack?: string }): void {
  Error.captureStackTrace(target, captureInto);
}

function captureCaller(): void {
  captureInto(target);
}

const target = new Error("holder");

console.log("capture", frames(middle()));
console.log("method", frames(new Holder().fetch()));
function caughtThrow(): string {
  try {
    thrower();
  } catch (error) {
    return (error as Error).stack ?? "";
  }
  return "";
}

console.log("throw", frames(caughtThrow()));
console.log("module", frames(new Error("top").stack ?? ""));
captureCaller();
console.log("captured", frames(target.stack ?? ""));
const loopStacks: string[] = [];
for (let i = 0; i < 2; i++) loopStacks.push(middle());
console.log("loop", loopStacks.map((stack) => frames(stack)).join(" ; "));
