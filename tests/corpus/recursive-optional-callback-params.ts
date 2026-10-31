// An optional parameter whose type reaches back to the interface that
// declares the method keeps its whole union. A command context's
// `newSession(options?)` takes callbacks typed by a subinterface of the
// context, so mapping the context passes through the options union while
// that union is still being mapped; the parameter still holds the options
// record, not only `undefined`.

interface CommandContext {
  cwd: string;
  newSession(options?: {
    parent?: string;
    withSession?: (ctx: ReplacedContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  fork(
    entryId: string,
    options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;
}

interface ReplacedContext extends CommandContext {
  depth: number;
  send(content: string): Promise<void>;
}

interface Command {
  description?: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

const log: string[] = [];
const commands = new Map<string, Command>();

function register(name: string, command: Command): void {
  commands.set(name, command);
}

register("new", {
  description: "start a session",
  handler: async (args, ctx) => {
    const first = await ctx.newSession({
      parent: args,
      withSession: async (next) => {
        await next.send(`hello from ${next.cwd} at depth ${next.depth}`);
        const nested = await next.newSession({
          withSession: async (inner) => {
            await inner.send(`nested at depth ${inner.depth}`);
          },
        });
        log.push(`nested cancelled=${nested.cancelled}`);
      },
    });
    log.push(`first cancelled=${first.cancelled}`);
    const bare = await ctx.newSession();
    log.push(`bare cancelled=${bare.cancelled}`);
  },
});

register("fork", {
  handler: async (args, ctx) => {
    const r = await ctx.fork(args, {
      position: "at",
      withSession: async (next) => next.send(`forked ${args} at depth ${next.depth}`),
    });
    log.push(`fork cancelled=${r.cancelled}`);
    const plain = await ctx.fork(args);
    log.push(`plain fork cancelled=${plain.cancelled}`);
  },
});

function makeContext(depth: number): ReplacedContext {
  return {
    cwd: `/work/${depth}`,
    depth,
    newSession: async (options) => {
      log.push(`newSession depth=${depth} parent=${options?.parent ?? "-"}`);
      if (options?.withSession) {
        await options.withSession(makeContext(depth + 1));
        return { cancelled: false };
      }
      return { cancelled: true };
    },
    fork: async (entryId, options) => {
      log.push(`fork ${entryId} position=${options?.position ?? "-"}`);
      const callback = options?.withSession;
      if (callback === undefined) return { cancelled: true };
      await callback(makeContext(depth + 1));
      return { cancelled: false };
    },
    send: async (content) => {
      log.push(`send: ${content}`);
    },
  };
}

async function run(): Promise<void> {
  const root: CommandContext = makeContext(0);
  for (const [name, command] of commands) {
    log.push(`run ${name} (${command.description ?? "no description"})`);
    await command.handler(`entry-${name}`, root);
  }
  for (const line of log) console.log(line);
}

run().catch((e: unknown) => {
  console.log("failed", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
