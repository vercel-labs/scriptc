// Overrides that narrow an `any`-typed base result: a typed async override
// over an untyped base method, and a sync override returning a union.
class Pool {
  name = "pool";
  acquire(): any {
    return Promise.resolve("base");
  }
  describe(): any {
    return this.name;
  }
}
class MeteredPool extends Pool {
  waits = 0;
  override async acquire(): Promise<void> {
    this.waits++;
    await super.acquire();
  }
  override describe(): string | undefined {
    return this.waits > 1 ? `metered ${this.waits}` : undefined;
  }
}
async function use(pool: Pool, label: string): Promise<void> {
  const got = await pool.acquire();
  console.log(label, got === undefined ? "undefined" : got, String(pool.describe()));
}
async function main(): Promise<void> {
  const metered = new MeteredPool();
  await use(new Pool(), "plain");
  await use(metered, "metered");
  await metered.acquire();
  console.log(metered.waits, metered.describe());
  const pools: Pool[] = [new Pool(), metered];
  for (const p of pools) console.log(typeof p.describe());
}
main();
