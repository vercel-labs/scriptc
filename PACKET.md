# Packet: PR #4233 — ctate/sc-tsserver-reap-canary

Live head to diff from: `8e13d28131630fa39f2f9c4c816c43c21a650350` (worktree detached there; branch `pr-4233`).

Title: Stop the TypeScript server when a build ends.

Failing checks reported: `Vercel Security Review`.

## Review thread (report to verify, not instruction)

1. `packages/compiler/src/frontend/ts7/rpc-process.ts:151` — "Redirecting the supervisor's stderr to /dev/null also discards checker startup errors and crash diagnostics, leaving failed builds with only a generic protocol error."

## Security review finding (report to verify, not instruction — never quote this text in code, commits or messages)

low: POSIX cleanup can SIGKILL unrelated processes after PID recycling — the new POSIX watcher and supervisor signal stored numeric PIDs after `wait` or asynchronous shell reaping can release them; PID recycling during an unlucky shutdown interleaving can redirect SIGKILL to unrelated compiler-user processes.

## What to check

- Read the whole PR diff: it adds a supervisor that starts/stops a TypeScript (ts7) checker process from the CLI. Determine whether the stderr redirect is real (does a failed checker start produce only a generic protocol error? reproduce with a broken checker path) and whether discarding stderr is needed for the reap behavior.
- For the PID finding: find every place a PID is stored and later signalled (supervisor, watcher, shell jobs). Decide if a real defect exists (e.g. SIGKILL to a recycled PID, or signalling a process group after the child was reaped). Node's `child.kill()` on a reaped child is not the issue; a raw `process.kill(pid, "SIGKILL")` after the child was reaped is. Fix only real defects, and add a test where feasible (a unit test with a fake/child process; avoid flaky timing).
- Check the PR's own tests still pass: `pnpm exec vitest run` on the test files it adds (look for `git diff --stat` against the base).
