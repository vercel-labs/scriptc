// Object literals returned from async arrows typed by a method signature
// (`resolve(input): Promise<AuthResult | undefined>`), with destructured
// parameters. The return position's contextual type is
// `AuthResult | undefined | PromiseLike<AuthResult | undefined>`; the
// literal must build as AuthResult so its nested header record reaches the
// pure index record ProviderHeaders (null-valued keys included), exactly as
// in a sync function.
type ProviderHeaders = Record<string, string | null>;
interface ModelAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
}
interface AuthResult {
  auth: ModelAuth;
  env?: Record<string, string>;
  source?: string;
}
interface Ctx {
  env(name: string): Promise<string | undefined>;
}
interface Credential {
  type: "api_key";
  key?: string;
}
interface Auth {
  name: string;
  resolve(input: { ctx: Ctx; credential?: Credential; signal: AbortSignal }): Promise<AuthResult | undefined>;
  peek?(input: { ctx: Ctx }): AuthResult | undefined;
}

function tokenAuth(): Auth {
  return {
    name: "token",
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored" };
      const token = await ctx.env("TOKEN");
      if (token) return { auth: { headers: { Authorization: `Bearer ${token}` } }, source: "TOKEN" };
      return undefined;
    },
  };
}

function gatewayAuth(): Auth {
  return {
    name: "gateway",
    resolve: async ({ ctx }) => {
      const key = await ctx.env("KEY");
      if (!key) return undefined;
      return {
        auth: {
          headers: {
            "cf-aig-authorization": `Bearer ${key}`,
            Authorization: null,
            "x-api-key": null,
          },
        },
        env: { ACCOUNT: "a1" },
        source: "KEY",
      };
    },
    peek: ({ ctx }) => (ctx ? { auth: { headers: { "x-peek": "1" } } } : undefined),
  };
}

function boundAuth(): Auth {
  return {
    name: "bound",
    resolve: async ({ ctx }) => {
      const token = await ctx.env("TOKEN");
      const headers = { Authorization: `Bearer ${token ?? "none"}` };
      return { auth: { headers }, source: "bound" };
    },
  };
}

async function plain(flag: boolean): Promise<{ id: string; tags?: Record<string, string | null> } | undefined> {
  return flag ? { id: "p", tags: { a: "1", b: null } } : undefined;
}

function show(result: AuthResult | undefined): string {
  if (result === undefined) return "undefined";
  const headers = result.auth.headers ?? {};
  const keys = Object.keys(headers).sort();
  return `${result.source ?? "-"} key=${result.auth.apiKey ?? "-"} ${keys.map((k) => `${k}=${String(headers[k])}`).join(" ")} env=${JSON.stringify(result.env ?? null)}`;
}

async function main(): Promise<void> {
  const env = new Map<string, string>([
    ["KEY", "k1"],
    ["TOKEN", "t1"],
  ]);
  const ctx: Ctx = { env: async (name) => env.get(name) };
  const signal = new AbortController().signal;
  const token = tokenAuth();
  console.log(show(await token.resolve({ ctx, credential: { type: "api_key", key: "s1" }, signal })));
  console.log(show(await token.resolve({ ctx, signal })));
  console.log(show(await gatewayAuth().resolve({ ctx, signal })));
  console.log(show(gatewayAuth().peek?.({ ctx })));
  console.log(show(await boundAuth().resolve({ ctx, signal })));
  env.clear();
  console.log(show(await token.resolve({ ctx, signal })));
  console.log(show(await gatewayAuth().resolve({ ctx, signal })));
  console.log(show(await boundAuth().resolve({ ctx, signal })));
  const p = await plain(true);
  console.log(p?.id, JSON.stringify(p?.tags), (await plain(false)) === undefined);
}
main();
