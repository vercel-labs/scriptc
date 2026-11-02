/* A generic in-memory repository. Rows live in an insertion-ordered Map;
 * secondary indexes map a derived key to the set of row ids that carry it,
 * so filtered queries start from the smallest candidate set instead of a
 * full scan. Unique indexes reject duplicates on insert and update. */

import { ConflictError, NotFoundError } from "./errors.ts";

export interface Entity {
  readonly id: string;
}

export type KeyOf<T> = (row: T) => string | readonly string[];

export interface IndexSpec<T> {
  readonly name: string;
  readonly key: KeyOf<T>;
  readonly unique?: boolean;
}

export type SortDirection = "asc" | "desc";

export interface SortKey<T> {
  readonly by: (row: T) => string | number;
  readonly direction: SortDirection;
}

export interface Lookup {
  readonly index: string;
  readonly key: string;
}

export interface Query<T> {
  readonly lookups?: readonly Lookup[];
  readonly where?: (row: T) => boolean;
  readonly sort?: readonly SortKey<T>[];
  readonly offset: number;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset: number | null;
}

class SecondaryIndex<T extends Entity> {
  private readonly buckets = new Map<string, Set<string>>();

  readonly spec: IndexSpec<T>;

  constructor(spec: IndexSpec<T>) {
    this.spec = spec;
  }

  keys(row: T): readonly string[] {
    const key = this.spec.key(row);
    return typeof key === "string" ? [key] : key;
  }

  add(row: T): void {
    for (const key of this.keys(row)) {
      let bucket = this.buckets.get(key);
      if (bucket === undefined) {
        bucket = new Set<string>();
        this.buckets.set(key, bucket);
      }
      bucket.add(row.id);
    }
  }

  remove(row: T): void {
    for (const key of this.keys(row)) {
      const bucket = this.buckets.get(key);
      if (bucket === undefined) continue;
      bucket.delete(row.id);
      if (bucket.size === 0) this.buckets.delete(key);
    }
  }

  ids(key: string): ReadonlySet<string> {
    return this.buckets.get(key) ?? EMPTY;
  }

  conflict(row: T): string | null {
    if (this.spec.unique !== true) return null;
    for (const key of this.keys(row)) {
      const bucket = this.buckets.get(key);
      if (bucket === undefined) continue;
      for (const id of bucket) if (id !== row.id) return key;
    }
    return null;
  }

  distinct(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const [key, ids] of this.buckets) counts.set(key, ids.size);
    return counts;
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export function compareBy<T>(keys: readonly SortKey<T>[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key.by(a);
      const y = key.by(b);
      if (x === y) continue;
      const order = x < y ? -1 : 1;
      return key.direction === "asc" ? order : -order;
    }
    return 0;
  };
}

export class Repository<T extends Entity> {
  private readonly rows = new Map<string, T>();
  private readonly indexes = new Map<string, SecondaryIndex<T>>();
  private revisionCounter = 0;

  readonly entity: string;

  constructor(entity: string, specs: readonly IndexSpec<T>[]) {
    this.entity = entity;
    for (const spec of specs) this.indexes.set(spec.name, new SecondaryIndex(spec));
  }

  /** Bumps on every write; list ETags derive from it. */
  get revision(): number {
    return this.revisionCounter;
  }

  get size(): number {
    return this.rows.size;
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  require(id: string): T {
    const row = this.rows.get(id);
    if (row === undefined) throw new NotFoundError(this.entity, id);
    return row;
  }

  all(): IterableIterator<T> {
    return this.rows.values();
  }

  insert(row: T): T {
    if (this.rows.has(row.id)) throw new ConflictError(`${this.entity} ${row.id} already exists`, "id", row.id);
    this.checkUnique(row);
    this.rows.set(row.id, row);
    for (const index of this.indexes.values()) index.add(row);
    this.revisionCounter++;
    return row;
  }

  replace(next: T): T {
    const previous = this.require(next.id);
    this.checkUnique(next);
    for (const index of this.indexes.values()) index.remove(previous);
    this.rows.set(next.id, next);
    for (const index of this.indexes.values()) index.add(next);
    this.revisionCounter++;
    return next;
  }

  delete(id: string): T {
    const row = this.require(id);
    for (const index of this.indexes.values()) index.remove(row);
    this.rows.delete(id);
    this.revisionCounter++;
    return row;
  }

  findBy(index: string, key: string): T[] {
    const out: T[] = [];
    for (const id of this.index(index).ids(key)) {
      const row = this.rows.get(id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  countBy(index: string): Map<string, number> {
    return this.index(index).distinct();
  }

  query(query: Query<T>): Page<T> {
    const matches: T[] = [];
    for (const row of this.candidates(query.lookups ?? [])) {
      if (query.where === undefined || query.where(row)) matches.push(row);
    }
    if (query.sort !== undefined && query.sort.length > 0) matches.sort(compareBy(query.sort));
    const end = Math.min(matches.length, query.offset + query.limit);
    const items = query.offset < matches.length ? matches.slice(query.offset, end) : [];
    return {
      items,
      total: matches.length,
      offset: query.offset,
      limit: query.limit,
      nextOffset: end < matches.length ? end : null,
    };
  }

  private candidates(lookups: readonly Lookup[]): Iterable<T> {
    if (lookups.length === 0) return this.rows.values();
    // Intersect starting from the smallest bucket; keep insertion order by
    // walking the row map when the intersection is still large.
    const sets = lookups.map((lookup) => this.index(lookup.index).ids(lookup.key));
    sets.sort((a, b) => a.size - b.size);
    const smallest = sets[0]!;
    const rest = sets.slice(1);
    const ordered: T[] = [];
    if (smallest.size * 4 < this.rows.size) {
      const ids: string[] = [];
      for (const id of smallest) if (rest.every((set) => set.has(id))) ids.push(id);
      ids.sort((a, b) => this.order(a) - this.order(b));
      for (const id of ids) ordered.push(this.rows.get(id)!);
      return ordered;
    }
    for (const row of this.rows.values()) {
      if (smallest.has(row.id) && rest.every((set) => set.has(row.id))) ordered.push(row);
    }
    return ordered;
  }

  private order(id: string): number {
    // Ids carry their insertion sequence as a zero-padded suffix.
    return Number(id.slice(id.lastIndexOf("_") + 1));
  }

  private index(name: string): SecondaryIndex<T> {
    const index = this.indexes.get(name);
    if (index === undefined) throw new Error(`${this.entity} has no index ${name}`);
    return index;
  }

  private checkUnique(row: T): void {
    for (const index of this.indexes.values()) {
      const key = index.conflict(row);
      if (key !== null) {
        throw new ConflictError(`${this.entity} with ${index.spec.name} ${key} already exists`, index.spec.name, key);
      }
    }
  }
}
