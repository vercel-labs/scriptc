// Reading a field off the non-matching arm of a credential union: the stored
// union's arms do not share the field name, so the read lowers through the
// checker's narrowed view of the receiver.
interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: { [key: string]: string | undefined };
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

interface RefreshContext {
  credential?: Credential;
  allowNetwork: boolean;
}

function pick(context: RefreshContext): string | undefined {
  const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
  return key;
}

console.log("api-key", pick({ credential: { type: "api_key", key: "k-1" }, allowNetwork: true }));
console.log(
  "oauth",
  pick({ credential: { type: "oauth", refresh: "r", access: "a", expires: 1 }, allowNetwork: true }),
);
console.log("empty", pick({ credential: { type: "api_key" }, allowNetwork: true }));
console.log("none", pick({ allowNetwork: false }));
