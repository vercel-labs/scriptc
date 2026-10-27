import type { Emitted, Sealed, Totals } from "./emitted.ts";

export class Holder {
  items: Emitted | undefined = undefined;
  sealed: Sealed | undefined = undefined;
  history: Emitted[] = [];
  totals: Totals = { emitted: 0, skipped: 0 };
  record(result: Emitted): void {
    this.items = result;
    this.history.push(result);
    this.totals.emitted += result.count;
  }
}
