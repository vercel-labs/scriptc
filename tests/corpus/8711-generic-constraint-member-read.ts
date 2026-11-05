// A member a GENERIC receiver's constraint does not store: `"sessionId" in
// options` narrows `TOptions` to `TOptions & Record<"sessionId", unknown>`,
// and the instantiation is a union of option shapes that never declares the
// member. Node reads the property off the object it actually has — undefined
// when it lacks the key — so the read is the checked-dynamic keyed read of
// the stored value, not a static field of a layout that has no such slot.
type Api = "a" | "b";

interface BaseOpts {
  apiKey?: string;
}

interface AOpts extends BaseOpts {
  aOnly?: string;
}

interface BOpts extends BaseOpts {
  bOnly?: number;
}

interface ApiOptionsMap {
  a: AOpts;
  b: BOpts;
}

type Opts<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : BaseOpts & Record<string, unknown>;

class Models {
  private applyAuth<TModel, TOptions extends BaseOpts>(
    model: TModel,
    options: TOptions | undefined,
  ): string | undefined {
    return options && "sessionId" in options && typeof options.sessionId === "string"
      ? options.sessionId
      : undefined;
  }

  stream<TApi extends Api>(model: string, passed?: Opts<TApi>): string | undefined {
    const widened: Opts<Api> | undefined = passed;
    return this.applyAuth(model, widened);
  }
}

const models = new Models();
const aOpts = { aOnly: "q", apiKey: "k" };
console.log("a", String(models.stream("a", aOpts)));
console.log("b", String(models.stream("b", { bOnly: 2 })));
console.log("none", String(new Models().stream("a")));

// The same read at a CONCRETE instantiation whose record does store the
// member: the static record read still answers it.
interface StoredOpts extends BaseOpts {
  sessionId: string;
}
function applyStored<T extends BaseOpts>(options: T): string | undefined {
  return "sessionId" in options && typeof options.sessionId === "string"
    ? options.sessionId
    : undefined;
}
console.log("stored", String(applyStored({ apiKey: "k", sessionId: "s-2" })));
console.log("omitted", String(applyStored({ apiKey: "k" })));
