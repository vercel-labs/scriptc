// RC stress for record-element arrays: heavy churn through push/pop/set,
// aliased elements across arrays, records owning arrays owning records,
// and elements escaping into locals that outlive the array. The sanitized
// lane (ASan + RC audit) asserts everything is freed exactly once.
interface Item {
  key: string;
  hits: number;
}

function churn(rounds: number): number {
  const pool: Item[] = [];
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    pool.push({ key: `k${i}`, hits: i });
    if (i % 3 === 0 && pool.length > 1) {
      const dropped = pool.pop();
      if (dropped === undefined) continue;
      acc += dropped.hits;
    }
    if (i % 5 === 0 && pool.length > 0) {
      pool[0] = { key: `swap${i}`, hits: i * 2 }; // replace releases the old head
    }
  }
  for (const it of pool) acc += it.hits;
  return acc;
}
console.log(churn(200));

// Aliasing across arrays: the same record owned by two arrays at once.
function alias(rounds: number): number {
  let survivorHits = 0;
  for (let i = 0; i < rounds; i++) {
    const a: Item[] = [{ key: "shared", hits: i }];
    const b: Item[] = [];
    b.push(a[0]);
    a.pop();
    const survivor = b[0]; // still alive through b
    survivor.hits += 1;
    survivorHits = survivor.hits;
  }
  return survivorHits;
}
console.log(alias(150));

// Deep ownership chains: record -> array -> record -> array.
interface Branch {
  label: string;
  leaves: Item[];
}
function deep(rounds: number): number {
  let n = 0;
  for (let i = 0; i < rounds; i++) {
    const forest: Branch[] = [];
    for (let j = 0; j < 5; j++) {
      forest.push({ label: `b${j}`, leaves: [{ key: `l${j}`, hits: j }] });
    }
    const grabbed = forest[2].leaves[0]; // escapes its branch
    forest.pop();
    n = grabbed.hits + forest.length;
  }
  return n;
}
console.log(deep(150));
console.log("done");
