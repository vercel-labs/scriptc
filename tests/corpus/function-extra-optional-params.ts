// A function value with MORE parameters than the slot it flows into:
// TypeScript admits the assignment when the extra trailing parameters are
// optional, and a JavaScript caller simply leaves them undefined. The
// lowering forwards the slot's arguments and supplies undefined for the
// extras. The program also covers both legal parameter-variance directions
// for `string | undefined` and `string` (the widening function-type
// direction and the narrowing bivariant method-parameter direction; the
// narrowing function-type direction is a TypeScript error, not a scriptc
// one).
//
// The converted values are callback PARAMETERS (the shape a library hands
// to another slot), because a fresh function literal with optional
// parameters carries its own completed signature at birth.

type Done = (selectedValue?: string) => void;
type DoneWithOptions = (
  selectedValue?: string,
  options?: { navigateTo?: string },
) => void;

function doneString(label: string, done: Done): void {
  done(label);
}

function doneNothing(run: Done): void {
  run();
}

function donePlain(callback: (value: string) => void): void {
  callback("plain");
}

// 1. A callback parameter with an extra optional record parameter forwarded
// into a one-parameter slot, invoked with and without an argument.
function forwardOptions(done: DoneWithOptions): void {
  doneString("one", done);
  doneNothing(done);
}
forwardOptions((selectedValue, options) => {
  console.log(
    "forwarded",
    selectedValue ?? "none",
    options === undefined ? "absent" : (options.navigateTo ?? "no-target"),
  );
});

// 2. The same value created under its own two-parameter type, then named and
// forwarded later.
const named: DoneWithOptions = function (selectedValue, options) {
  console.log(
    "named",
    selectedValue ?? "none",
    options === undefined ? "absent" : (options.navigateTo ?? "no-target"),
  );
};
forwardOptions(named);

// 3. Several extra optional parameters of different representations.
type Wide = (value: string, count?: number, name?: string, options?: { flag?: boolean }) => void;

function forwardWide(callback: Wide): void {
  donePlain(callback);
}
forwardWide((value, count, name, options) => {
  console.log("many", value, count === undefined, name === undefined, options === undefined);
});

// 4. The slot's parameter also needs a widening conversion into the callee's
// `string | undefined`.
type WidenExtra = (value: string | undefined, extra?: number) => void;

function forwardWidenExtra(callback: WidenExtra): void {
  donePlain(callback);
}
forwardWidenExtra((value, extra) => {
  console.log("widen-extra", value ?? "none", extra === undefined ? "no-extra" : extra);
});

// 5. An object field holding the converted callback.
interface Settings {
  onApply: (value: string) => void;
}
function makeSettings(callback: (value: string, count?: number) => void): Settings {
  return { onApply: callback };
}
const settings = makeSettings((value, count) => {
  console.log("field", value, count === undefined ? "no-count" : count);
});
settings.onApply("five");

// 6. An optional callback field.
interface OptionalSlot {
  onDone?: (value?: string) => void;
}
function makeOptional(callback: (value: string | undefined, target?: string) => void): OptionalSlot {
  return { onDone: callback };
}
const optional = makeOptional((value, target) => {
  console.log("optional", value ?? "none", target === undefined ? "no-target" : target);
});
optional.onDone?.("six");

// 7. Class methods passed as callbacks: one widens its parameter to the
// slot's `string`, the other has an extra optional parameter.
class Handler {
  widen(value: string | undefined): void {
    console.log("method-widen", value ?? "none");
  }
  extra(value: string, detail?: { level: number }): void {
    console.log("method-extra", value, detail === undefined ? "no-detail" : detail.level);
  }
}
const handler = new Handler();
donePlain(handler.widen);
donePlain(handler.extra);

// 8. An extra optional checked-dynamic parameter.
function withAny(value: string, meta?: any): void {
  console.log("any-extra", value, meta === undefined ? "absent" : "present");
}
donePlain(withAny);

// 9. The narrowing parameter direction in a bivariant method-parameter
// position: a `(value: string) => void` implementation in a slot declared
// `(value: string | undefined) => void`.
interface Options {
  onChange(value: string | undefined): void;
}
const narrowing: Options = {
  onChange: (value: string) => {
    console.log("narrow", value);
  },
};
narrowing.onChange("nine");

// 10. The control that already worked: fewer source parameters than the
// slot, whose surplus arguments JavaScript ignores.
function takesThree(callback: (a: string, b: number, c: boolean) => void): void {
  callback("fewer", 1, true);
}
takesThree((a: string) => {
  console.log("fewer", a);
});

export {};
