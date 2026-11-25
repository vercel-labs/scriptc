// A `let` initialised to `null` that only a closure assigns: the checker
// keeps it narrowed to `null` after the closure has run, so it types
// `binding && rest` as `null` whatever `rest` is. The lowering reads the
// stored value, and the pair answers what JavaScript answers: the binding
// while it is empty, `rest` once it holds a value.

interface Session {
  user: string;
}
interface Banner {
  shown(): boolean;
}
interface Hooks {
  ready?: (banner: Banner) => void;
}

let polls = 0;
function fresh(): boolean | undefined {
  return polls++ % 3 === 2 ? undefined : true;
}
function label(): string | undefined {
  return "ok";
}

// A module binding a function assigns.
let session: Session | null = null;
function signIn(): void {
  session = { user: "ada" };
}

signIn();
const after = session && fresh();
console.log(typeof after, after);
if (after) console.log("signed in and fresh");
const named = session && fresh() && label();
console.log(typeof named, named ? "named" : "unnamed");
const further = after && label();
console.log(typeof further, further ? "further" : "no further");
console.log(session && fresh() ? "both" : "not both", !(session && fresh()));

function report(value: unknown): void {
  console.log("reported", typeof value, value === true, value === null);
}
report(session && fresh());

// A local binding an arrow function assigns, read after an await.
async function flow(succeed: boolean, hooks: Hooks | undefined, banner: Banner | undefined) {
  let token: Session | null = null;
  let failure: Error | undefined = new Error("not polled");
  const poll = async (): Promise<Error | undefined> => {
    if (succeed) token = { user: "lin" };
    return succeed ? undefined : new Error("declined");
  };
  try {
    failure = await poll();
  } finally {
    const carry = token && !failure && banner?.shown() && hooks?.ready;
    if (carry && banner) hooks?.ready?.(banner);
    else console.log("nothing to carry:", typeof carry);
  }
  console.log(token === null ? "no token" : "token", failure === undefined ? "ok" : failure.message);
}

const visible: Banner = { shown: () => true };
const hidden: Banner = { shown: () => false };
await flow(true, { ready: (banner) => console.log("ready", banner.shown()) }, visible);
await flow(true, { ready: () => console.log("never") }, hidden);
await flow(true, {}, visible);
await flow(true, undefined, visible);
await flow(true, { ready: () => console.log("never") }, undefined);
await flow(false, { ready: () => console.log("never") }, visible);

// The same with `undefined` as the empty value.
let cursor: { at: number } | undefined = undefined;
const advance = (): void => {
  cursor = { at: 7 };
};
advance();
const moved = cursor && fresh();
console.log(typeof moved, moved ? "moved" : "still");
