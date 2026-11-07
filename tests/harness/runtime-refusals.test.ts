/* The runtime refusal lint (scripts/runtime-refusals.mjs) on small C
 * sources: which raising call a refusal message is attributed to decides
 * whether the lint sees its diagnostic code. `pnpm lint` runs the same
 * script over packages/runtime/src. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const script = join(import.meta.dirname, "../../scripts/runtime-refusals.mjs");

function lint(source: string): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-refusal-lint-"));
  try {
    writeFileSync(join(dir, "scr_widget.c"), source);
    const result = spawnSync(process.execPath, [script, "--strict", `--source=${dir}`], {
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const coded = `  scr_throw_error_msg_code(SCR_ERR_ERROR, "widget count out of range", 25, "SC2020");`;

test("a message held in a constant is judged by the raise it is handed to", () => {
  // The constant is raised without a code; a later raise in the same
  // function names one. Scanning on from the use starts inside the first
  // call's arguments and would answer with the second call's code.
  const uncoded = lint(`static const char widget_message[] = "widgets are not supported";

void widget_use(int kind) {
  if (kind == 1) {
    scr_throw_error_msg(SCR_ERR_ERROR, widget_message, sizeof widget_message - 1);
    return;
  }
${coded}
}
`);
  expect(uncoded.stdout).toContain(", 1 do not");
  expect(uncoded.stdout).toContain(
    'no code: packages/runtime/src/scr_widget.c:1 "widgets are not supported"',
  );
  expect(uncoded.status).toBe(1);

  // The same through a call that only carries the message.
  const carried = lint(`static const char widget_message[] = "widgets are not supported";

void widget_use(int kind) {
  if (kind == 1) {
    scr_throw_error(SCR_ERR_ERROR, scr_str_from_cstr(widget_message));
    return;
  }
${coded}
}
`);
  expect(carried.stdout).toContain(
    'no code: packages/runtime/src/scr_widget.c:1 "widgets are not supported"',
  );
  expect(carried.status).toBe(1);
});

test("a constant raised with a code, directly or from a local, passes", () => {
  const direct = lint(`static const char widget_message[] = "widgets are not supported";

void widget_use(void) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, widget_message, sizeof widget_message - 1, "SC2020");
}
`);
  expect(direct.stdout).toContain(", 0 do not");
  expect(direct.status).toBe(0);

  // The message goes into a local first: the raise is the next one after
  // the use.
  const local = lint(`static const char widget_message[] = "widgets are not supported";

void widget_use(int kind) {
  const char *message = widget_message;
  if (kind == 1) message = "no widget";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}
`);
  expect(local.stdout).toContain(", 0 do not");
  expect(local.status).toBe(0);
});

test("the site list reaches a reader that is slower than the script", async () => {
  // The list for the runtime is larger than a pipe's buffer. The reader
  // starts after the script has written what fits and would have exited:
  // an exit at that point drops the rest, and the status still says 0.
  const child = spawn(process.execPath, [script, "--json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const status = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  let text = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) text += chunk;
  expect(await status).toBe(0);
  expect(text.length).toBeGreaterThan(64 * 1024);
  const sites = JSON.parse(text) as { file: string; message: string }[];
  expect(sites.length).toBeGreaterThan(300);
  expect(sites.every((site) => typeof site.file === "string")).toBe(true);
}, 30_000);
