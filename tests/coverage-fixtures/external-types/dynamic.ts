async function hostVersion(): Promise<string> {
  const host = await import("@native-sdk/core");
  return host.hostVersion();
}

void hostVersion();
