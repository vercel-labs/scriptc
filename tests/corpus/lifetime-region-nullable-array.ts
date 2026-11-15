// LifetimeRegion (@scriptc/experimental) over arrays and fields of a nullable
// ProgramLifetime class. An element read with a variable index comes back
// widened to `C | null | undefined`, which spells `null` with the module's
// static sentinel object; the read narrows back to the slot type, retaining
// and releasing that sentinel on the way. A region instance counts its
// references per chunk and has no header word to test immortality in, so its
// retain and release skip the sentinel explicitly, and the release walk skips
// every immortal value it is handed. Node.js runs the same program unchanged.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Disk implements ProgramLifetime {
  readonly size: number;
  next: Disk | null | undefined = null;
  constructor(size: number) {
    this.size = size;
  }
}

class Piles {
  slots: (Disk | null)[] = [null, null, null];
  moves = 0;

  push(disk: Disk, pile: number): void {
    const top = this.slots[pile];
    disk.next = top;
    this.slots[pile] = disk;
  }
  pop(pile: number): Disk | null {
    const top = this.slots[pile];
    if (top === null) return null;
    this.slots[pile] = top.next ?? null;
    top.next = null;
    return top;
  }
}

function main(): void {
  const region = new LifetimeRegion();
  const report = region.run(() => {
    const piles = new Piles();
    for (let size = 3; size > 0; size--) piles.push(new Disk(size), size % 3);
    piles.moves++;
    const moved = piles.pop(0);
    if (moved === null) throw new Error("expected a disk");
    piles.push(moved, 2);

    // A widened element read of a nullable slot, and a side table typed
    // `Disk | null | undefined`: both carry the null sentinel.
    const readBack = piles.slots[2];
    const side: (Disk | null | undefined)[] = [moved, null, undefined];
    let total = 0;
    for (const disk of side) if (disk != null) total += disk.size;
    for (let i = 0; i < piles.slots.length; i++) {
      const top = piles.slots[i];
      if (top != null) total += top.size * (i + 1);
    }
    const empty = piles.slots[1];
    return {
      sizes: total,
      top: readBack === null ? -1 : readBack.size,
      hole: empty === null,
      moves: piles.moves,
    };
  });
  region.release();
  console.log(JSON.stringify(report));
}
main();
