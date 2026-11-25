// @requires-icu
// @env: LC_ALL=en_US.UTF-8,TZ=UTC
// The errors of the Intl.NumberFormat constructor, as Node raises them:
// the RangeError of a value outside an option's set or range, the
// TypeErrors of a missing currency or unit and of null options, with V8's
// message texts (an invalid currency code or unit is printed byte by byte,
// as V8 prints it), and which error comes first when several options are
// wrong. Options that are not objects read as no options.
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

function errors(): void {
  function nf(options: unknown): string {
    return new Intl.NumberFormat("en-US", options as Intl.NumberFormatOptions).format(1234.5678);
  }
  attempt("style bad", () => nf({ style: "foo" }));
  attempt("style number", () => nf({ style: 5 }));
  attempt("currency missing", () => nf({ style: "currency" }));
  attempt("currency bad", () => nf({ style: "currency", currency: "US" }));
  attempt("currency lower", () => nf({ style: "currency", currency: "usd" }));
  attempt("currency number", () => nf({ style: "currency", currency: 123 }));
  attempt("currency four", () => nf({ style: "currency", currency: "USDX" }));
  attempt("currency accent", () => nf({ style: "currency", currency: "USé" }));
  attempt("currency ignored bad", () => nf({ currency: "x" }));
  attempt("unit missing", () => nf({ style: "unit" }));
  attempt("unit bad", () => nf({ style: "unit", unit: "parsec" }));
  attempt("unit upper", () => nf({ style: "unit", unit: "Meter" }));
  attempt("unit per bad", () => nf({ style: "unit", unit: "kilometer-per-parsec" }));
  attempt("unit per per", () => nf({ style: "unit", unit: "meter-per-second-per-second" }));
  attempt("unit ignored bad", () => nf({ unit: "parsec" }));
  attempt("unit accent", () => nf({ unit: "mètre" }));
  attempt("mxfd range", () => nf({ maximumFractionDigits: 101 }));
  attempt("mxfd negative", () => nf({ maximumFractionDigits: -1 }));
  attempt("mnfd above mxfd", () => nf({ minimumFractionDigits: 3, maximumFractionDigits: 1 }));
  attempt("mnsd range", () => nf({ minimumSignificantDigits: 0 }));
  attempt("mxsd below mnsd", () => nf({ minimumSignificantDigits: 3, maximumSignificantDigits: 2 }));
  attempt("mnid range", () => nf({ minimumIntegerDigits: 22 }));
  attempt("mxfd NaN", () => nf({ maximumFractionDigits: NaN }));
  attempt("mxfd string", () => nf({ maximumFractionDigits: "2" }));
  attempt("mxfd 2.9", () => nf({ maximumFractionDigits: 2.9 }));
  attempt("mxfd null", () => nf({ maximumFractionDigits: null }));
  attempt("mxfd true", () => nf({ maximumFractionDigits: true }));
  attempt("notation bad", () => nf({ notation: "x" }));
  attempt("compactDisplay bad", () => nf({ compactDisplay: "x" }));
  attempt("signDisplay bad", () => nf({ signDisplay: "x" }));
  attempt("useGrouping bad", () => nf({ useGrouping: "x" }));
  attempt("useGrouping 0", () => nf({ useGrouping: 0 }));
  attempt("useGrouping null", () => nf({ useGrouping: null }));
  attempt("useGrouping 1", () => nf({ useGrouping: 1 }));
  attempt("useGrouping empty", () => nf({ useGrouping: "" }));
  attempt("roundingMode bad", () => nf({ roundingMode: "x" }));
  attempt("roundingIncrement bad", () => nf({ roundingIncrement: 3 }));
  attempt("roundingIncrement range", () => nf({ roundingIncrement: 5001 }));
  attempt("roundingIncrement sig", () => nf({ roundingIncrement: 5, maximumSignificantDigits: 2 }));
  attempt("roundingIncrement fd", () => nf({ roundingIncrement: 5, minimumFractionDigits: 1, maximumFractionDigits: 2 }));
  attempt("roundingIncrement ok", () => nf({ roundingIncrement: 5, minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  attempt("roundingIncrement default digits", () => nf({ roundingIncrement: 5 }));
  attempt("roundingIncrement priority", () => nf({ roundingIncrement: 5, roundingPriority: "morePrecision" }));
  attempt("roundingPriority bad", () => nf({ roundingPriority: "x" }));
  attempt("trailingZeroDisplay bad", () => nf({ trailingZeroDisplay: "x" }));
  attempt("localeMatcher bad", () => nf({ localeMatcher: "x" }));
  attempt("numberingSystem bad", () => nf({ numberingSystem: "x" }));
  attempt("numberingSystem long", () => nf({ numberingSystem: "abcdefghi" }));
  attempt("currencyDisplay bad", () => nf({ currencyDisplay: "x" }));
  attempt("currencySign bad", () => nf({ currencySign: "x" }));
  attempt("unitDisplay bad", () => nf({ unitDisplay: "x" }));
  attempt("value accent", () => nf({ style: "décimal" }));
  attempt("options null", () => nf(null));
  attempt("options number", () => nf(5));
  attempt("options string", () => nf("x"));
  attempt("options true", () => nf(true));
  attempt("options array", () => nf([1, 2]));
  attempt("first error wins", () => nf({ style: "foo", currency: "x", notation: "y" }));
  attempt("currency before notation", () => nf({ currency: "x", notation: "y" }));
  attempt("digits before grouping", () => nf({ useGrouping: "x", maximumFractionDigits: 200 }));
  attempt("toLocaleString style bad", () => (1234.5).toLocaleString("en-US", { style: "foo" as "decimal" }));
  attempt("toLocaleString null", () => (1234.5).toLocaleString("en-US", null as unknown as Intl.NumberFormatOptions));
  attempt("call null", () => Intl.NumberFormat("en-US", null as unknown as Intl.NumberFormatOptions).format(1));
}

errors();
