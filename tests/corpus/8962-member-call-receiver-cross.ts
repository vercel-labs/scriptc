// The cross product of the ways a function that reads the receiver of its
// call becomes a member with the ways a member is called: every call
// spelling against a member stored in place, through a factory's parameter
// and as an object-literal method, and every store against a plain call, an
// optional call of an optional holder and a parenthesized callee. Each cell
// stores the function as member `f` of `host` and prints what the call saw
// as `this`: the holder where JavaScript passes it, none where the call is of
// the value by itself. Generated; the cells are the probe table's programs.
type F = () => string;
interface Holder { name: string; f: F }
function label(this: unknown): string {
  return this === undefined ? "no receiver" : "receiver";
}
function id<T>(x: T): T { return x; }

function cellArrowDot(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  {
    console.log(host.f());
  }
}
function cellArrowOptionalBoth(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellArrowParenthesized(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  {
    console.log((host.f)());
  }
}
function cellDirectDot(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host.f());
  }
}
function cellDirectElementLiteral(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host["f"]());
  }
}
function cellDirectElementConst(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const k = "f" as const;
    console.log(host[k]());
  }
}
function cellDirectElementDynamic(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const k = (process.argv.length > 100 ? "g" : "f") as "f";
    console.log(host[k]());
  }
}
function cellDirectOptionalCall(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f?.());
  }
}
function cellDirectOptionalHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f());
  }
}
function cellDirectOptionalElement(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.["f"]());
  }
}
function cellDirectOptionalBoth(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellDirectOptionalParenthesized(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log((maybe?.f)!());
  }
}
function cellDirectOptionalNestedCall(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const outer: { inner?: Holder } | undefined = process.argv.length > 100 ? undefined : { inner: host };
    console.log(outer?.inner?.f?.());
  }
}
function cellDirectOptionalIndex(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const list: F[] | undefined = process.argv.length > 100 ? undefined : [host.f];
    console.log(list?.[0]?.());
  }
}
function cellDirectNonNull(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f!());
  }
}
function cellDirectNarrowedMember(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const loose: { name: string; f: F | undefined } = host;
    if (loose.f) console.log(loose.f());
  }
}
function cellDirectParenthesized(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((host.f)());
  }
}
function cellDirectAsCast(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((host.f as F)());
  }
}
function cellDirectSatisfies(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((host.f satisfies F)());
  }
}
function cellDirectParameter(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    function run(target: Holder): string { return target.f(); }
    console.log(run(host));
  }
}
function cellDirectReturnedHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    function get(): Holder { return host; }
    console.log(get().f());
  }
}
function cellDirectNested(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const outer = { inner: host };
    console.log(outer.inner.f());
  }
}
function cellDirectNestedOptional(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const outer: { inner?: Holder } = { inner: host };
    console.log(outer.inner?.f());
  }
}
function cellDirectInlineHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(({ name: "i", f: host.f }).f());
  }
}
function cellDirectClosure(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const run = (): string => host.f();
    console.log(run());
  }
}
function cellDirectLoopReassigned(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    let cur: Holder = host;
    for (let i = 0; i < 2; i++) { console.log(cur.f()); cur = { name: "n" + i, f: cur.f }; }
  }
}
function cellDirectInExpression(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(`${host.f()}`, [host.f()].length, host.f().length > 0);
  }
}
function cellDirectSpreadArguments(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const none: [] = [];
    console.log(host.f(...none));
  }
}
function cellDirectThisHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { inner: Holder = host; run(): string { return this.inner.f(); } }
    console.log(new Owner().run());
  }
}
function cellDirectClassFieldHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return this.f(); } }
    const owner = new Owner();
    console.log(owner.run(), owner.f());
  }
}
function cellDirectInheritedField(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Base { name = "b"; f: F = host.f; }
    class Derived extends Base { run(): string { return this.f(); } }
    console.log(new Derived().run());
  }
}
function cellDirectClassParenthesized(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log((owner.f)(), (owner.f as F)());
  }
}
function cellDirectClassElement(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log(owner["f"]());
  }
}
function cellDirectClassOptionalCall(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f?: F = host.f; }
    const owner = new Owner();
    console.log(owner.f?.(), owner.f!());
  }
}
function cellDirectClassOptionalHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner: Owner | undefined = process.argv.length > 100 ? undefined : new Owner();
    console.log(owner?.f(), owner?.["f"](), owner?.f?.());
  }
}
function cellDirectClassThisParenthesized(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return (this.f)() + " " + this["f"](); } }
    console.log(new Owner().run());
  }
}
function cellDirectAnyHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const loose: any = host;
    console.log(loose.f(), (loose.f)(), loose["f"](), loose.f?.());
  }
}
function cellDirectUnknownNarrowedHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const loose: unknown = host;
    if (typeof loose === "object" && loose !== null && "f" in loose && typeof loose.f === "function") console.log(String(loose.f()));
  }
}
function cellDirectClassView(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; }
    const view: Holder = new Owner();
    console.log(view.f());
  }
}
function cellDirectUnionDistinct(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f());
  }
}
function cellDirectUnionElement(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each["f"]());
  }
}
function cellDirectUnionOptionalCall(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    interface Wide { name: string; n: number; f?: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f?.());
  }
}
function cellDirectUnionParenthesized(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log((each.f)());
  }
}
function cellDirectUnionTernary(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const either: Holder | { name: string; f: F; extra: boolean } = process.argv.length > 100 ? { name: "e", f: host.f, extra: true } : host;
    console.log(either.f());
  }
}
function cellDirectUnionClassRecord(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    class Owner { name = "o"; f: F = host.f; }
    const mixed: (Holder | Owner)[] = [host, new Owner()];
    for (const each of mixed) console.log(each.f());
  }
}
function cellDirectTupleHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const pair: [string, F] = ["p", host.f];
    console.log(pair[1]());
  }
}
function cellDirectArrayHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const list: F[] = [host.f];
    console.log(list[0]!());
  }
}
function cellDirectDictionaryHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const table: Record<string, F> = { k: host.f };
    const key = process.argv.length > 100 ? "x" : "k";
    console.log(table[key]!(), table.k!());
  }
}
function cellDirectTupleDestructuredHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const [first]: [Holder] = [host];
    console.log(first.f());
  }
}
function cellDirectMapValueHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const byName = new Map<string, Holder>([["h", host]]);
    console.log(byName.get("h")!.f());
  }
}
function cellDirectConditionalHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((process.argv.length > 100 ? { name: "c", f: host.f } : host).f());
  }
}
function cellDirectGetterHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const lazy = { name: "g", get f(): F { return host.f; } };
    console.log(lazy.f());
  }
}
function cellDirectApplyHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host.f.apply(host));
  }
}
function cellDirectCallOther(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host.f.call({ name: "o" }));
  }
}
function cellDirectBindHolder(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host.f.bind(host)());
  }
}
function cellDirectReflectApply(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(Reflect.apply(host.f, host, []));
  }
}
function cellDirectDetached(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const g = host.f;
    console.log(g());
  }
}
function cellDirectComma(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((0, host.f)());
  }
}
function cellDirectDestructuredCall(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const { f } = host;
    console.log(f());
  }
}
function cellDirectCallbackArgument(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    function run(g: F): string { return g(); }
    console.log(run(host.f));
  }
}
function cellDirectLogicalCallee(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((host.f || host.f)());
  }
}
function cellDirectConditionalCallee(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log((process.argv.length > 100 ? host.f : host.f)());
  }
}
function cellDirectCallUndefined(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log(host.f.call(undefined));
  }
}
function cellDirectMapGet(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    const table = new Map<string, F>([["k", host.f]]);
    console.log(table.get("k")!());
  }
}
function cellDirectArrayCallback(): void {
  const host: Holder = { name: "#h", f: label as F };
  {
    console.log([1].map(host.f).join());
  }
}
function cellFunctionExpressionDot(): void {
  const host: Holder = { name: "#h", f: function (this: unknown): string { return this === undefined ? "no receiver" : "receiver"; } as F };
  {
    console.log(host.f());
  }
}
function cellFunctionExpressionOptionalBoth(): void {
  const host: Holder = { name: "#h", f: function (this: unknown): string { return this === undefined ? "no receiver" : "receiver"; } as F };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellFunctionExpressionParenthesized(): void {
  const host: Holder = { name: "#h", f: function (this: unknown): string { return this === undefined ? "no receiver" : "receiver"; } as F };
  {
    console.log((host.f)());
  }
}
function cellMethodShorthandDot(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host.f());
  }
}
function cellMethodShorthandElementLiteral(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host["f"]());
  }
}
function cellMethodShorthandElementConst(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const k = "f" as const;
    console.log(host[k]());
  }
}
function cellMethodShorthandElementDynamic(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const k = (process.argv.length > 100 ? "g" : "f") as "f";
    console.log(host[k]());
  }
}
function cellMethodShorthandOptionalCall(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f?.());
  }
}
function cellMethodShorthandOptionalHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f());
  }
}
function cellMethodShorthandOptionalElement(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.["f"]());
  }
}
function cellMethodShorthandOptionalBoth(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellMethodShorthandOptionalParenthesized(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log((maybe?.f)!());
  }
}
function cellMethodShorthandOptionalNestedCall(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const outer: { inner?: Holder } | undefined = process.argv.length > 100 ? undefined : { inner: host };
    console.log(outer?.inner?.f?.());
  }
}
function cellMethodShorthandOptionalIndex(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const list: F[] | undefined = process.argv.length > 100 ? undefined : [host.f];
    console.log(list?.[0]?.());
  }
}
function cellMethodShorthandNonNull(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f!());
  }
}
function cellMethodShorthandNarrowedMember(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const loose: { name: string; f: F | undefined } = host;
    if (loose.f) console.log(loose.f());
  }
}
function cellMethodShorthandParenthesized(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((host.f)());
  }
}
function cellMethodShorthandAsCast(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((host.f as F)());
  }
}
function cellMethodShorthandSatisfies(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((host.f satisfies F)());
  }
}
function cellMethodShorthandParameter(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    function run(target: Holder): string { return target.f(); }
    console.log(run(host));
  }
}
function cellMethodShorthandReturnedHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    function get(): Holder { return host; }
    console.log(get().f());
  }
}
function cellMethodShorthandNested(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const outer = { inner: host };
    console.log(outer.inner.f());
  }
}
function cellMethodShorthandNestedOptional(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const outer: { inner?: Holder } = { inner: host };
    console.log(outer.inner?.f());
  }
}
function cellMethodShorthandInlineHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(({ name: "i", f: host.f }).f());
  }
}
function cellMethodShorthandClosure(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const run = (): string => host.f();
    console.log(run());
  }
}
function cellMethodShorthandLoopReassigned(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    let cur: Holder = host;
    for (let i = 0; i < 2; i++) { console.log(cur.f()); cur = { name: "n" + i, f: cur.f }; }
  }
}
function cellMethodShorthandInExpression(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(`${host.f()}`, [host.f()].length, host.f().length > 0);
  }
}
function cellMethodShorthandSpreadArguments(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const none: [] = [];
    console.log(host.f(...none));
  }
}
function cellMethodShorthandThisHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { inner: Holder = host; run(): string { return this.inner.f(); } }
    console.log(new Owner().run());
  }
}
function cellMethodShorthandClassFieldHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return this.f(); } }
    const owner = new Owner();
    console.log(owner.run(), owner.f());
  }
}
function cellMethodShorthandInheritedField(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Base { name = "b"; f: F = host.f; }
    class Derived extends Base { run(): string { return this.f(); } }
    console.log(new Derived().run());
  }
}
function cellMethodShorthandClassParenthesized(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log((owner.f)(), (owner.f as F)());
  }
}
function cellMethodShorthandClassElement(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log(owner["f"]());
  }
}
function cellMethodShorthandClassOptionalCall(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f?: F = host.f; }
    const owner = new Owner();
    console.log(owner.f?.(), owner.f!());
  }
}
function cellMethodShorthandClassOptionalHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner: Owner | undefined = process.argv.length > 100 ? undefined : new Owner();
    console.log(owner?.f(), owner?.["f"](), owner?.f?.());
  }
}
function cellMethodShorthandClassThisParenthesized(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return (this.f)() + " " + this["f"](); } }
    console.log(new Owner().run());
  }
}
function cellMethodShorthandAnyHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const loose: any = host;
    console.log(loose.f(), (loose.f)(), loose["f"](), loose.f?.());
  }
}
function cellMethodShorthandUnknownNarrowedHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const loose: unknown = host;
    if (typeof loose === "object" && loose !== null && "f" in loose && typeof loose.f === "function") console.log(String(loose.f()));
  }
}
function cellMethodShorthandClassView(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; }
    const view: Holder = new Owner();
    console.log(view.f());
  }
}
function cellMethodShorthandUnionDistinct(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f());
  }
}
function cellMethodShorthandUnionElement(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each["f"]());
  }
}
function cellMethodShorthandUnionOptionalCall(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    interface Wide { name: string; n: number; f?: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f?.());
  }
}
function cellMethodShorthandUnionParenthesized(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log((each.f)());
  }
}
function cellMethodShorthandUnionTernary(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const either: Holder | { name: string; f: F; extra: boolean } = process.argv.length > 100 ? { name: "e", f: host.f, extra: true } : host;
    console.log(either.f());
  }
}
function cellMethodShorthandUnionClassRecord(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    class Owner { name = "o"; f: F = host.f; }
    const mixed: (Holder | Owner)[] = [host, new Owner()];
    for (const each of mixed) console.log(each.f());
  }
}
function cellMethodShorthandTupleHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const pair: [string, F] = ["p", host.f];
    console.log(pair[1]());
  }
}
function cellMethodShorthandArrayHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const list: F[] = [host.f];
    console.log(list[0]!());
  }
}
function cellMethodShorthandDictionaryHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const table: Record<string, F> = { k: host.f };
    const key = process.argv.length > 100 ? "x" : "k";
    console.log(table[key]!(), table.k!());
  }
}
function cellMethodShorthandTupleDestructuredHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const [first]: [Holder] = [host];
    console.log(first.f());
  }
}
function cellMethodShorthandMapValueHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const byName = new Map<string, Holder>([["h", host]]);
    console.log(byName.get("h")!.f());
  }
}
function cellMethodShorthandConditionalHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((process.argv.length > 100 ? { name: "c", f: host.f } : host).f());
  }
}
function cellMethodShorthandGetterHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const lazy = { name: "g", get f(): F { return host.f; } };
    console.log(lazy.f());
  }
}
function cellMethodShorthandApplyHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host.f.apply(host));
  }
}
function cellMethodShorthandCallOther(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host.f.call({ name: "o" }));
  }
}
function cellMethodShorthandBindHolder(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host.f.bind(host)());
  }
}
function cellMethodShorthandReflectApply(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(Reflect.apply(host.f, host, []));
  }
}
function cellMethodShorthandDetached(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const g = host.f;
    console.log(g());
  }
}
function cellMethodShorthandComma(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((0, host.f)());
  }
}
function cellMethodShorthandDestructuredCall(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const { f } = host;
    console.log(f());
  }
}
function cellMethodShorthandCallbackArgument(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    function run(g: F): string { return g(); }
    console.log(run(host.f));
  }
}
function cellMethodShorthandLogicalCallee(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((host.f || host.f)());
  }
}
function cellMethodShorthandConditionalCallee(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log((process.argv.length > 100 ? host.f : host.f)());
  }
}
function cellMethodShorthandCallUndefined(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log(host.f.call(undefined));
  }
}
function cellMethodShorthandMapGet(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    const table = new Map<string, F>([["k", host.f]]);
    console.log(table.get("k")!());
  }
}
function cellMethodShorthandArrayCallback(): void {
  const host: Holder = { name: "#h", f(): string { return this === undefined ? "no receiver" : "receiver"; } };
  {
    console.log([1].map(host.f).join());
  }
}
function cellGetterDot(): void {
  const host: Holder = { name: "#h", get f(): F { return label as F; } };
  {
    console.log(host.f());
  }
}
function cellGetterOptionalBoth(): void {
  const host: Holder = { name: "#h", get f(): F { return label as F; } };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellGetterParenthesized(): void {
  const host: Holder = { name: "#h", get f(): F { return label as F; } };
  {
    console.log((host.f)());
  }
}
function cellComputedLiteralDot(): void {
  const host: Holder = { name: "#h", ["f"]: label as F };
  {
    console.log(host.f());
  }
}
function cellComputedLiteralOptionalBoth(): void {
  const host: Holder = { name: "#h", ["f"]: label as F };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellComputedLiteralParenthesized(): void {
  const host: Holder = { name: "#h", ["f"]: label as F };
  {
    console.log((host.f)());
  }
}
function cellComputedConstDot(): void {
  const key = "f" as const;
  const host: Holder = { name: "#h", [key]: label as F };
  {
    console.log(host.f());
  }
}
function cellComputedConstOptionalBoth(): void {
  const key = "f" as const;
  const host: Holder = { name: "#h", [key]: label as F };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellComputedConstParenthesized(): void {
  const key = "f" as const;
  const host: Holder = { name: "#h", [key]: label as F };
  {
    console.log((host.f)());
  }
}
function cellComputedUnknownDot(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = { [key]: label as F };
  const host: Holder = { name: "#h", f: table[key]! };
  {
    console.log(host.f());
  }
}
function cellComputedUnknownOptionalBoth(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = { [key]: label as F };
  const host: Holder = { name: "#h", f: table[key]! };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellComputedUnknownParenthesized(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = { [key]: label as F };
  const host: Holder = { name: "#h", f: table[key]! };
  {
    console.log((host.f)());
  }
}
function cellKeyedAssignUnknownDot(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = {};
  table[key] = label as F;
  const host: Holder = { name: "#h", f: table.f! };
  {
    console.log(host.f());
  }
}
function cellKeyedAssignUnknownOptionalBoth(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = {};
  table[key] = label as F;
  const host: Holder = { name: "#h", f: table.f! };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellKeyedAssignUnknownParenthesized(): void {
  const key: string = process.argv.length > 100 ? "other" : "f";
  const table: Record<string, F> = {};
  table[key] = label as F;
  const host: Holder = { name: "#h", f: table.f! };
  {
    console.log((host.f)());
  }
}
function cellAssignedLaterDot(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host.f = label as F;
  {
    console.log(host.f());
  }
}
function cellAssignedLaterOptionalBoth(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host.f = label as F;
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellAssignedLaterParenthesized(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host.f = label as F;
  {
    console.log((host.f)());
  }
}
function cellAssignedElementDot(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host["f"] = label as F;
  {
    console.log(host.f());
  }
}
function cellAssignedElementOptionalBoth(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host["f"] = label as F;
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellAssignedElementParenthesized(): void {
  const host: Holder = { name: "#h", f: () => "arrow" };
  host["f"] = label as F;
  {
    console.log((host.f)());
  }
}
function cellShorthandDot(): void {
  const f = label as F;
  const host: Holder = { name: "#h", f };
  {
    console.log(host.f());
  }
}
function cellShorthandOptionalBoth(): void {
  const f = label as F;
  const host: Holder = { name: "#h", f };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellShorthandParenthesized(): void {
  const f = label as F;
  const host: Holder = { name: "#h", f };
  {
    console.log((host.f)());
  }
}
function cellVariableLetDot(): void {
  let g: F = () => "arrow";
  g = label as F;
  const host: Holder = { name: "#h", f: g };
  {
    console.log(host.f());
  }
}
function cellVariableLetOptionalBoth(): void {
  let g: F = () => "arrow";
  g = label as F;
  const host: Holder = { name: "#h", f: g };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellVariableLetParenthesized(): void {
  let g: F = () => "arrow";
  g = label as F;
  const host: Holder = { name: "#h", f: g };
  {
    console.log((host.f)());
  }
}
function cellClosureCaptureDot(): void {
  function make(): Holder { const g = label as F; return { name: "#h", f: g }; }
  const host = make();
  {
    console.log(host.f());
  }
}
function cellClosureCaptureOptionalBoth(): void {
  function make(): Holder { const g = label as F; return { name: "#h", f: g }; }
  const host = make();
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellClosureCaptureParenthesized(): void {
  function make(): Holder { const g = label as F; return { name: "#h", f: g }; }
  const host = make();
  {
    console.log((host.f)());
  }
}
function cellFactoryParamDot(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host.f());
  }
}
function cellFactoryParamElementLiteral(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host["f"]());
  }
}
function cellFactoryParamElementConst(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const k = "f" as const;
    console.log(host[k]());
  }
}
function cellFactoryParamElementDynamic(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const k = (process.argv.length > 100 ? "g" : "f") as "f";
    console.log(host[k]());
  }
}
function cellFactoryParamOptionalCall(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f?.());
  }
}
function cellFactoryParamOptionalHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f());
  }
}
function cellFactoryParamOptionalElement(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.["f"]());
  }
}
function cellFactoryParamOptionalBoth(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellFactoryParamOptionalParenthesized(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: Holder | undefined = process.argv.length > 100 ? undefined : host;
    console.log((maybe?.f)!());
  }
}
function cellFactoryParamOptionalNestedCall(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const outer: { inner?: Holder } | undefined = process.argv.length > 100 ? undefined : { inner: host };
    console.log(outer?.inner?.f?.());
  }
}
function cellFactoryParamOptionalIndex(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const list: F[] | undefined = process.argv.length > 100 ? undefined : [host.f];
    console.log(list?.[0]?.());
  }
}
function cellFactoryParamNonNull(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const maybe: { name: string; f?: F } = host;
    console.log(maybe.f!());
  }
}
function cellFactoryParamNarrowedMember(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const loose: { name: string; f: F | undefined } = host;
    if (loose.f) console.log(loose.f());
  }
}
function cellFactoryParamParenthesized(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((host.f)());
  }
}
function cellFactoryParamAsCast(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((host.f as F)());
  }
}
function cellFactoryParamSatisfies(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((host.f satisfies F)());
  }
}
function cellFactoryParamParameter(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    function run(target: Holder): string { return target.f(); }
    console.log(run(host));
  }
}
function cellFactoryParamReturnedHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    function get(): Holder { return host; }
    console.log(get().f());
  }
}
function cellFactoryParamNested(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const outer = { inner: host };
    console.log(outer.inner.f());
  }
}
function cellFactoryParamNestedOptional(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const outer: { inner?: Holder } = { inner: host };
    console.log(outer.inner?.f());
  }
}
function cellFactoryParamInlineHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(({ name: "i", f: host.f }).f());
  }
}
function cellFactoryParamClosure(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const run = (): string => host.f();
    console.log(run());
  }
}
function cellFactoryParamLoopReassigned(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    let cur: Holder = host;
    for (let i = 0; i < 2; i++) { console.log(cur.f()); cur = { name: "n" + i, f: cur.f }; }
  }
}
function cellFactoryParamInExpression(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(`${host.f()}`, [host.f()].length, host.f().length > 0);
  }
}
function cellFactoryParamSpreadArguments(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const none: [] = [];
    console.log(host.f(...none));
  }
}
function cellFactoryParamThisHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { inner: Holder = host; run(): string { return this.inner.f(); } }
    console.log(new Owner().run());
  }
}
function cellFactoryParamClassFieldHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return this.f(); } }
    const owner = new Owner();
    console.log(owner.run(), owner.f());
  }
}
function cellFactoryParamInheritedField(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Base { name = "b"; f: F = host.f; }
    class Derived extends Base { run(): string { return this.f(); } }
    console.log(new Derived().run());
  }
}
function cellFactoryParamClassParenthesized(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log((owner.f)(), (owner.f as F)());
  }
}
function cellFactoryParamClassElement(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner = new Owner();
    console.log(owner["f"]());
  }
}
function cellFactoryParamClassOptionalCall(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f?: F = host.f; }
    const owner = new Owner();
    console.log(owner.f?.(), owner.f!());
  }
}
function cellFactoryParamClassOptionalHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; }
    const owner: Owner | undefined = process.argv.length > 100 ? undefined : new Owner();
    console.log(owner?.f(), owner?.["f"](), owner?.f?.());
  }
}
function cellFactoryParamClassThisParenthesized(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; run(): string { return (this.f)() + " " + this["f"](); } }
    console.log(new Owner().run());
  }
}
function cellFactoryParamAnyHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const loose: any = host;
    console.log(loose.f(), (loose.f)(), loose["f"](), loose.f?.());
  }
}
function cellFactoryParamUnknownNarrowedHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const loose: unknown = host;
    if (typeof loose === "object" && loose !== null && "f" in loose && typeof loose.f === "function") console.log(String(loose.f()));
  }
}
function cellFactoryParamClassView(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; }
    const view: Holder = new Owner();
    console.log(view.f());
  }
}
function cellFactoryParamUnionDistinct(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f());
  }
}
function cellFactoryParamUnionElement(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each["f"]());
  }
}
function cellFactoryParamUnionOptionalCall(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    interface Wide { name: string; n: number; f?: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log(each.f?.());
  }
}
function cellFactoryParamUnionParenthesized(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    interface Wide { name: string; n: number; f: F }
    const both: (Holder | Wide)[] = [host, { name: "w", n: 1, f: host.f }];
    for (const each of both) console.log((each.f)());
  }
}
function cellFactoryParamUnionTernary(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const either: Holder | { name: string; f: F; extra: boolean } = process.argv.length > 100 ? { name: "e", f: host.f, extra: true } : host;
    console.log(either.f());
  }
}
function cellFactoryParamUnionClassRecord(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    class Owner { name = "o"; f: F = host.f; }
    const mixed: (Holder | Owner)[] = [host, new Owner()];
    for (const each of mixed) console.log(each.f());
  }
}
function cellFactoryParamTupleHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const pair: [string, F] = ["p", host.f];
    console.log(pair[1]());
  }
}
function cellFactoryParamArrayHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const list: F[] = [host.f];
    console.log(list[0]!());
  }
}
function cellFactoryParamDictionaryHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const table: Record<string, F> = { k: host.f };
    const key = process.argv.length > 100 ? "x" : "k";
    console.log(table[key]!(), table.k!());
  }
}
function cellFactoryParamTupleDestructuredHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const [first]: [Holder] = [host];
    console.log(first.f());
  }
}
function cellFactoryParamMapValueHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const byName = new Map<string, Holder>([["h", host]]);
    console.log(byName.get("h")!.f());
  }
}
function cellFactoryParamConditionalHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((process.argv.length > 100 ? { name: "c", f: host.f } : host).f());
  }
}
function cellFactoryParamGetterHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const lazy = { name: "g", get f(): F { return host.f; } };
    console.log(lazy.f());
  }
}
function cellFactoryParamApplyHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host.f.apply(host));
  }
}
function cellFactoryParamCallOther(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host.f.call({ name: "o" }));
  }
}
function cellFactoryParamBindHolder(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host.f.bind(host)());
  }
}
function cellFactoryParamReflectApply(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(Reflect.apply(host.f, host, []));
  }
}
function cellFactoryParamDetached(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const g = host.f;
    console.log(g());
  }
}
function cellFactoryParamComma(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((0, host.f)());
  }
}
function cellFactoryParamDestructuredCall(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const { f } = host;
    console.log(f());
  }
}
function cellFactoryParamCallbackArgument(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    function run(g: F): string { return g(); }
    console.log(run(host.f));
  }
}
function cellFactoryParamLogicalCallee(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((host.f || host.f)());
  }
}
function cellFactoryParamConditionalCallee(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log((process.argv.length > 100 ? host.f : host.f)());
  }
}
function cellFactoryParamCallUndefined(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log(host.f.call(undefined));
  }
}
function cellFactoryParamMapGet(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    const table = new Map<string, F>([["k", host.f]]);
    console.log(table.get("k")!());
  }
}
function cellFactoryParamArrayCallback(): void {
  function make(g: F): Holder { return { name: "#h", f: g }; }
  const host = make(label as F);
  {
    console.log([1].map(host.f).join());
  }
}
function cellDefaultParamDot(): void {
  function make(g: F = label as F): Holder { return { name: "#h", f: g }; }
  const host = make();
  {
    console.log(host.f());
  }
}
function cellDefaultParamOptionalBoth(): void {
  function make(g: F = label as F): Holder { return { name: "#h", f: g }; }
  const host = make();
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellDefaultParamParenthesized(): void {
  function make(g: F = label as F): Holder { return { name: "#h", f: g }; }
  const host = make();
  {
    console.log((host.f)());
  }
}
function cellReturnedDot(): void {
  function pick(): F { return label as F; }
  const host: Holder = { name: "#h", f: pick() };
  {
    console.log(host.f());
  }
}
function cellReturnedOptionalBoth(): void {
  function pick(): F { return label as F; }
  const host: Holder = { name: "#h", f: pick() };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellReturnedParenthesized(): void {
  function pick(): F { return label as F; }
  const host: Holder = { name: "#h", f: pick() };
  {
    console.log((host.f)());
  }
}
function cellGenericIdentityDot(): void {
  const host: Holder = { name: "#h", f: id(label as F) };
  {
    console.log(host.f());
  }
}
function cellGenericIdentityOptionalBoth(): void {
  const host: Holder = { name: "#h", f: id(label as F) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellGenericIdentityParenthesized(): void {
  const host: Holder = { name: "#h", f: id(label as F) };
  {
    console.log((host.f)());
  }
}
function cellCallbackParamDot(): void {
  function later(cb: (g: F) => void): void { cb(label as F); }
  let made: Holder = { name: "#h", f: () => "arrow" };
  later((g) => { made = { name: "#h", f: g }; });
  const host: Holder = made;
  {
    console.log(host.f());
  }
}
function cellCallbackParamOptionalBoth(): void {
  function later(cb: (g: F) => void): void { cb(label as F); }
  let made: Holder = { name: "#h", f: () => "arrow" };
  later((g) => { made = { name: "#h", f: g }; });
  const host: Holder = made;
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellCallbackParamParenthesized(): void {
  function later(cb: (g: F) => void): void { cb(label as F); }
  let made: Holder = { name: "#h", f: () => "arrow" };
  later((g) => { made = { name: "#h", f: g }; });
  const host: Holder = made;
  {
    console.log((host.f)());
  }
}
function cellStringIndexCopyDot(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source["callback"] };
  {
    console.log(host.f());
  }
}
function cellStringIndexCopyOptionalBoth(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source["callback"] };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellStringIndexCopyParenthesized(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source["callback"] };
  {
    console.log((host.f)());
  }
}
function cellMemberCopyDot(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source.callback };
  {
    console.log(host.f());
  }
}
function cellMemberCopyOptionalBoth(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source.callback };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellMemberCopyParenthesized(): void {
  const source = { callback: label as F };
  const host: Holder = { name: "#h", f: source.callback };
  {
    console.log((host.f)());
  }
}
function cellDestructuredDot(): void {
  const source = { callback: label as F };
  const { callback } = source;
  const host: Holder = { name: "#h", f: callback };
  {
    console.log(host.f());
  }
}
function cellDestructuredOptionalBoth(): void {
  const source = { callback: label as F };
  const { callback } = source;
  const host: Holder = { name: "#h", f: callback };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellDestructuredParenthesized(): void {
  const source = { callback: label as F };
  const { callback } = source;
  const host: Holder = { name: "#h", f: callback };
  {
    console.log((host.f)());
  }
}
function cellDestructuredRenamedDot(): void {
  const source = { callback: label as F };
  const { callback: g } = source;
  const host: Holder = { name: "#h", f: g };
  {
    console.log(host.f());
  }
}
function cellDestructuredRenamedOptionalBoth(): void {
  const source = { callback: label as F };
  const { callback: g } = source;
  const host: Holder = { name: "#h", f: g };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellDestructuredRenamedParenthesized(): void {
  const source = { callback: label as F };
  const { callback: g } = source;
  const host: Holder = { name: "#h", f: g };
  {
    console.log((host.f)());
  }
}
function cellMemberRelayDot(): void {
  const source = { callback: label as F };
  function relay(g: F): Holder { return { name: "#h", f: g }; }
  const host = relay(source.callback);
  {
    console.log(host.f());
  }
}
function cellMemberRelayOptionalBoth(): void {
  const source = { callback: label as F };
  function relay(g: F): Holder { return { name: "#h", f: g }; }
  const host = relay(source.callback);
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellMemberRelayParenthesized(): void {
  const source = { callback: label as F };
  function relay(g: F): Holder { return { name: "#h", f: g }; }
  const host = relay(source.callback);
  {
    console.log((host.f)());
  }
}
function cellObjectLiteralMethodDot(): void {
  const source = { name: "s", m(): string { return this === undefined ? "no receiver" : "receiver"; } };
  const host: Holder = { name: "#h", f: source.m };
  {
    console.log(host.f());
  }
}
function cellObjectLiteralMethodOptionalBoth(): void {
  const source = { name: "s", m(): string { return this === undefined ? "no receiver" : "receiver"; } };
  const host: Holder = { name: "#h", f: source.m };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellObjectLiteralMethodParenthesized(): void {
  const source = { name: "s", m(): string { return this === undefined ? "no receiver" : "receiver"; } };
  const host: Holder = { name: "#h", f: source.m };
  {
    console.log((host.f)());
  }
}
function cellArrayRoundtripDot(): void {
  const fs: F[] = [label as F];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    console.log(host.f());
  }
}
function cellArrayRoundtripOptionalBoth(): void {
  const fs: F[] = [label as F];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellArrayRoundtripParenthesized(): void {
  const fs: F[] = [label as F];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    console.log((host.f)());
  }
}
function cellTupleRoundtripDot(): void {
  const pair: [string, F] = ["p", label as F];
  const host: Holder = { name: "#h", f: pair[1] };
  {
    console.log(host.f());
  }
}
function cellTupleRoundtripOptionalBoth(): void {
  const pair: [string, F] = ["p", label as F];
  const host: Holder = { name: "#h", f: pair[1] };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellTupleRoundtripParenthesized(): void {
  const pair: [string, F] = ["p", label as F];
  const host: Holder = { name: "#h", f: pair[1] };
  {
    console.log((host.f)());
  }
}
function cellArraySpreadDot(): void {
  const fs: F[] = [...[label as F]];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    console.log(host.f());
  }
}
function cellArraySpreadOptionalBoth(): void {
  const fs: F[] = [...[label as F]];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellArraySpreadParenthesized(): void {
  const fs: F[] = [...[label as F]];
  const host: Holder = { name: "#h", f: fs[0]! };
  {
    console.log((host.f)());
  }
}
function cellMapRoundtripDot(): void {
  const table = new Map<string, F>([["k", label as F]]);
  const host: Holder = { name: "#h", f: table.get("k")! };
  {
    console.log(host.f());
  }
}
function cellMapRoundtripOptionalBoth(): void {
  const table = new Map<string, F>([["k", label as F]]);
  const host: Holder = { name: "#h", f: table.get("k")! };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellMapRoundtripParenthesized(): void {
  const table = new Map<string, F>([["k", label as F]]);
  const host: Holder = { name: "#h", f: table.get("k")! };
  {
    console.log((host.f)());
  }
}
function cellSpreadDot(): void {
  const base = { f: label as F };
  const host: Holder = { name: "#h", ...base };
  {
    console.log(host.f());
  }
}
function cellSpreadOptionalBoth(): void {
  const base = { f: label as F };
  const host: Holder = { name: "#h", ...base };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellSpreadParenthesized(): void {
  const base = { f: label as F };
  const host: Holder = { name: "#h", ...base };
  {
    console.log((host.f)());
  }
}
function cellObjectAssignDot(): void {
  const host: Holder = Object.assign({ name: "#h" }, { f: label as F });
  {
    console.log(host.f());
  }
}
function cellObjectAssignOptionalBoth(): void {
  const host: Holder = Object.assign({ name: "#h" }, { f: label as F });
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellObjectAssignParenthesized(): void {
  const host: Holder = Object.assign({ name: "#h" }, { f: label as F });
  {
    console.log((host.f)());
  }
}
function cellClassFieldDot(): void {
  class Box { name = "#h"; f: F = label as F; }
  const host: Holder = new Box();
  {
    console.log(host.f());
  }
}
function cellClassFieldOptionalBoth(): void {
  class Box { name = "#h"; f: F = label as F; }
  const host: Holder = new Box();
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellClassFieldParenthesized(): void {
  class Box { name = "#h"; f: F = label as F; }
  const host: Holder = new Box();
  {
    console.log((host.f)());
  }
}
function cellClassConstructorDot(): void {
  class Box { name = "#h"; f: F; constructor(g: F) { this.f = g; } }
  const host: Holder = new Box(label as F);
  {
    console.log(host.f());
  }
}
function cellClassConstructorOptionalBoth(): void {
  class Box { name = "#h"; f: F; constructor(g: F) { this.f = g; } }
  const host: Holder = new Box(label as F);
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellClassConstructorParenthesized(): void {
  class Box { name = "#h"; f: F; constructor(g: F) { this.f = g; } }
  const host: Holder = new Box(label as F);
  {
    console.log((host.f)());
  }
}
function cellConditionalDot(): void {
  const host: Holder = { name: "#h", f: process.argv.length > 100 ? (): string => "arrow" : (label as F) };
  {
    console.log(host.f());
  }
}
function cellConditionalOptionalBoth(): void {
  const host: Holder = { name: "#h", f: process.argv.length > 100 ? (): string => "arrow" : (label as F) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellConditionalParenthesized(): void {
  const host: Holder = { name: "#h", f: process.argv.length > 100 ? (): string => "arrow" : (label as F) };
  {
    console.log((host.f)());
  }
}
function cellLogicalOrDot(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none || (label as F) };
  {
    console.log(host.f());
  }
}
function cellLogicalOrOptionalBoth(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none || (label as F) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellLogicalOrParenthesized(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none || (label as F) };
  {
    console.log((host.f)());
  }
}
function cellNullishDot(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none ?? (label as F) };
  {
    console.log(host.f());
  }
}
function cellNullishOptionalBoth(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none ?? (label as F) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellNullishParenthesized(): void {
  const none: F | undefined = process.argv.length > 100 ? () => "arrow" : undefined;
  const host: Holder = { name: "#h", f: none ?? (label as F) };
  {
    console.log((host.f)());
  }
}
function cellThroughAnyDot(): void {
  const loose: any = label;
  const host: Holder = { name: "#h", f: loose };
  {
    console.log(host.f());
  }
}
function cellThroughAnyOptionalBoth(): void {
  const loose: any = label;
  const host: Holder = { name: "#h", f: loose };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellThroughAnyParenthesized(): void {
  const loose: any = label;
  const host: Holder = { name: "#h", f: loose };
  {
    console.log((host.f)());
  }
}
function cellBindDot(): void {
  const host: Holder = { name: "#h", f: (label as F).bind({ name: "bound" }) };
  {
    console.log(host.f());
  }
}
function cellBindOptionalBoth(): void {
  const host: Holder = { name: "#h", f: (label as F).bind({ name: "bound" }) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellBindParenthesized(): void {
  const host: Holder = { name: "#h", f: (label as F).bind({ name: "bound" }) };
  {
    console.log((host.f)());
  }
}
function cellBindUndefinedDot(): void {
  const host: Holder = { name: "#h", f: (label as F).bind(undefined) };
  {
    console.log(host.f());
  }
}
function cellBindUndefinedOptionalBoth(): void {
  const host: Holder = { name: "#h", f: (label as F).bind(undefined) };
  {
    const maybe: { name: string; f?: F } | undefined = process.argv.length > 100 ? undefined : host;
    console.log(maybe?.f?.());
  }
}
function cellBindUndefinedParenthesized(): void {
  const host: Holder = { name: "#h", f: (label as F).bind(undefined) };
  {
    console.log((host.f)());
  }
}

console.log("arrow / dot");
cellArrowDot();
console.log("arrow / optional-both");
cellArrowOptionalBoth();
console.log("arrow / parenthesized");
cellArrowParenthesized();
console.log("direct / dot");
cellDirectDot();
console.log("direct / element-literal");
cellDirectElementLiteral();
console.log("direct / element-const");
cellDirectElementConst();
console.log("direct / element-dynamic");
cellDirectElementDynamic();
console.log("direct / optional-call");
cellDirectOptionalCall();
console.log("direct / optional-holder");
cellDirectOptionalHolder();
console.log("direct / optional-element");
cellDirectOptionalElement();
console.log("direct / optional-both");
cellDirectOptionalBoth();
console.log("direct / optional-parenthesized");
cellDirectOptionalParenthesized();
console.log("direct / optional-nested-call");
cellDirectOptionalNestedCall();
console.log("direct / optional-index");
cellDirectOptionalIndex();
console.log("direct / non-null");
cellDirectNonNull();
console.log("direct / narrowed-member");
cellDirectNarrowedMember();
console.log("direct / parenthesized");
cellDirectParenthesized();
console.log("direct / as-cast");
cellDirectAsCast();
console.log("direct / satisfies");
cellDirectSatisfies();
console.log("direct / parameter");
cellDirectParameter();
console.log("direct / returned-holder");
cellDirectReturnedHolder();
console.log("direct / nested");
cellDirectNested();
console.log("direct / nested-optional");
cellDirectNestedOptional();
console.log("direct / inline-holder");
cellDirectInlineHolder();
console.log("direct / closure");
cellDirectClosure();
console.log("direct / loop-reassigned");
cellDirectLoopReassigned();
console.log("direct / in-expression");
cellDirectInExpression();
console.log("direct / spread-arguments");
cellDirectSpreadArguments();
console.log("direct / this-holder");
cellDirectThisHolder();
console.log("direct / class-field-holder");
cellDirectClassFieldHolder();
console.log("direct / inherited-field");
cellDirectInheritedField();
console.log("direct / class-parenthesized");
cellDirectClassParenthesized();
console.log("direct / class-element");
cellDirectClassElement();
console.log("direct / class-optional-call");
cellDirectClassOptionalCall();
console.log("direct / class-optional-holder");
cellDirectClassOptionalHolder();
console.log("direct / class-this-parenthesized");
cellDirectClassThisParenthesized();
console.log("direct / any-holder");
cellDirectAnyHolder();
console.log("direct / unknown-narrowed-holder");
cellDirectUnknownNarrowedHolder();
console.log("direct / class-view");
cellDirectClassView();
console.log("direct / union-distinct");
cellDirectUnionDistinct();
console.log("direct / union-element");
cellDirectUnionElement();
console.log("direct / union-optional-call");
cellDirectUnionOptionalCall();
console.log("direct / union-parenthesized");
cellDirectUnionParenthesized();
console.log("direct / union-ternary");
cellDirectUnionTernary();
console.log("direct / union-class-record");
cellDirectUnionClassRecord();
console.log("direct / tuple-holder");
cellDirectTupleHolder();
console.log("direct / array-holder");
cellDirectArrayHolder();
console.log("direct / dictionary-holder");
cellDirectDictionaryHolder();
console.log("direct / tuple-destructured-holder");
cellDirectTupleDestructuredHolder();
console.log("direct / map-value-holder");
cellDirectMapValueHolder();
console.log("direct / conditional-holder");
cellDirectConditionalHolder();
console.log("direct / getter-holder");
cellDirectGetterHolder();
console.log("direct / apply-holder");
cellDirectApplyHolder();
console.log("direct / call-other");
cellDirectCallOther();
console.log("direct / bind-holder");
cellDirectBindHolder();
console.log("direct / reflect-apply");
cellDirectReflectApply();
console.log("direct / detached");
cellDirectDetached();
console.log("direct / comma");
cellDirectComma();
console.log("direct / destructured-call");
cellDirectDestructuredCall();
console.log("direct / callback-argument");
cellDirectCallbackArgument();
console.log("direct / logical-callee");
cellDirectLogicalCallee();
console.log("direct / conditional-callee");
cellDirectConditionalCallee();
console.log("direct / call-undefined");
cellDirectCallUndefined();
console.log("direct / map-get");
cellDirectMapGet();
console.log("direct / array-callback");
cellDirectArrayCallback();
console.log("function-expression / dot");
cellFunctionExpressionDot();
console.log("function-expression / optional-both");
cellFunctionExpressionOptionalBoth();
console.log("function-expression / parenthesized");
cellFunctionExpressionParenthesized();
console.log("method-shorthand / dot");
cellMethodShorthandDot();
console.log("method-shorthand / element-literal");
cellMethodShorthandElementLiteral();
console.log("method-shorthand / element-const");
cellMethodShorthandElementConst();
console.log("method-shorthand / element-dynamic");
cellMethodShorthandElementDynamic();
console.log("method-shorthand / optional-call");
cellMethodShorthandOptionalCall();
console.log("method-shorthand / optional-holder");
cellMethodShorthandOptionalHolder();
console.log("method-shorthand / optional-element");
cellMethodShorthandOptionalElement();
console.log("method-shorthand / optional-both");
cellMethodShorthandOptionalBoth();
console.log("method-shorthand / optional-parenthesized");
cellMethodShorthandOptionalParenthesized();
console.log("method-shorthand / optional-nested-call");
cellMethodShorthandOptionalNestedCall();
console.log("method-shorthand / optional-index");
cellMethodShorthandOptionalIndex();
console.log("method-shorthand / non-null");
cellMethodShorthandNonNull();
console.log("method-shorthand / narrowed-member");
cellMethodShorthandNarrowedMember();
console.log("method-shorthand / parenthesized");
cellMethodShorthandParenthesized();
console.log("method-shorthand / as-cast");
cellMethodShorthandAsCast();
console.log("method-shorthand / satisfies");
cellMethodShorthandSatisfies();
console.log("method-shorthand / parameter");
cellMethodShorthandParameter();
console.log("method-shorthand / returned-holder");
cellMethodShorthandReturnedHolder();
console.log("method-shorthand / nested");
cellMethodShorthandNested();
console.log("method-shorthand / nested-optional");
cellMethodShorthandNestedOptional();
console.log("method-shorthand / inline-holder");
cellMethodShorthandInlineHolder();
console.log("method-shorthand / closure");
cellMethodShorthandClosure();
console.log("method-shorthand / loop-reassigned");
cellMethodShorthandLoopReassigned();
console.log("method-shorthand / in-expression");
cellMethodShorthandInExpression();
console.log("method-shorthand / spread-arguments");
cellMethodShorthandSpreadArguments();
console.log("method-shorthand / this-holder");
cellMethodShorthandThisHolder();
console.log("method-shorthand / class-field-holder");
cellMethodShorthandClassFieldHolder();
console.log("method-shorthand / inherited-field");
cellMethodShorthandInheritedField();
console.log("method-shorthand / class-parenthesized");
cellMethodShorthandClassParenthesized();
console.log("method-shorthand / class-element");
cellMethodShorthandClassElement();
console.log("method-shorthand / class-optional-call");
cellMethodShorthandClassOptionalCall();
console.log("method-shorthand / class-optional-holder");
cellMethodShorthandClassOptionalHolder();
console.log("method-shorthand / class-this-parenthesized");
cellMethodShorthandClassThisParenthesized();
console.log("method-shorthand / any-holder");
cellMethodShorthandAnyHolder();
console.log("method-shorthand / unknown-narrowed-holder");
cellMethodShorthandUnknownNarrowedHolder();
console.log("method-shorthand / class-view");
cellMethodShorthandClassView();
console.log("method-shorthand / union-distinct");
cellMethodShorthandUnionDistinct();
console.log("method-shorthand / union-element");
cellMethodShorthandUnionElement();
console.log("method-shorthand / union-optional-call");
cellMethodShorthandUnionOptionalCall();
console.log("method-shorthand / union-parenthesized");
cellMethodShorthandUnionParenthesized();
console.log("method-shorthand / union-ternary");
cellMethodShorthandUnionTernary();
console.log("method-shorthand / union-class-record");
cellMethodShorthandUnionClassRecord();
console.log("method-shorthand / tuple-holder");
cellMethodShorthandTupleHolder();
console.log("method-shorthand / array-holder");
cellMethodShorthandArrayHolder();
console.log("method-shorthand / dictionary-holder");
cellMethodShorthandDictionaryHolder();
console.log("method-shorthand / tuple-destructured-holder");
cellMethodShorthandTupleDestructuredHolder();
console.log("method-shorthand / map-value-holder");
cellMethodShorthandMapValueHolder();
console.log("method-shorthand / conditional-holder");
cellMethodShorthandConditionalHolder();
console.log("method-shorthand / getter-holder");
cellMethodShorthandGetterHolder();
console.log("method-shorthand / apply-holder");
cellMethodShorthandApplyHolder();
console.log("method-shorthand / call-other");
cellMethodShorthandCallOther();
console.log("method-shorthand / bind-holder");
cellMethodShorthandBindHolder();
console.log("method-shorthand / reflect-apply");
cellMethodShorthandReflectApply();
console.log("method-shorthand / detached");
cellMethodShorthandDetached();
console.log("method-shorthand / comma");
cellMethodShorthandComma();
console.log("method-shorthand / destructured-call");
cellMethodShorthandDestructuredCall();
console.log("method-shorthand / callback-argument");
cellMethodShorthandCallbackArgument();
console.log("method-shorthand / logical-callee");
cellMethodShorthandLogicalCallee();
console.log("method-shorthand / conditional-callee");
cellMethodShorthandConditionalCallee();
console.log("method-shorthand / call-undefined");
cellMethodShorthandCallUndefined();
console.log("method-shorthand / map-get");
cellMethodShorthandMapGet();
console.log("method-shorthand / array-callback");
cellMethodShorthandArrayCallback();
console.log("getter / dot");
cellGetterDot();
console.log("getter / optional-both");
cellGetterOptionalBoth();
console.log("getter / parenthesized");
cellGetterParenthesized();
console.log("computed-literal / dot");
cellComputedLiteralDot();
console.log("computed-literal / optional-both");
cellComputedLiteralOptionalBoth();
console.log("computed-literal / parenthesized");
cellComputedLiteralParenthesized();
console.log("computed-const / dot");
cellComputedConstDot();
console.log("computed-const / optional-both");
cellComputedConstOptionalBoth();
console.log("computed-const / parenthesized");
cellComputedConstParenthesized();
console.log("computed-unknown / dot");
cellComputedUnknownDot();
console.log("computed-unknown / optional-both");
cellComputedUnknownOptionalBoth();
console.log("computed-unknown / parenthesized");
cellComputedUnknownParenthesized();
console.log("keyed-assign-unknown / dot");
cellKeyedAssignUnknownDot();
console.log("keyed-assign-unknown / optional-both");
cellKeyedAssignUnknownOptionalBoth();
console.log("keyed-assign-unknown / parenthesized");
cellKeyedAssignUnknownParenthesized();
console.log("assigned-later / dot");
cellAssignedLaterDot();
console.log("assigned-later / optional-both");
cellAssignedLaterOptionalBoth();
console.log("assigned-later / parenthesized");
cellAssignedLaterParenthesized();
console.log("assigned-element / dot");
cellAssignedElementDot();
console.log("assigned-element / optional-both");
cellAssignedElementOptionalBoth();
console.log("assigned-element / parenthesized");
cellAssignedElementParenthesized();
console.log("shorthand / dot");
cellShorthandDot();
console.log("shorthand / optional-both");
cellShorthandOptionalBoth();
console.log("shorthand / parenthesized");
cellShorthandParenthesized();
console.log("variable-let / dot");
cellVariableLetDot();
console.log("variable-let / optional-both");
cellVariableLetOptionalBoth();
console.log("variable-let / parenthesized");
cellVariableLetParenthesized();
console.log("closure-capture / dot");
cellClosureCaptureDot();
console.log("closure-capture / optional-both");
cellClosureCaptureOptionalBoth();
console.log("closure-capture / parenthesized");
cellClosureCaptureParenthesized();
console.log("factory-param / dot");
cellFactoryParamDot();
console.log("factory-param / element-literal");
cellFactoryParamElementLiteral();
console.log("factory-param / element-const");
cellFactoryParamElementConst();
console.log("factory-param / element-dynamic");
cellFactoryParamElementDynamic();
console.log("factory-param / optional-call");
cellFactoryParamOptionalCall();
console.log("factory-param / optional-holder");
cellFactoryParamOptionalHolder();
console.log("factory-param / optional-element");
cellFactoryParamOptionalElement();
console.log("factory-param / optional-both");
cellFactoryParamOptionalBoth();
console.log("factory-param / optional-parenthesized");
cellFactoryParamOptionalParenthesized();
console.log("factory-param / optional-nested-call");
cellFactoryParamOptionalNestedCall();
console.log("factory-param / optional-index");
cellFactoryParamOptionalIndex();
console.log("factory-param / non-null");
cellFactoryParamNonNull();
console.log("factory-param / narrowed-member");
cellFactoryParamNarrowedMember();
console.log("factory-param / parenthesized");
cellFactoryParamParenthesized();
console.log("factory-param / as-cast");
cellFactoryParamAsCast();
console.log("factory-param / satisfies");
cellFactoryParamSatisfies();
console.log("factory-param / parameter");
cellFactoryParamParameter();
console.log("factory-param / returned-holder");
cellFactoryParamReturnedHolder();
console.log("factory-param / nested");
cellFactoryParamNested();
console.log("factory-param / nested-optional");
cellFactoryParamNestedOptional();
console.log("factory-param / inline-holder");
cellFactoryParamInlineHolder();
console.log("factory-param / closure");
cellFactoryParamClosure();
console.log("factory-param / loop-reassigned");
cellFactoryParamLoopReassigned();
console.log("factory-param / in-expression");
cellFactoryParamInExpression();
console.log("factory-param / spread-arguments");
cellFactoryParamSpreadArguments();
console.log("factory-param / this-holder");
cellFactoryParamThisHolder();
console.log("factory-param / class-field-holder");
cellFactoryParamClassFieldHolder();
console.log("factory-param / inherited-field");
cellFactoryParamInheritedField();
console.log("factory-param / class-parenthesized");
cellFactoryParamClassParenthesized();
console.log("factory-param / class-element");
cellFactoryParamClassElement();
console.log("factory-param / class-optional-call");
cellFactoryParamClassOptionalCall();
console.log("factory-param / class-optional-holder");
cellFactoryParamClassOptionalHolder();
console.log("factory-param / class-this-parenthesized");
cellFactoryParamClassThisParenthesized();
console.log("factory-param / any-holder");
cellFactoryParamAnyHolder();
console.log("factory-param / unknown-narrowed-holder");
cellFactoryParamUnknownNarrowedHolder();
console.log("factory-param / class-view");
cellFactoryParamClassView();
console.log("factory-param / union-distinct");
cellFactoryParamUnionDistinct();
console.log("factory-param / union-element");
cellFactoryParamUnionElement();
console.log("factory-param / union-optional-call");
cellFactoryParamUnionOptionalCall();
console.log("factory-param / union-parenthesized");
cellFactoryParamUnionParenthesized();
console.log("factory-param / union-ternary");
cellFactoryParamUnionTernary();
console.log("factory-param / union-class-record");
cellFactoryParamUnionClassRecord();
console.log("factory-param / tuple-holder");
cellFactoryParamTupleHolder();
console.log("factory-param / array-holder");
cellFactoryParamArrayHolder();
console.log("factory-param / dictionary-holder");
cellFactoryParamDictionaryHolder();
console.log("factory-param / tuple-destructured-holder");
cellFactoryParamTupleDestructuredHolder();
console.log("factory-param / map-value-holder");
cellFactoryParamMapValueHolder();
console.log("factory-param / conditional-holder");
cellFactoryParamConditionalHolder();
console.log("factory-param / getter-holder");
cellFactoryParamGetterHolder();
console.log("factory-param / apply-holder");
cellFactoryParamApplyHolder();
console.log("factory-param / call-other");
cellFactoryParamCallOther();
console.log("factory-param / bind-holder");
cellFactoryParamBindHolder();
console.log("factory-param / reflect-apply");
cellFactoryParamReflectApply();
console.log("factory-param / detached");
cellFactoryParamDetached();
console.log("factory-param / comma");
cellFactoryParamComma();
console.log("factory-param / destructured-call");
cellFactoryParamDestructuredCall();
console.log("factory-param / callback-argument");
cellFactoryParamCallbackArgument();
console.log("factory-param / logical-callee");
cellFactoryParamLogicalCallee();
console.log("factory-param / conditional-callee");
cellFactoryParamConditionalCallee();
console.log("factory-param / call-undefined");
cellFactoryParamCallUndefined();
console.log("factory-param / map-get");
cellFactoryParamMapGet();
console.log("factory-param / array-callback");
cellFactoryParamArrayCallback();
console.log("default-param / dot");
cellDefaultParamDot();
console.log("default-param / optional-both");
cellDefaultParamOptionalBoth();
console.log("default-param / parenthesized");
cellDefaultParamParenthesized();
console.log("returned / dot");
cellReturnedDot();
console.log("returned / optional-both");
cellReturnedOptionalBoth();
console.log("returned / parenthesized");
cellReturnedParenthesized();
console.log("generic-identity / dot");
cellGenericIdentityDot();
console.log("generic-identity / optional-both");
cellGenericIdentityOptionalBoth();
console.log("generic-identity / parenthesized");
cellGenericIdentityParenthesized();
console.log("callback-param / dot");
cellCallbackParamDot();
console.log("callback-param / optional-both");
cellCallbackParamOptionalBoth();
console.log("callback-param / parenthesized");
cellCallbackParamParenthesized();
console.log("string-index-copy / dot");
cellStringIndexCopyDot();
console.log("string-index-copy / optional-both");
cellStringIndexCopyOptionalBoth();
console.log("string-index-copy / parenthesized");
cellStringIndexCopyParenthesized();
console.log("member-copy / dot");
cellMemberCopyDot();
console.log("member-copy / optional-both");
cellMemberCopyOptionalBoth();
console.log("member-copy / parenthesized");
cellMemberCopyParenthesized();
console.log("destructured / dot");
cellDestructuredDot();
console.log("destructured / optional-both");
cellDestructuredOptionalBoth();
console.log("destructured / parenthesized");
cellDestructuredParenthesized();
console.log("destructured-renamed / dot");
cellDestructuredRenamedDot();
console.log("destructured-renamed / optional-both");
cellDestructuredRenamedOptionalBoth();
console.log("destructured-renamed / parenthesized");
cellDestructuredRenamedParenthesized();
console.log("member-relay / dot");
cellMemberRelayDot();
console.log("member-relay / optional-both");
cellMemberRelayOptionalBoth();
console.log("member-relay / parenthesized");
cellMemberRelayParenthesized();
console.log("object-literal-method / dot");
cellObjectLiteralMethodDot();
console.log("object-literal-method / optional-both");
cellObjectLiteralMethodOptionalBoth();
console.log("object-literal-method / parenthesized");
cellObjectLiteralMethodParenthesized();
console.log("array-roundtrip / dot");
cellArrayRoundtripDot();
console.log("array-roundtrip / optional-both");
cellArrayRoundtripOptionalBoth();
console.log("array-roundtrip / parenthesized");
cellArrayRoundtripParenthesized();
console.log("tuple-roundtrip / dot");
cellTupleRoundtripDot();
console.log("tuple-roundtrip / optional-both");
cellTupleRoundtripOptionalBoth();
console.log("tuple-roundtrip / parenthesized");
cellTupleRoundtripParenthesized();
console.log("array-spread / dot");
cellArraySpreadDot();
console.log("array-spread / optional-both");
cellArraySpreadOptionalBoth();
console.log("array-spread / parenthesized");
cellArraySpreadParenthesized();
console.log("map-roundtrip / dot");
cellMapRoundtripDot();
console.log("map-roundtrip / optional-both");
cellMapRoundtripOptionalBoth();
console.log("map-roundtrip / parenthesized");
cellMapRoundtripParenthesized();
console.log("spread / dot");
cellSpreadDot();
console.log("spread / optional-both");
cellSpreadOptionalBoth();
console.log("spread / parenthesized");
cellSpreadParenthesized();
console.log("object-assign / dot");
cellObjectAssignDot();
console.log("object-assign / optional-both");
cellObjectAssignOptionalBoth();
console.log("object-assign / parenthesized");
cellObjectAssignParenthesized();
console.log("class-field / dot");
cellClassFieldDot();
console.log("class-field / optional-both");
cellClassFieldOptionalBoth();
console.log("class-field / parenthesized");
cellClassFieldParenthesized();
console.log("class-constructor / dot");
cellClassConstructorDot();
console.log("class-constructor / optional-both");
cellClassConstructorOptionalBoth();
console.log("class-constructor / parenthesized");
cellClassConstructorParenthesized();
console.log("conditional / dot");
cellConditionalDot();
console.log("conditional / optional-both");
cellConditionalOptionalBoth();
console.log("conditional / parenthesized");
cellConditionalParenthesized();
console.log("logical-or / dot");
cellLogicalOrDot();
console.log("logical-or / optional-both");
cellLogicalOrOptionalBoth();
console.log("logical-or / parenthesized");
cellLogicalOrParenthesized();
console.log("nullish / dot");
cellNullishDot();
console.log("nullish / optional-both");
cellNullishOptionalBoth();
console.log("nullish / parenthesized");
cellNullishParenthesized();
console.log("through-any / dot");
cellThroughAnyDot();
console.log("through-any / optional-both");
cellThroughAnyOptionalBoth();
console.log("through-any / parenthesized");
cellThroughAnyParenthesized();
console.log("bind / dot");
cellBindDot();
console.log("bind / optional-both");
cellBindOptionalBoth();
console.log("bind / parenthesized");
cellBindParenthesized();
console.log("bind-undefined / dot");
cellBindUndefinedDot();
console.log("bind-undefined / optional-both");
cellBindUndefinedOptionalBoth();
console.log("bind-undefined / parenthesized");
cellBindUndefinedParenthesized();
export {};
