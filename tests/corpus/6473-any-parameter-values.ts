// Function values whose defaulted parameter the checker types `any`: under
// an `(...args: any[]) => any` wrapper slot the contextual `any` wins over
// the default's type. The callable's slot is the checked-dynamic value the
// body already reads.
function traced<F extends (...args: any[]) => any>(name: string, fn: F): F {
  console.log("wrap", name);
  return fn;
}

function configured(raw = process.env["SCRIPTC_TEST_UNSET_WIDTH"]): number | undefined {
  const width = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(width) && width > 0 ? width : undefined;
}

const layout = traced("layout", (width = configured() ?? 80) => {
  return { width, gutter: 2 };
});
console.log(JSON.stringify(layout()), JSON.stringify(layout(120)));

const scaled = traced("scaled", function (factor = 2, base = 10) {
  return base * factor;
});
console.log(scaled(), scaled(3), scaled(undefined, 1));
