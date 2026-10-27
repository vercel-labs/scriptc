// Untyped async methods of a package, reached through the package's own
// untyped callers and prototype reflection, and overridden by a typed
// subclass. An async generator method called from the package answers its
// generator object.
import { Pool, Schema, limiter, listIssues, prototypeNames, validateAll } from "token-pool";

class CountingPool extends Pool {
  acquired = 0;
  async acquire(): Promise<void> {
    await super.acquire();
    this.acquired++;
  }
}

async function main(): Promise<void> {
  const pool = new CountingPool(1);
  await pool.acquire();
  const waiting = pool.acquire();
  console.log("waiting", pool.nrWaiting());
  pool.release("t");
  await waiting;
  console.log("acquired", pool.acquired, pool.nrWaiting());
  const base = new Pool(1);
  console.log("token", await base.acquire());
  const run = limiter(1);
  console.log(await Promise.all([run(async () => 1), run(async () => 2)]));
  const schema = new Schema((value) => typeof value === "number");
  console.log(await validateAll(schema, [1, "x", 3]));
  console.log(await listIssues(schema, ["p", 5, "q"]));
  console.log(await schema.parseAsync(4));
  try {
    await schema.parseAsync("y");
  } catch (e) {
    console.log("rejected", e instanceof Error ? e.message : String(e));
  }
  console.log(prototypeNames());
}
main();
