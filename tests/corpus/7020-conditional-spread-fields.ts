// Conditional spreads that carry several properties, and conditional
// spreads of a record value against an empty arm. The condition runs
// once, the carried values run only when their arm is taken and in
// property order, and the keys appear at the spread's position.
const log: string[] = [];
function note<T>(label: string, value: T): T {
  log.push(label);
  return value;
}

interface Extra {
  region: string;
  zone: number;
}

function build(flag: boolean, model: string | undefined, extra: Extra | undefined) {
  return {
    name: note("name", "tool"),
    ...(note("cond", flag) ? { verbose: note("verbose", true), depth: note("depth", 2) } : {}),
    ...(model ? { model } : {}),
    ...(extra ? extra : {}),
    last: note("last", 0),
  };
}

for (const [flag, model, extra] of [
  [true, "m1", { region: "eu", zone: 3 }],
  [false, undefined, undefined],
  [true, undefined, { region: "us", zone: 1 }],
] as const) {
  log.length = 0;
  const out = build(flag, model, extra);
  console.log(JSON.stringify(out), Object.keys(out).join(","), log.join(" "));
  console.log("verbose" in out, out.depth ?? "no depth", out.region ?? "no region");
}

// The carrying arm can be the false arm, and `c && { ... }` carries
// several properties too.
function flags(quiet: boolean, color: boolean) {
  return {
    ...(quiet ? {} : { level: "info", prefix: "[app]" }),
    ...(color && { fg: "green", bg: "black", bold: true }),
  };
}
console.log(JSON.stringify(flags(false, true)), JSON.stringify(flags(true, false)));

// A record arm in either position, against `{}`, `undefined` or `null`.
interface Auth {
  user: string;
  token?: string;
}
const auth: Auth = { user: "u", token: "t" };
const bare: Auth = { user: "v" };
function request(useAuth: boolean, source: Auth) {
  return {
    url: "/x",
    ...(useAuth ? source : {}),
    ...(useAuth ? undefined : { anonymous: true }),
  };
}
console.log(JSON.stringify(request(true, auth)), JSON.stringify(request(false, auth)));
console.log(JSON.stringify(request(true, bare)), Object.keys(request(true, bare)).join(","));
function fallback(primary: Auth | null, secondary: Auth) {
  return { ...(primary === null ? secondary : null), id: 1 };
}
console.log(JSON.stringify(fallback(null, auth)), JSON.stringify(fallback(bare, auth)));

// A record arm read through a call runs only when its arm is taken.
let reads = 0;
function current(): Extra {
  reads++;
  return { region: "ap", zone: reads };
}
const a = { ...(reads > 0 ? current() : {}), tag: "a" };
const b = { ...(reads === 0 ? current() : {}), tag: "b" };
console.log(JSON.stringify(a), JSON.stringify(b), reads);

// Into a declared shape with optional fields.
interface Options {
  cwd: string;
  shell?: boolean;
  timeout?: number;
  env?: string;
}
function options(detached: boolean, env: string | undefined): Options {
  return { cwd: "/", ...(detached ? { shell: false, timeout: 5 } : {}), ...(env ? { env } : {}) };
}
console.log(JSON.stringify(options(true, "prod")), JSON.stringify(options(false, undefined)));

// Inside 'any'-typed object literals, where the key is absent when the
// empty arm is taken.
function anyLiterals(): void {
  function opts(aspect: string | undefined): any {
    const o: any = {
      mode: "M",
      ...(aspect ? { cfg: { aspect } } : {}),
    };
    return o;
  }
  const a = opts("1:1");
  console.log(`${a.mode} ${a.cfg.aspect} ${typeof a.cfg}`);
  const b = opts(undefined);
  console.log(`${b.mode} ${typeof b.cfg}`);

  // Several carried properties.
  function multi(on: boolean): any {
    return { base: 1, ...(on ? { x: "X", y: "Y" } : {}) };
  }
  const m1 = multi(true);
  const m2 = multi(false);
  console.log(`${m1.base} ${m1.x} ${m1.y}`);
  console.log(`${m2.base} ${typeof m2.x} ${typeof m2.y}`);

  // Reversed orientation and string-literal keys.
  function rev(quiet: boolean): any {
    return { kind: "r", ...(quiet ? {} : { "log-level": "loud" }) };
  }
  console.log(`${rev(false)["log-level"]}`);
  console.log(`${typeof rev(true)["log-level"]}`);

  // The spread mid-literal: properties around it evaluate exactly once and
  // land in engine key order.
  let sides = 0;
  function side(v: number): number {
    sides++;
    return v;
  }
  function ordered(flag: boolean): any {
    const o: any = { first: side(1), ...(flag ? { mid: 2 } : {}), last: side(3) };
    return o;
  }
  const o1 = ordered(true);
  const o2 = ordered(false);
  console.log(`${o1.first} ${o1.mid} ${o1.last}`);
  console.log(`${o2.first} ${typeof o2.mid} ${o2.last} ${sides}`);
}
anyLiterals();
