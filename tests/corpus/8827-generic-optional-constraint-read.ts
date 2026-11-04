// The `?.` spelling of a generic constraint member read: `options?.apiKey`
// inside a generic function whose constraint declares `apiKey?: string`,
// where the call site's options record does not store the slot. Node reads
// the property off the object it actually has, so an omitted member answers
// undefined and a supplied one answers its value, for every instantiation;
// a nullish receiver short-circuits to undefined.
interface RequestOptions<TModel> {
  model?: TModel;
  apiKey?: string;
  sessionId?: string;
}
interface Transforms {
  transformHeaders?: (headers: Record<string, string | null>) => Record<string, string | null>;
}

function authOf<TModel, TOptions extends RequestOptions<TModel> & Transforms>(
  options: TOptions | undefined,
): string {
  const apiKey = options?.apiKey;
  const sessionId = options?.sessionId;
  return `${apiKey ?? "<no-key>"}/${sessionId ?? "<no-session>"}`;
}

const withKey = { apiKey: "sk-1", sessionId: "sess-1" };
const withoutKey = { sessionId: "sess-2" };
const empty = {};

console.log(authOf<{ id: string }, typeof withKey>(withKey));
console.log(authOf<{ id: number }, typeof withoutKey>(withoutKey));
console.log(authOf<{ id: number }, typeof empty>(empty));
console.log(authOf<{ id: string }, Transforms>(undefined));

// The same read through a generic method on a class, whose instantiation is
// fixed by the call site's own argument type.
class Reader<TOptions extends RequestOptions<string> & Transforms> {
  read(options: TOptions | undefined): string {
    return options?.apiKey ?? "<none>";
  }
}
const keyed = new Reader<typeof withKey>();
const bare = new Reader<typeof withoutKey>();
console.log(keyed.read(withKey), bare.read(withoutKey), bare.read(undefined));

// A receiver the checker types as non-nullable still reads the property off
// the stored record (`?.` is `.` there).
function keyOf<TModel, TOptions extends RequestOptions<TModel> & Transforms>(
  options: TOptions,
): string {
  return options?.apiKey ?? "<none>";
}
console.log(keyOf<{ id: string }, typeof withKey>(withKey));
console.log(keyOf<{ id: number }, typeof withoutKey>(withoutKey));
