// @dynamic
// The island plumbing the vercel CLI's graph exercised into existence,
// pinned differentially against Node: URL's live search/searchParams
// coupling, Blob/File (and node:buffer's re-export), Event/EventTarget/
// CustomEvent dispatch, worker_threads' main-thread MessageChannel,
// perf_hooks' clock, domain's sync surface, dns's and dns/promises'
// loadable shape, and process.exitCode as the implicit exit status (this
// program exits 3 in BOTH lanes).
import { probe } from "plumbing";

async function run(): Promise<void> {
  const report: string = await probe();
  console.log(report);
}

void run();
