// A listener's Promise<Message> handed to a slot that also allows
// undefined, with a message shape of nested, optional, index-signature,
// union and unknown members.
interface GitHubSource {
  type: string;
  repoName: string;
  ref: string;
  prId?: number | null;
}
interface GitLabSource {
  type: string;
  projectId: number;
  ref: string | null;
  error?: { code?: string; message?: string };
}
interface BuildOrderMessage {
  authToken: string;
  createdAt?: number;
  cache: { branch?: string; prod?: string };
  env: { [key: string]: string | undefined };
  deployment: {
    id: string;
    gitSource?: GitHubSource | GitLabSource;
    builds?: { config: unknown; src?: string; use: string }[];
  };
}
class Listener {
  private seq = 0;
  async waitForBuildOrder(): Promise<BuildOrderMessage> {
    await null;
    this.seq++;
    return {
      authToken: "t" + this.seq,
      cache: { branch: "main" },
      env: { NODE_ENV: "production" },
      deployment: {
        id: "dpl_" + this.seq,
        gitSource:
          this.seq % 2 === 1
            ? { type: "github", repoName: "app", ref: "main", prId: null }
            : { type: "gitlab", projectId: 7, ref: null, error: { code: "E1" } },
        builds: [{ config: { zeroConfig: true }, use: "@vercel/node" }],
      },
    };
  }
}
interface Provider {
  pollBuild: () => Promise<BuildOrderMessage | undefined>;
}
const listener = new Listener();
const provider: Provider = { pollBuild: () => listener.waitForBuildOrder() };
function describeSource(source: GitHubSource | GitLabSource | undefined): string {
  if (!source) return "none";
  return "repoName" in source ? `${source.type}:${source.repoName}` : `${source.type}:${source.projectId}`;
}
async function main(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100));
    const order = await Promise.race([provider.pollBuild(), timeout]);
    if (!order) {
      console.log("timed out");
      continue;
    }
    console.log(order.authToken, order.deployment.id, order.cache.branch, order.env.NODE_ENV, order.createdAt);
    console.log(describeSource(order.deployment.gitSource), order.deployment.builds?.[0]?.use, JSON.stringify(order.deployment.builds?.[0]?.config));
  }
}
main();
