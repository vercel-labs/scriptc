// A module whose evaluation threw keeps that error: importing it again,
// or importing a module that depends on it, rejects with the same error
// value instead of running the body again or resolving.
import { SetupError } from "./errors.ts";

const seen: unknown[] = [];
for (let i = 0; i < 2; i++) {
  try {
    const mod = await import("./config.ts");
    console.log("loaded config", mod.limit);
  } catch (error) {
    seen.push(error);
    const e = error as SetupError;
    console.log("config failed", i, e.name, e.message, e.code, e instanceof SetupError);
  }
}
console.log("same error", seen.length === 2 && seen[0] === seen[1]);

try {
  const mod = await import("./report.ts");
  console.log("loaded report", mod.title);
} catch (error) {
  console.log("report failed", (error as Error).message, error === seen[0]);
}

for (let i = 0; i < 2; i++) {
  try {
    const mod = await import("./slow.ts");
    console.log("loaded slow", mod.ready);
  } catch (error) {
    console.log("slow failed", i, (error as Error).message);
  }
}

const ok = await import("./fine.ts");
const again = await import("./fine.ts");
console.log("fine", ok.count, again.count);
