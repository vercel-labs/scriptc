// The outer literal's context (a union with a WeakRef arm) has no layout,
// so it builds at its own type; its nested literals must follow that
// layout instead of their own contextual one, and the outer coercion then
// lifts the whole tree (headers into the index-signature record).
type ProviderHeaders = Record<string, string | null>;
interface ModelAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
}
interface AuthResult {
  auth: ModelAuth;
  source?: string;
}
type Answer = AuthResult | WeakRef<object> | undefined;
function make(flag: boolean): Answer {
  return flag ? { auth: { headers: { Authorization: "Bearer x" } }, source: "env" } : undefined;
}
const r = make(true) as AuthResult;
console.log(r.source, r.auth.headers?.Authorization);
console.log(make(false) === undefined);
