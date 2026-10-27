// TypeScript overrides of an untyped JavaScript base: a typed async
// override over an untyped method, and a narrowed toString.
import { Pool } from "./pool.js";

class MeteredPool extends Pool {
  waits = 0;
  override async acquire(): Promise<number> {
    this.waits++;
    const n: number = await super.acquire();
    return n * 10;
  }
  override toString(): string {
    return `Metered(${this.waits})`;
  }
}
async function main(): Promise<void> {
  const pools: Pool[] = [new Pool(2), new MeteredPool(3)];
  for (const pool of pools) {
    const got = await pool.acquire();
    console.log(String(got), pool.toString(), `${pool}`);
    pool.release();
  }
  const metered = new MeteredPool(1);
  console.log(await metered.acquire(), metered.waits);
}
main();
