// A call through an OPTIONAL callable member of a value whose type is a
// union of records (a generic function's options parameter bound to the
// union of every per-kind option record): each arm declares the member with
// the same type, the checker narrows it to the function at the call, and
// the call dispatches on the arm the value holds.
type Headers = Record<string, string | null>;

interface Transforms {
  transform?: (headers: Headers) => Headers | Promise<Headers>;
  label?: (prefix: string) => string;
}

interface Base {
  apiKey?: string;
  headers?: Headers;
}

interface OptA extends Base {
  alpha?: number;
}

interface OptB extends Base {
  beta?: string;
}

interface OptMap {
  a: OptA;
  b: OptB;
}

type Kind = keyof OptMap | (string & {});
type OptsFor<K extends Kind> = K extends keyof OptMap ? OptMap[K] : Base & { other?: boolean };
type AllOpts<K extends Kind> = OptsFor<K> & Transforms;

interface Model<K extends Kind> {
  kind: K;
  id: string;
}

type AnyModel = Model<Kind>;

class Requests {
  private async apply<TModel extends AnyModel, TOptions extends Base & Transforms>(
    model: TModel,
    options: TOptions | undefined,
  ): Promise<{ model: TModel; headers: Headers }> {
    let headers: Headers = { ...(options?.headers ?? {}) };
    if (options?.transform) headers = await options.transform(headers ?? {});
    return { model, headers };
  }

  private describe<TOptions extends Base & Transforms>(options: TOptions | undefined): string {
    if (options && options.label) return options.label("label");
    return options?.label !== undefined ? options.label("ternary") : "none";
  }

  async run<K extends Kind>(model: Model<K>, options?: AllOpts<K>): Promise<string> {
    const widened = options as AllOpts<Kind> | undefined;
    const { headers } = await this.apply(model, widened);
    return this.describe(widened) + " " + JSON.stringify(headers);
  }
}

async function main(): Promise<void> {
  const requests = new Requests();
  console.log(
    await requests.run(
      { kind: "a", id: "m" },
      { headers: { h: "1" }, alpha: 1, transform: (h) => ({ ...h, x: "sync" }) },
    ),
  );
  console.log(await requests.run({ kind: "b", id: "m" }, { headers: { h: "2" }, beta: "z" }));
  console.log(await requests.run({ kind: "a", id: "m" }));
  console.log(
    await requests.run(
      { kind: "b", id: "m" },
      {
        beta: "z",
        label: (prefix) => prefix + "!",
        transform: async (h) => ({ ...h, later: "async", gone: null }),
      },
    ),
  );
  console.log(
    await requests.run({ kind: "custom", id: "m" }, { other: true, label: (prefix) => prefix + "?" }),
  );
}

main();
