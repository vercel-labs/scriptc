// A call through an optional callable member of a union-of-records value
// stays refused when the arms hold the member at different function types:
// no one shared read serves the call. (Arms that agree on the member
// compile: tests/corpus/union-receiver-optional-callable.ts.)
type Headers = Record<string, string | null>;

interface Base {
  headers?: Headers;
}

interface OptA extends Base {
  alpha?: number;
  transform?: (headers: Headers) => Headers | Promise<Headers>;
}

interface OptB extends Base {
  beta?: string;
  transform?: (headers: Headers) => Promise<Headers>;
}

type Transformed = Base & { transform?: (headers: Headers) => Headers | Promise<Headers> };

async function apply<TOptions extends Transformed>(options: TOptions | undefined): Promise<Headers> {
  let headers: Headers = { ...(options?.headers ?? {}) };
  if (options?.transform) headers = await options.transform(headers);
  return headers;
}

async function run(options?: OptA | OptB): Promise<void> {
  console.log(JSON.stringify(await apply(options)));
}

run({ alpha: 1, transform: (headers) => ({ ...headers, a: "1" }) });
run({ beta: "b", transform: async (headers) => ({ ...headers, b: "2" }) });
