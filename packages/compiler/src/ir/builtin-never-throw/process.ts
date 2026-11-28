import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the process module decided never to throw. */
export const processNeverThrow: readonly IrLibFn[] = [
  "process.finalization",
  // Builds the flags object once from constants and retains it.
  "process.features",
  // scr_cpu_usage_field reads the number cpuDynPrepare just stored; the
  // validation already ran, so the read cannot raise.
  "process.cpuDynField",
  // The capture-callback flag and the two process flags are plain reads
  // of thread-local state; no allocation and no program code runs.
  "process.hasUncaughtCapture",
  "process.debugPort",
  "process.sourceMapsEnabled",
  // Reads the fork channel registry and answers undefined, null or the
  // retained Control object; a plain process has no channel.
  "process.channel",
  // The stream object a descriptor the program already holds names: a cache
  // lookup and a retain, with no allocation, coercion or program code. The
  // cursor methods use it to reach the same object process.stdio answers.
  "process.stdioOf",
  // process.stdin.ref()/unref(): plain thread-local flag writes that keep
  // the loop's stdin keep-alive in step with Node's handle refcount. No
  // allocation, coercion or program code runs.
  "stdin.ref",
  "stdin.unref",
  // The retained frozen config object (built once in scr_process_config);
  // a plain read that cannot raise.
  "process.configValue",
  // process.off('message'|'disconnect', listener): the entry leaves the
  // channel's list, or a process without a channel answers without one.
  "process.offMessage",
  "process.offDisconnect",
];
