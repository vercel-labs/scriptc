// A vitest reporter for CI logs. vitest's default reporter writes nothing about
// a test file until the whole file finishes, and the corpus and differential
// files run for many minutes, so a job that hangs or reaches its timeout ends
// with no word of what it was running. This reporter, beside the default one:
//
// - prints each failed test as soon as it fails, and each test slower than
//   SCRIPTC_CI_SLOW_TEST_SECONDS (30 by default) with its duration;
// - every SCRIPTC_CI_PROGRESS_SECONDS (60 by default), prints how many tests
//   finished and the ones running now, longest first, with how long each has
//   run.
//
// Lines start with `[progress <task>]`, where the task is SCRIPTC_CI_TASK (the
// name scripts/ci-test.mjs gives each vitest process), so the corpus and the
// side queue that share a job log stay apart. vitest.config.ts adds it on
// GitHub Actions; SCRIPTC_CI_PROGRESS=0 turns it off.

import { relative } from "node:path";

const seconds = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes === 0 ? `${total}s` : `${minutes}m${String(total % 60).padStart(2, "0")}s`;
}

export default class CiProgressReporter {
  constructor({
    now = () => Date.now(),
    write = (line) => process.stdout.write(`${line}\n`),
    intervalSeconds = seconds("SCRIPTC_CI_PROGRESS_SECONDS", 60),
    slowSeconds = seconds("SCRIPTC_CI_SLOW_TEST_SECONDS", 30),
    task = process.env.SCRIPTC_CI_TASK,
  } = {}) {
    this.now = now;
    this.write = write;
    this.intervalMs = intervalSeconds * 1000;
    this.slowMs = slowSeconds * 1000;
    this.prefix = task ? `[progress ${task}]` : "[progress]";
    this.running = new Map();
    this.finished = 0;
    this.failed = 0;
    this.started = now();
    this.timer = undefined;
  }

  label(testCase) {
    const id = testCase.module?.moduleId;
    const file = id ? relative(process.cwd(), id) : (testCase.module?.relativeModuleId ?? "");
    return `${file} > ${testCase.fullName ?? testCase.name}`;
  }

  onTestRunStart() {
    this.started = this.now();
    this.timer = setInterval(() => this.heartbeat(), this.intervalMs);
    this.timer.unref?.();
  }

  onTestCaseReady(testCase) {
    this.running.set(testCase.id, { label: this.label(testCase), since: this.now() });
  }

  onTestCaseResult(testCase) {
    const entry = this.running.get(testCase.id);
    this.running.delete(testCase.id);
    const result = testCase.result();
    if (result.state === "skipped" || result.state === "pending") return;
    this.finished++;
    const duration = testCase.diagnostic()?.duration ?? (entry ? this.now() - entry.since : 0);
    const label = entry?.label ?? this.label(testCase);
    if (result.state === "failed") {
      this.failed++;
      const message = result.errors?.[0]?.message?.split("\n", 1)[0] ?? "";
      this.write(
        `${this.prefix} FAIL ${formatDuration(duration)} ${label}${message ? `: ${message}` : ""}`,
      );
    } else if (duration >= this.slowMs) {
      this.write(`${this.prefix} slow ${formatDuration(duration)} ${label}`);
    }
  }

  heartbeat() {
    const now = this.now();
    const running = [...this.running.values()].sort((a, b) => a.since - b.since);
    const shown = running
      .slice(0, 8)
      .map(({ label, since }) => `${label} (${formatDuration(now - since)})`);
    this.write(
      `${this.prefix} ${formatDuration(now - this.started)}: ${this.finished} tests finished` +
        `${this.failed ? `, ${this.failed} failed` : ""}; ${running.length} running` +
        (shown.length
          ? `: ${shown.join("; ")}${running.length > shown.length ? "; ..." : ""}`
          : ""),
    );
  }

  onTestRunEnd() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
