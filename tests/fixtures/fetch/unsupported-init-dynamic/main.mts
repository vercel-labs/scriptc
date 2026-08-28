// @dynamic
// Runtime-computed RequestInit dictionaries cannot be source-profiled. The
// dynamic fetch bridge must reject recognized unsupported members rather than
// silently weakening their cache, credential, or integrity behavior.
import { EnvProxyDispatcher } from "vercel-env-proxy-dispatcher";

declare global {
  interface RequestInit {
    cache?: string;
    dispatcher?: EnvProxyDispatcher;
  }
}

interface RuntimeInit {
  [key: string]: string | Record<string, never>;
}

function indirect(init: RuntimeInit): Promise<Response> {
  return fetch("http://127.0.0.1:1", init);
}

async function rejectedOption(name: string, source: string): Promise<void> {
  try {
    await indirect(JSON.parse(source) as RuntimeInit);
    console.log(name, "unexpectedly accepted");
  } catch (error) {
    const caught = error as Error;
    console.log(name, caught.name, caught.message);
  }
}

await rejectedOption("cache", '{"cache":"no-store"}');
await rejectedOption("dispatcher", '{"dispatcher":{}}');

const envProxyDispatcher = new EnvProxyDispatcher();

try {
  await fetch("http://127.0.0.1:1", {
    dispatcher: envProxyDispatcher,
    signal: AbortSignal.abort("env dispatcher accepted"),
  });
} catch (error) {
  console.log("env dispatcher", typeof error, String(error));
}

const fromStream = ReadableStream.from([7]);
const fromPart = await fromStream.getReader().read();
console.log("stream from:", fromPart.done, fromPart.done ? -1 : fromPart.value);

const constructed = new ReadableStream<number>();
console.log("stream constructor:", constructed.locked);
