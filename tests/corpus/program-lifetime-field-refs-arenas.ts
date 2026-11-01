import type { ProgramLifetime } from "@scriptc/types";

// ProgramLifetime classes built inside a call region, whose arena supplies
// the arrays, sets, maps and instances their compact fields hold: reads
// through those fields must see the same objects wherever the arena's
// memory comes from. Each round keeps only numbers, so the round's objects
// die with the region.

class Part {
  id: number;
  label: string;
  constructor(id: number, label: string) {
    this.id = id;
    this.label = label;
  }
}

class Group implements ProgramLifetime {
  readonly parts: Part[] = [];
  readonly nums: number[] = [];
  readonly names = new Set<string>();
  readonly counts = new Map<string, number>();
  rows: number[][] | undefined = undefined;
  first: Part | undefined = undefined;
  readonly key: string;
  constructor(key: string) {
    this.key = key;
  }
}

function round(i: number): number {
  const g = new Group(`g${i % 7}`);
  for (let k = 0; k < 4; k++) g.parts.push(new Part(i * 4 + k, `p${k}`));
  g.first = g.parts[0];
  g.nums.push(i, i + 1, i + 2);
  g.names.add(`n${i % 5}`);
  g.counts.set("i", i);
  g.counts.set("twice", i * 2);
  g.rows = [g.nums, [i, i + 1]];
  let sum = g.key.length + g.nums.length + g.parts.length + g.names.size;
  for (const p of g.parts) sum += p.id + p.label.length;
  for (const v of g.counts.values()) sum += v;
  for (const row of g.rows) for (const v of row) sum += v;
  sum += g.parts[1]!.id + g.nums[2]!;
  return sum;
}

function build(rounds: number): number {
  let sum = 0;
  for (let i = 0; i < rounds; i++) sum += round(i);
  return sum;
}

console.log(build(600));
