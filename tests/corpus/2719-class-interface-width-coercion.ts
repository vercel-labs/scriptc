// 2719 width-coercion class→interface (channel.manager.ts:9): a class
// instance flows into a parameter typed as an interface record whose
// fields are a subset of the class's — the width copy builds the exact
// record literal from the instance's fields, extra fields unobserved.
interface ServiceAdapter {
  name: string;
  isEnabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}
class DiscordBotAdapter {
  name = "discord";
  isEnabled = true;
  extraProp = 123;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  extra(): number {
    return this.extraProp;
  }
}
function registerAdapter(a: ServiceAdapter): string {
  return a.name + (a.isEnabled ? ":on" : ":off");
}
const da = new DiscordBotAdapter();
console.log(registerAdapter(da));
console.log(registerAdapter(new DiscordBotAdapter()));
const obj = {
  name: "custom",
  isEnabled: true,
  start: async () => {},
  stop: async () => {},
  extra: 999,
};
console.log(registerAdapter(obj as ServiceAdapter));
