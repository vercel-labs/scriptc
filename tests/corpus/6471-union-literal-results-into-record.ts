// A function returning differently shaped object literals (the checker
// normalizes omitted members to `?: undefined`) flows into a declared record
// result: each literal shape converts on its own.
class Tracer {
  trace<T>(_name: string, fn: () => T): T {
    return fn();
  }
}
const tracer = new Tracer();
type CacheResult = { downloaded: boolean; size?: number; cacheType?: string; dir?: string };
async function download(n: number, dir: string | undefined): Promise<CacheResult> {
  const pending = tracer.trace("download", async () => {
    if (n === 0) {
      return { downloaded: false, dir };
    }
    if (n < 0) {
      return { downloaded: false };
    }
    return { downloaded: true, size: n, cacheType: "full", dir };
  });
  return pending.finally(() => {
    console.log("done", n);
  });
}
type Details = { obtain: string; url?: string; kind?: string };
async function details(flag: number): Promise<Details> {
  return tracer.trace("details", async () => {
    if (flag === 0) return { obtain: "skipped" };
    return { obtain: "found", url: "u", kind: "k" };
  });
}
async function main() {
  console.log(await download(0, "/d"), await download(5, undefined), await download(-1, "z"));
  const d0 = await details(0);
  console.log(d0, "url" in d0, JSON.stringify(await details(1)));
}
main();
