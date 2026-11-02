/* An append-only event log with a bounded history and live subscribers.
 * The change feed replays history after a cursor and then follows new
 * events until the caller's limit is reached. */

export interface Sequenced<E> {
  readonly seq: number;
  readonly event: E;
}

export type Listener<E> = (entry: Sequenced<E>) => void;

export class EventLog<E> {
  private readonly entries: Sequenced<E>[] = [];
  private readonly listeners = new Set<Listener<E>>();
  private nextSeq = 1;

  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  append(event: E): Sequenced<E> {
    const entry: Sequenced<E> = { seq: this.nextSeq++, event };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  since(cursor: number, max: number): Sequenced<E>[] {
    const out: Sequenced<E>[] = [];
    for (const entry of this.entries) {
      if (entry.seq <= cursor) continue;
      out.push(entry);
      if (out.length >= max) break;
    }
    return out;
  }

  subscribe(listener: Listener<E>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves with the next `count` events after `cursor`, waiting for live
   * appends when history runs out. */
  async *follow(cursor: number, count: number): AsyncGenerator<Sequenced<E>, void, undefined> {
    let seen = cursor;
    let remaining = count;
    while (remaining > 0) {
      const batch = this.since(seen, remaining);
      for (const entry of batch) {
        yield entry;
        seen = entry.seq;
        remaining--;
      }
      if (remaining === 0) return;
      await this.next(seen);
    }
  }

  private next(after: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const stop = this.subscribe((entry) => {
        if (entry.seq > after) {
          stop();
          resolve();
        }
      });
    });
  }
}
