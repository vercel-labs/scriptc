// A record built from the checked-dynamic tree keeps the own keys its shape
// does not declare, and every JS copy carries them. Converting such a record
// into an index-signature record must copy them too.
//
// The shape that lost them: an inline, UNANNOTATED arrow in a generic call
// whose member is declared as `(h: H) => H | Promise<H>`. No contextual type
// reaches the arrow through the type parameter, so its body is typed by tsc's
// own inference, which drops the spread's index signature: the closure is
// typed Promise<{ x }>, `{ ...h, x }` lowers through the checked-dynamic
// spread into that closed record, and the caller's keys survive only in the
// record's kept source view. The call site reads the member through the
// declared H and adapts the function value; converting `{ x }` into H must
// copy the kept keys. Node prints "accept,x"; before the fix this program
// printed "x" for the arrow, local and method lines, with no diagnostic.
type H = Record<string, string | null>;

interface T {
  transformHeaders?: (h: H) => H | Promise<H>;
}

function keys(r: H): string {
  return Object.keys(r).sort().join(",") || "(none)";
}

// The failing shape: block-bodied inline arrow, generic parameter.
async function viaArrow<O extends T>(o: O | undefined): Promise<H> {
  let h: H = { accept: "a" };
  if (o?.transformHeaders) h = await o.transformHeaders(h);
  return h;
}

// The same call read into a local first (the pi repro's shape).
async function viaLocal<O extends T>(o: O | undefined): Promise<H> {
  let h: H = { accept: "a" };
  if (o?.transformHeaders) {
    const r = await o.transformHeaders(h);
    console.log("local-mid:", keys(r));
    h = r;
  }
  return h;
}

interface Methods {
  transform(h: H): Promise<H>;
}

// The method form drops the same keys through the same capture.
async function viaMethod<O extends Methods>(o: O): Promise<H> {
  return await o.transform({ accept: "a" });
}

// A non-generic parameter: the arrow's contextual slot is the declared member,
// so these keep the index signature and never needed the capture.
async function viaArrowNonGeneric(o: T | undefined): Promise<H> {
  let h: H = { accept: "a" };
  if (o?.transformHeaders) h = await o.transformHeaders(h);
  return h;
}

interface Hooks {
  transform?: (h: H) => H | Promise<H>;
}

interface Nested {
  hooks: Hooks;
}

async function viaNested<O extends Nested>(o: O | undefined): Promise<H> {
  let h: H = { accept: "a" };
  const t = o?.hooks.transform;
  if (t) h = await t(h);
  return h;
}

function syncArrow<O extends { transform?: (h: H) => H }>(o: O): H {
  return o.transform ? o.transform({ accept: "a" }) : { accept: "a" };
}

async function main(): Promise<void> {
  const arrow = await viaArrow({
    transformHeaders: async (h) => {
      return { ...h, x: "1" };
    },
  });
  console.log("arrow:", keys(arrow), JSON.stringify(arrow));

  const local = await viaLocal({
    transformHeaders: async (h) => {
      return { ...h, x: "1" };
    },
  });
  console.log("local:", keys(local));

  const method = await viaMethod({
    async transform(h) {
      return { ...h, x: "1" };
    },
  });
  console.log("method:", keys(method));

  const generic = await viaArrowNonGeneric({
    transformHeaders: async (h) => {
      return { ...h, x: "1" };
    },
  });
  console.log("non-generic:", keys(generic));

  const expression = await viaArrowNonGeneric({
    transformHeaders: async (h) => ({ ...h, x: "1" }),
  });
  console.log("expression:", keys(expression));

  const nested = await viaNested({
    hooks: {
      transform: async (h) => {
        return { ...h, x: "1" };
      },
    },
  });
  console.log("nested:", keys(nested));

  const sync = syncArrow({
    transform: (h) => {
      return { ...h, x: "1" };
    },
  });
  console.log("sync:", keys(sync));
}

void main();
