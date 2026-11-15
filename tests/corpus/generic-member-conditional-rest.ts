// A generic member's rest parameter can be a CONDITIONAL TUPLE over the
// member's own type parameters (`EventArguments<Schema[Name], A>`): the
// erased instance of such a member is a checked-dynamic variadic function
// (fixed prefix, hidden dyn array), so a call with surplus arguments rides
// the checked-dynamic boundary with its source arity instead of fencing.
type Attributes = Record<string, string | number | undefined>;
type Schema = {
  impl: Record<never, never>;
  block: { type: string; chars: string };
  status: { phase: string };
};

type RequiredNames<D extends Attributes> = Extract<
  { [K in keyof D]-?: undefined extends D[K] ? never : K }[keyof D],
  string
>;
type Exact<D extends Attributes, A extends D> = A & { [K in Exclude<keyof A, keyof D>]?: never };
type EventArguments<D extends Attributes, A extends D> = [RequiredNames<D>] extends [never]
  ? [attributes?: Exact<D, A>]
  : [attributes: Exact<D, A>];

interface Span {
  addLink(link: string): void;
  addEvent(name: string, attributes?: Attributes): void;
  setStatus(status: string): void;
}

type SchemaSpan = Omit<Span, "addEvent"> & {
  addEvent<Name extends keyof Schema & string, const A extends Schema[Name] = Schema[Name]>(
    name: Name,
    ...args: EventArguments<Schema[Name], A>
  ): void;
};

function makeSpan(log: string[]): SchemaSpan {
  // The erased member's fixed slot is the checked-dynamic `unknown` (the
  // member's own type parameter bound to `unknown`), so the implementation
  // takes the same shape.
  const addEvent = (name: unknown, ...args: unknown[]): void => {
    const first = args[0];
    log.push(`event:${String(name)}:${first === undefined ? "bare" : "attrs"}`);
  };
  return {
    addLink: (link: string): void => {
      log.push(`link:${link}`);
    },
    addEvent,
    setStatus: (status: string): void => {
      log.push(`status:${status}`);
    },
  };
}

function observe(span: SchemaSpan, kind: string): void {
  span.addEvent("impl");
  span.addEvent("block", { type: kind, chars: "3" });
  span.addEvent("status", { phase: "ok" });
  span.addLink("parent");
  span.setStatus("ok");
}

const log: string[] = [];
observe(makeSpan(log), "text");
console.log(log.join(" "));
