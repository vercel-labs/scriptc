// A generic function reads OPTIONAL members its constraint declares while the
// call site's own options record omits them (`options.sessionId` under an
// `"sessionId" in options` guard). Node reads the property off the object it
// actually has, so a caller that omits the member answers undefined and one
// that supplies it answers the value — for every instantiation of the
// function, which the program pins one by one.
interface RequestOptions<TModel> {
  model?: TModel;
  apiKey?: string;
  sessionId?: string;
}
interface Transforms {
  transformHeaders?: (headers: Record<string, string | null>) => Record<string, string | null>;
}

function describeOptions<TModel, TOptions extends RequestOptions<TModel> & Transforms>(
  options: TOptions | undefined,
): string {
  const sessionId =
    options && "sessionId" in options && typeof options.sessionId === "string"
      ? options.sessionId
      : "<none>";
  const apiKey =
    options && "apiKey" in options && typeof options.apiKey === "string" ? options.apiKey : "<no-key>";
  return `session=${sessionId} key=${apiKey}`;
}

const withSession = { apiKey: "sk-1", sessionId: "sess-1" };
const withoutSession = { apiKey: "sk-2" };
const onlySession = { sessionId: "sess-3" };
const empty = {};

console.log(describeOptions<{ id: string }, typeof withSession>(withSession));
console.log(describeOptions<{ id: string }, typeof withoutSession>(withoutSession));
console.log(describeOptions<{ id: number }, typeof onlySession>(onlySession));
console.log(describeOptions<{ id: number }, typeof empty>(empty));
console.log(describeOptions<{ id: string }, Transforms>(undefined));

// The same read through a generic method on a class, whose instantiation is
// fixed by the call site's own argument type.
class OptionsReader<TOptions extends RequestOptions<string> & Transforms> {
  read(options: TOptions | undefined): string {
    return options && "sessionId" in options && typeof options.sessionId === "string"
      ? options.sessionId
      : "<none>";
  }
}
const keyedReader = new OptionsReader<typeof withSession>();
const bareReader = new OptionsReader<typeof withoutSession>();
console.log(
  keyedReader.read(withSession),
  bareReader.read(withoutSession),
  bareReader.read(undefined),
);
