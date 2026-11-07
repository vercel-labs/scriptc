// An empty record with a numeric index signature satisfies a record whose
// members are optional: TypeScript accepts the call, and a member the
// object never had reads undefined rather than stopping the program.

interface WidthOptions {
  width?: number;
  columns?: number;
}

function report(options: WidthOptions): string {
  return [
    `${options.width === undefined ? "unset" : options.width}`,
    `${options.columns ?? "no-columns"}`,
  ].join(" ");
}

function read(options: WidthOptions): string {
  return report(options);
}

const empty: Record<string, number> = {};
console.log(read(empty));

const widthOnly: Record<string, number> = { width: 80 };
console.log(read(widthOnly));

// The signature value can be a record: an optional member of that type
// reads the key when the object holds it and undefined when it does not.
interface Span {
  start: number;
  end: number;
}

function describeSpan(slot: { first?: Span }): string {
  return slot.first === undefined ? "none" : `${slot.first.start}-${slot.first.end}`;
}

function readSpan(source: Record<string, Span>): string {
  return describeSpan(source);
}

const spans: Record<string, Span> = { first: { start: 1, end: 4 } };
console.log(readSpan(spans));

const noSpans: Record<string, Span> = {};
console.log(readSpan(noSpans));

// Through a projection, a member the source object never held stays absent
// and one it holds stays present, as `in` and Object.hasOwn observe on the
// source itself.
function toWidth(options: WidthOptions): WidthOptions {
  return options;
}
const fromEmpty = toWidth(empty);
console.log(
  "width" in fromEmpty,
  Object.hasOwn(fromEmpty, "width"),
  fromEmpty.width === undefined,
);
const fromWidth = toWidth(widthOnly);
console.log(
  "width" in fromWidth,
  Object.hasOwn(fromWidth, "width"),
  "columns" in fromWidth,
  fromWidth.width,
);
