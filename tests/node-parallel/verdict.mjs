// How two runs of one test file compare (run.mjs).

/** Whether Node and the executable ended the same way: the same exit code,
 * or the same terminating signal (an exit code is null when a signal ended
 * the process). */
export function sameTermination(node, native) {
  return node.code === native.code && node.signal === native.signal;
}

/** An exit code, or the signal that ended the process. */
export function termination(result) {
  return result.code ?? result.signal;
}
