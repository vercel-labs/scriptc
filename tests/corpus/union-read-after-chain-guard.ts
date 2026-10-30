// A discriminated union held across an `await`: the early `stored?.type ===
// "oauth"` return narrows the checker's `stored` to the api-key arm, but the
// runtime-optional storage still holds both arms. The later `s?.type` reads
// dispatch on the stored value's tag, so every credential shape answers as in
// Node — including the arm the earlier guard ruled out at runtime.
type ProviderEnv = Record<string, string>;
interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: ProviderEnv;
}
interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
}
interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}
type Credential = ApiKeyCredential | OAuthCredential;

const stored: (Credential | undefined)[] = [
  { type: "api_key", key: "sk-live", env: { REGION: "eu" } },
  { type: "oauth", refresh: "r1", access: "a1", expires: 42 },
  { type: "api_key" },
  undefined,
];

function load(i: number): Promise<Credential | undefined> {
  return Promise.resolve(stored[i]);
}

async function describe(i: number): Promise<string> {
  const found = await load(i);
  if (found?.type === "oauth") {
    return found.expires > 10 ? `oauth ${found.refresh}/${found.access}` : "oauth expired";
  }
  const credential = found?.type === "api_key" ? found : undefined;
  const key = credential?.type === "api_key" ? (credential.key ?? "<none>") : "<missing>";
  const region = credential?.env?.REGION ?? "<no-env>";
  return `api ${key} ${region}`;
}

async function main(): Promise<void> {
  for (let i = 0; i < stored.length; i++) console.log(i, await describe(i));
}
main();
