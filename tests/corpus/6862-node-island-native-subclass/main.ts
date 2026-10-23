// @requires-libnode
// Native classes extending classes of a Node island (scope-B NI-5b): the
// instance is constructed through the island base, so island code sees an
// instance of the base; native fields, methods and accessors sit on top,
// super.method() reaches the base, and instanceof holds on both sides.
import { isError, KitError, report, Sema } from "kit-pkg";

class ConfigError extends KitError {
  hint: string;
  constructor(message: string, hint: string) {
    super({ code: "CONFIG", message });
    this.hint = hint;
  }
  describe(): string {
    return `${this.code}: ${this.message} (${this.hint})`;
  }
  get loud(): string {
    return this.message.toUpperCase();
  }
}

class StrictConfigError extends ConfigError {
  level = 2;
  describe(): string {
    return `strict ${super.describe()} level ${this.level}`;
  }
}

class TimedSema extends Sema {
  waits = 0;
  async acquire(): Promise<void> {
    this.waits++;
    await super.acquire();
  }
}

const e = new ConfigError("bad config", "check package.json");
console.log(e instanceof ConfigError, e instanceof KitError, isError(e));
console.log(e.describe(), "|", e.loud, "|", e.hint, e.code, e.name, e.link);
console.log(report(e));
const s = new StrictConfigError("worse", "fix it");
console.log(s instanceof StrictConfigError, s instanceof ConfigError, s instanceof KitError);
console.log(report(s));
try {
  throw new ConfigError("thrown", "catch it");
} catch (x) {
  if (x instanceof ConfigError) console.log("caught", x.describe());
  console.log("caught instanceof Error", x instanceof Error, x instanceof TypeError);
  if (x instanceof Error) console.log("caught message", x.message);
}
// Native `instanceof Error` on island-subclass instances answers as Node.
console.log("instanceof Error", e instanceof Error, s instanceof Error, e instanceof RangeError);
const held: unknown = e;
console.log("unknown instanceof Error", held instanceof Error, (new Error("plain") as unknown) instanceof Error);

const sema = new TimedSema(2);
async function task(i: number): Promise<void> {
  await sema.acquire();
  console.log("start", i, "waiting", sema.nrWaiting());
  await new Promise((resolve) => setTimeout(resolve, 5 * i));
  console.log("end", i);
  sema.release();
}

async function main(): Promise<void> {
  await Promise.all([task(1), task(2), task(3), task(4)]);
  console.log("waits", sema.waits, sema instanceof Sema, sema instanceof TimedSema);
}

main();
