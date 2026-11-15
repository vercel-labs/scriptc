// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// Intl.NumberFormat objects over ICU: every style with its currency and
// unit displays, and the notations, alone and with digit options, a
// percentage and a currency. The options are read at run time by ECMA-402's
// steps; each row formats the same thirty numbers, zero, negative zero, NaN
// and the infinities among them.
const VALUES: number[] = [0, -0, 1, -1, 0.5, 1.005, 1234.5678, -1234567.891, 0.000123, 1e21, 123456789012345680000, NaN, Infinity, -Infinity, 0.045, 99.995, 1e-7, 5, 1500, 999999, 1000000, 1.5e9, 0.1 + 0.2, 12, 0.999, 2.5, 3.5, -2.5, 1e6, 0.00001234];
function row(label: string, f: Intl.NumberFormat): void {
  console.log(label + ": " + VALUES.map((v) => f.format(v)).join(" | "));
}
function attempt(label: string, make: () => string): void {
  try {
    console.log(label + " => " + make());
  } catch (e) {
    const err = e as Error;
    console.log(label + " !! " + err.name + ": " + err.message);
  }
}

function styles(): void {
  row("default", new Intl.NumberFormat("en-US"));
  row("decimal", new Intl.NumberFormat("en-US", { style: "decimal" }));
  row("percent", new Intl.NumberFormat("en-US", { style: "percent" }));
  for (const currency of ["USD", "EUR", "JPY", "KWD", "XQZ", "usd"]) {
    for (const currencyDisplay of ["symbol", "code", "name", "narrowSymbol"] as const) {
      row(currency + " " + currencyDisplay, new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay }));
    }
    row(currency + " accounting", new Intl.NumberFormat("en-US", { style: "currency", currency, currencySign: "accounting" }));
  }
  for (const unit of ["kilometer-per-hour", "byte", "celsius", "percent", "liter", "mile-scandinavian", "megabyte-per-second", "day"]) {
    for (const unitDisplay of ["short", "narrow", "long"] as const) {
      row(unit + " " + unitDisplay, new Intl.NumberFormat("en-US", { style: "unit", unit, unitDisplay }));
    }
  }
}

function notations(): void {
  for (const notation of ["standard", "scientific", "engineering", "compact"] as const) {
    row(notation, new Intl.NumberFormat("en-US", { notation }));
    row(notation + " mxfd 1", new Intl.NumberFormat("en-US", { notation, maximumFractionDigits: 1 }));
    row(notation + " sig 3", new Intl.NumberFormat("en-US", { notation, maximumSignificantDigits: 3 }));
    row(notation + " percent", new Intl.NumberFormat("en-US", { notation, style: "percent" }));
    row(notation + " USD", new Intl.NumberFormat("en-US", { notation, style: "currency", currency: "USD" }));
  }
  row("compact long", new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "long" }));
  row("compact long unit", new Intl.NumberFormat("en-US", { notation: "compact", compactDisplay: "long", style: "unit", unit: "byte", unitDisplay: "long" }));
  row("compact mnfd 2", new Intl.NumberFormat("en-US", { notation: "compact", minimumFractionDigits: 2 }));
  row("compact grouping always", new Intl.NumberFormat("en-US", { notation: "compact", useGrouping: "always" }));
  row("standard compactDisplay long", new Intl.NumberFormat("en-US", { compactDisplay: "long" }));
}

styles();
notations();
