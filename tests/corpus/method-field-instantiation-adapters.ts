// Provider<"alpha"> and Provider<"beta"> into Provider<Api>: method fields
// whose parameter is the instantiation-dependent Model<TApi> (a
// conditional compat member that is `never` for beta) convert through a
// checked adapter. TypeScript admits the pair by method bivariance; every
// call here passes each provider its own models, so nothing traps.
type Api = "alpha" | "beta";
interface AlphaCompat {
  strict?: boolean;
}
interface Model<TApi extends Api> {
  id: string;
  api: TApi;
  compat?: TApi extends "alpha" ? AlphaCompat : never;
}
interface Provider<TApi extends Api = Api> {
  readonly id: string;
  models(): Model<TApi>[];
  cancel?(model: Model<TApi>, handle: string): Promise<void>;
}
function alphaProvider(): Provider<"alpha"> {
  return {
    id: "a",
    models: () => [{ id: "a1", api: "alpha", compat: { strict: true } }],
    cancel: async (model, handle) => {
      console.log("cancel", model.id, handle, String(model.compat?.strict));
    },
  };
}
function betaProvider(): Provider<"beta"> {
  return {
    id: "b",
    models: () => [{ id: "b1", api: "beta" }],
    cancel: async (model, handle) => {
      console.log("beta cancel", model.id, handle, model.compat === undefined);
    },
  };
}
function plainProvider(): Provider<"beta"> {
  return { id: "p", models: () => [] };
}
function all(): Provider[] {
  return [alphaProvider(), betaProvider(), plainProvider()];
}
async function main(): Promise<void> {
  for (const p of all()) {
    const [m] = p.models();
    console.log(p.id, m?.id, m?.api, p.cancel === undefined);
    if (m) await p.cancel?.(m, "h");
  }
}
main();
