// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// A formatter is a value: held at module level, in a record, an array, a
// Map and a class field, passed to and returned from functions, compared
// by identity, kept behind `unknown`, and called through optional chains.

// Held by the module, used from the functions below.
const distance = new Intl.NumberFormat("en-US", {
  style: "unit",
  unit: "kilometer",
  unitDisplay: "long",
  maximumFractionDigits: 0,
});
const tally = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "long",
  maximumSignificantDigits: 3,
});
const dawn = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  dayPeriod: "long",
  timeZone: "UTC",
});

class Report {
  private readonly weight = new Intl.NumberFormat("en-US", { style: "unit", unit: "kilogram" });
  static readonly padded = new Intl.NumberFormat("en-US", { minimumIntegerDigits: 3, useGrouping: false });
  line(n: number): string {
    return this.weight.format(n) + " / " + Report.padded.format(n);
  }
}

function leg(km: number, walkers: number): string {
  return distance.format(km) + ", " + tally.format(walkers);
}

function moduleLevel(): void {
  console.log(leg(41.8, 1234567), "|", dawn.format(new Date(1e12)));
  console.log([0, 999, 1000, 15300].map((n) => tally.format(n)).join(" | "));
}

function numberFormatters(): void {
  const share = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
  const rough = new Intl.NumberFormat("en-US", { notation: "engineering", maximumSignificantDigits: 3 });
  interface Column { label: string; nf: Intl.NumberFormat }
  const columns: Column[] = [
    { label: "pct", nf: share },
    { label: "eng", nf: rough },
    { label: "liters", nf: new Intl.NumberFormat("en-US", { style: "unit", unit: "liter", unitDisplay: "long" }) },
  ];
  function render(value: number, nf: Intl.NumberFormat): string {
    return nf.format(value);
  }
  function pick(coarse: boolean): Intl.NumberFormat {
    return coarse ? rough : share;
  }
  for (const column of columns) console.log(column.label, column.nf.format(12345.678), render(0.25, column.nf));
  console.log(pick(true).format(1e7), pick(false).format(0.123));
  console.log(new Report().line(1234.5678));
  console.log([1, 22.5, 333.33].map((n) => share.format(n)).join(","));
  const byName = new Map<string, Intl.NumberFormat>([["p", share], ["c", rough]]);
  console.log(byName.get("c")?.format(98765), byName.get("p") === share, share === rough);
  let lazy: Intl.NumberFormat | undefined;
  function shared(): Intl.NumberFormat {
    lazy ??= new Intl.NumberFormat("en-US", { minimumFractionDigits: 1 });
    return lazy;
  }
  console.log(shared().format(2), shared() === shared());
  console.log(share.format(0.5), share.format(NaN), rough.format(-0));
  console.log(new Intl.NumberFormat("en-US").format(1234.5), new Intl.NumberFormat("en").format(1234.5), Intl.NumberFormat("en-US").format(0.1));
  const holder = { nf: share };
  console.log(holder.nf.format(0.07));
}

function optionalChains(): void {
  const byName = new Map<string, Intl.NumberFormat>([["c", new Intl.NumberFormat("en-US", { notation: "scientific" })]]);
  console.log(byName.get("c")?.format(98765), byName.get("missing")?.format(1));
  let maybe: Intl.NumberFormat | undefined;
  console.log(maybe?.format(1));
  maybe = new Intl.NumberFormat("en-US", { style: "percent" });
  console.log(maybe?.format(0.5), maybe.format(0.25));
  function show(f: Intl.DateTimeFormat | null, ms: number): string {
    return f?.format(ms) ?? "none";
  }
  console.log(show(null, 0), show(new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }), 0));
  const holder: { nf?: Intl.NumberFormat } = {};
  console.log(holder.nf?.format(2));
  holder.nf = maybe;
  console.log(holder.nf?.format(2), holder.nf!.format(3));
}

function observed(): void {
  const nf = new Intl.NumberFormat("en-US", { style: "percent" });
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });
  console.log(typeof nf, typeof dtf, nf === nf, (nf as unknown) === (dtf as unknown));
  const held: unknown = nf;
  console.log(held === nf, typeof held, held !== null);
  const list: unknown[] = [nf, dtf];
  console.log(list.length, list[0] === nf, list.indexOf(dtf));
  const m = new Map<Intl.NumberFormat, string>([[nf, "pct"]]);
  console.log(m.get(nf), m.has(new Intl.NumberFormat("en-US")));
  console.log((held as Intl.NumberFormat).format(0.25));
}

numberFormatters();
optionalChains();
observed();
moduleLevel();
