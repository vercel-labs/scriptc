// A method call on a UNION receiver whose arms declare the member with
// different signatures (`OAuthAuth | ApiKeyAuth`: `login` with and without
// the optional options parameter). JavaScript reads the property off the
// value and calls it with the arguments, so the call lowers as the
// checked-dynamic read-and-call and its result crosses back through the
// expected type. Node-exact output, including the optional member's absent
// case and the argument the second signature accepts.
interface CredentialA {
  token: string;
}
interface CredentialB {
  token: string;
  refresh: string;
}

interface Interaction {
  signal: string;
}

interface LoginOptions {
  label?: string;
}

interface ApiKeyAuth {
  login?(interaction: Interaction): Promise<CredentialA>;
}

interface OAuthAuth {
  login(interaction: Interaction, options?: LoginOptions): Promise<CredentialB>;
}

interface ProviderAuth {
  apiKey?: ApiKeyAuth;
  oauth?: OAuthAuth;
}

interface Provider {
  name: string;
  auth: ProviderAuth;
}

const providers = new Map<string, Provider>();
providers.set("anthropic", {
  name: "Anthropic",
  auth: {
    apiKey: {
      login: async (interaction: Interaction) => ({ token: `key:${interaction.signal}` }),
    },
  },
});
providers.set("github", {
  name: "GitHub",
  auth: {
    oauth: {
      login: async (interaction: Interaction, options?: LoginOptions) => ({
        token: `oauth:${interaction.signal}`,
        refresh: options?.label ?? "none",
      }),
    },
  },
});
providers.set("local", { name: "Local", auth: {} });

async function login(
  providerId: string,
  type: "apiKey" | "oauth",
  options?: LoginOptions,
): Promise<string> {
  const provider = providers.get(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
  if (!method?.login) {
    throw new Error(`${provider.name} does not support ${type} login`);
  }
  const loginOperation: Promise<CredentialA | CredentialB> = method.login(
    { signal: "sig" },
    options,
  );
  const credential = await loginOperation;
  return "refresh" in credential ? `${credential.token}/${credential.refresh}` : credential.token;
}

async function main(): Promise<void> {
  console.log(await login("anthropic", "apiKey"));
  console.log(await login("github", "oauth", { label: "lbl" }));
  console.log(await login("github", "oauth"));
  for (const [id, type] of [
    ["github", "apiKey"],
    ["local", "oauth"],
    ["missing", "apiKey"],
  ] as const) {
    try {
      console.log(await login(id, type));
    } catch (error) {
      console.log("error:", (error as Error).message);
    }
  }
}

main();
