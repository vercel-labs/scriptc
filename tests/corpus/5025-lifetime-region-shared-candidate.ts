// LifetimeRegion (@scriptc/experimental): freeing a region whose objects
// own a cycle runs a limited cycle pass over what the region owned. That
// pass also reaches a shared object the region pointed at, which is a
// candidate of its own (it lost a reference) and stays referenced from
// outside. The shared object must stay a valid candidate after the pass:
// it dies afterwards, later passes run, and the program prints the same
// as under Node.js.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Shared {
  readonly label: string;
  peers: Shared[] = [];
  constructor(label: string) {
    this.label = label;
  }
}

// Ordinary objects the region's instance owns: a cycle that points back
// into the region and at the shared object.
class Owned {
  holder: Holder | undefined = undefined;
  shared: Shared | undefined = undefined;
  partner: Owned | undefined = undefined;
}

class Holder implements ProgramLifetime {
  owned: Owned | undefined = undefined;
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

// Cyclic garbage, so the collector runs passes of its own.
class Ring {
  next: Ring | undefined = undefined;
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function churn(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = new Ring(i);
    const b = new Ring(i + 1);
    a.next = b;
    b.next = a;
    total += a.value + b.next.value;
  }
  return total;
}

function round(k: number): string {
  let shared: Shared | undefined = new Shared(`shared ${k}`);
  // A second reference, dropped below: the shared object becomes a candidate.
  let keep: Shared[] = [shared];
  shared.peers.push(new Shared(`peer ${k}`));
  const region = new LifetimeRegion();
  region.run(() => {
    const holder = new Holder(k);
    const owned = new Owned();
    const partner = new Owned();
    owned.partner = partner;
    partner.partner = owned;
    owned.holder = holder;
    owned.shared = shared;
    holder.owned = owned;
  });
  keep = [];
  region.release();
  const label = shared.label + " / " + shared.peers[0]!.label + " / " + keep.length;
  // The shared object dies, and the passes that follow read the candidate buffers.
  shared = undefined;
  churn(2000);
  return label;
}

for (let k = 0; k < 20; k++) {
  const label = round(k);
  if (k % 5 === 0) console.log(label);
}
console.log("churn", churn(10000));
