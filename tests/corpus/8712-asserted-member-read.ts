// A CAST that intersects a member onto a record the source layout never
// declared: `raw as Omit<Opts, "k"> & ProviderRequestOptions<M>` maps to a
// record without the `sessionId` slot, while `"sessionId" in options` proves
// the key. Node reads the property off the actual object — the extra value
// when the caller supplied one, undefined when it did not — so the read is
// the checked-dynamic keyed read of the stored value.
interface ProviderHeaders {
  [name: string]: string | null;
}

interface ProviderRequestOptions<TModel> {
  apiKey?: string;
  transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders;
}

type Api = "a" | "b";

interface ApiOptionsMap {
  a: { aOnly?: string };
  b: { bOnly?: number };
}

type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : ProviderRequestOptions<TApi> & Record<string, unknown>;

function prepare<TApi, TModel>(raw: unknown): string | undefined {
  const providerOptions = raw as Omit<ApiStreamOptions<Api>, "transformHeaders"> &
    ProviderRequestOptions<TModel>;
  return "sessionId" in providerOptions && typeof providerOptions.sessionId === "string"
    ? providerOptions.sessionId
    : undefined;
}

console.log("a", String(prepare<"a", string>({ apiKey: "k", sessionId: "s-1" })));
console.log("b", String(prepare<"a", string>({ apiKey: "k" })));
console.log("c", String(prepare<"b", string>({ bOnly: 2, sessionId: 7 })));
