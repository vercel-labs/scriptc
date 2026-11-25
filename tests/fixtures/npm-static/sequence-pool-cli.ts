import { makePool } from "sequence-pool";

for (const typed of [true, false]) {
  const pool = makePool(typed);
  console.log(`typed=${typed} head=${pool.head().join(",")} checksum=${pool.checksum()}`);
  pool.rebuild();
  pool.rebuild();
  console.log(`typed=${typed} head=${pool.head().join(",")} checksum=${pool.checksum()}`);
}
