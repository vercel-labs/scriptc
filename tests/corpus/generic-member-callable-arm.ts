// A call through an OPTIONAL function-typed member of a generic instantiation
// (`o?.transformHeaders(x)` inside `f<TO extends Transforms>(o: TO)`). The
// checker types the narrowed member with the CONSTRAINT's declared signature
// while the instantiated record stores its own, so the stored record slot
// holds one callable arm beside the empty one; the call goes through that
// arm whatever signature the constraint declares.
type Headers = Record<string, string | null>;

interface Transforms {
  transformHeaders?: (headers: Headers) => Headers | Promise<Headers>;
}

interface RequestOptions<TModel> {
  apiKey?: string;
  headers?: Headers;
  model?: TModel;
}

function mergeHeaders(a: Headers, b: Headers | undefined): Headers {
  return { ...a, ...(b ?? {}) };
}

class Client {
  // The argument's declared member returns a plain record: the instance's
  // own contract, narrower than the constraint's maybe-promise one.
  sync(o: { apiKey?: string; headers?: Headers; transformHeaders?: (h: Headers) => Headers }): Promise<Headers> {
    return this.apply("model", o);
  }
  // The argument's declared member may answer a promise.
  deferred(o: { transformHeaders?: (h: Headers) => Headers | Promise<Headers> }): Promise<Headers> {
    return this.apply("model", o);
  }
  // No value at all: the optional member stays empty, the call is skipped.
  plain(o: { apiKey?: string }): Promise<Headers> {
    return this.apply("model", o);
  }

  private async apply<TModel extends string, TOptions extends RequestOptions<TModel> & Transforms>(
    model: TModel,
    options: TOptions | undefined,
  ): Promise<Headers> {
    let headers = mergeHeaders({ accept: "json" }, options?.headers);
    if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
    return headers;
  }
}

const client = new Client();
console.log(await client.sync({ apiKey: "k", transformHeaders: (h) => ({ ...h, auth: "sync" }) }));
console.log(await client.deferred({ transformHeaders: async (h) => ({ ...h, auth: "async" }) }));
console.log(await client.plain({ apiKey: "k" }));

// The same narrowing without a guard: the empty arm is checked at the call.
async function guarded<TO extends Transforms>(o: TO | undefined): Promise<number> {
  if (o && o.transformHeaders) {
    const merged = await o.transformHeaders({ a: "1" });
    return Object.keys(merged).length;
  }
  return -1;
}
console.log(await guarded({ transformHeaders: (h) => ({ ...h, b: "2" }) }));
console.log(await guarded(undefined));
