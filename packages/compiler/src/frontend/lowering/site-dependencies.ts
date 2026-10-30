import type * as ts from "../ts7/adapter.js";

/** The facts each site of a fixed-point scan read on its last visit, so that
 * a pass visits again only the sites whose facts changed since.
 *
 * Sites are numbered from 0. A fact is any value usable as a Map key: a
 * symbol, a syntax node, or a string that names a derived fact. A visit
 * reports what it reads (`read`). When a visit changes a fact, every site
 * that read one of the facts this visit read is visited again: the facts a
 * visit changes belong to what it read. Facts changed outside a visit, or
 * not read before they change, are reported with `changed`.
 *
 * A site that is not visited again would compute what its last visit
 * computed, as long as every fact it reads is reported. The scan confirms
 * that with a pass over every site once a pass changes nothing, and resumes
 * when that pass changes a fact: a fact this tracking misses costs passes,
 * not a different result. */
/** A fact a site reads: a symbol, a syntax node, or the name of a derived
 * fact. A typed union keeps nodes and symbols native values; as `unknown`
 * every syntax node would become a dynamic value. */
export type SiteFact = ts.Node | ts.Symbol | string;

export class SiteDependencies {
  /** Each fact's entry: the visit that last read it, so that a visit lists a
   * fact once, followed by the sites that read it, ascending. */
  private readonly readers = new Map<SiteFact, number[]>();
  private readonly stale: Uint8Array;
  private site = -1;
  private visit = 0;
  private facts: SiteFact[] = [];

  constructor(siteCount: number) {
    this.stale = new Uint8Array(siteCount);
  }

  /** A fact that site `index` read changed since its last visit. */
  isStale(index: number): boolean {
    return this.stale[index] === 1;
  }

  /** Starts a visit of site `index`. */
  begin(index: number): void {
    this.site = index;
    this.visit++;
    this.stale[index] = 0;
    this.facts = [];
  }

  /** Ends the visit; `changed` when it changed a fact. */
  end(changed: boolean): void {
    this.site = -1;
    if (changed) for (const fact of this.facts) this.changed(fact);
  }

  /** The site being visited read `fact`. */
  read(fact: SiteFact): void {
    if (this.site < 0) return;
    const entry = this.readers.get(fact);
    if (entry === undefined) {
      this.readers.set(fact, [this.visit, this.site]);
      this.facts.push(fact);
      return;
    }
    if (entry[0] === this.visit) return;
    entry[0] = this.visit;
    this.facts.push(fact);
    // A pass visits sites in ascending order, so a site is new at the end;
    // a site visited again is usually listed already.
    const site = this.site;
    let low = 1;
    let high = entry.length;
    if (entry[high - 1]! < site) low = high;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entry[middle]! < site) low = middle + 1;
      else high = middle;
    }
    if (entry[low] !== site) entry.splice(low, 0, site);
  }

  /** `fact` changed: every site that read it is visited again. */
  changed(fact: SiteFact): void {
    const entry = this.readers.get(fact);
    if (entry !== undefined) for (let i = 1; i < entry.length; i++) this.stale[entry[i]!] = 1;
  }
}
