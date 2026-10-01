import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { expectedLabels, label, snapshot } from "./compatibility-oracle";

test("compatibility lookup latency and rendered work", async ({ page, browser, baseURL }) => {
  const iterations = Number(process.env.SCRIPTC_DOCS_ITERATIONS ?? "9");
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error("SCRIPTC_DOCS_ITERATIONS must be an integer from 1 to 100");
  test.setTimeout(30_000 + iterations * 30_000);
  const session = await page.context().newCDPSession(page);
  const samples: { phase: string; throttle: number; ms: number; rows: number; elements: number }[] = [];
  const loads: object[] = [];
  // Time actual browser input to two animation frames, not command round trips.
  // Result checks run outside the interval. For sequential typing, also retain
  // the first-input-to-final-result duration across all intermediate renders.
  await page.addInitScript(() => {
    const state = window as typeof window & { firstInput: number | null; latency: { event: string; ms: number; journey_ms: number; rows: number; elements: number } | null };
    for (const type of ["input", "click"]) document.addEventListener(type, (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      const event = e.target instanceof HTMLInputElement ? e.target.value : e.target.textContent ?? "";
      if (type === "click" && !["Expand all", "Collapse all"].includes(event)) return;
      const start = performance.now();
      state.firstInput ??= start;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = performance.now();
        state.latency = { event, ms: now - start, journey_ms: now - state.firstInput!, rows: document.querySelectorAll("tbody tr").length, elements: document.querySelectorAll("*").length };
      }));
    }, true);
  });
  const roots = snapshot.rows.filter((row) => row.depth === 0).map(label);
  for (const throttle of [1, 4]) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await page.goto("/compatibility");
    await expect(page.getByRole("button", { name: "Expand all", exact: true })).toBeVisible();
    loads.push(await page.evaluate((throttle) => ({
      throttle,
      usable_ms: performance.now(),
      navigation: performance.getEntriesByType("navigation")[0].toJSON(),
      data: performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/compatibility/data")).map((entry) => entry.toJSON()),
    }), throttle));
    const search = page.getByRole("searchbox");
    async function sample(phase: string, action: () => Promise<unknown>, event: string, labels: string[]) {
      await page.evaluate(() => {
        const state = window as typeof window & { latency: unknown; firstInput: number | null };
        state.latency = null;
        state.firstInput = null;
      });
      await action();
      await expect(page.locator("tbody tr td:first-child a")).toHaveText(labels);
      await page.waitForFunction((event) => (window as typeof window & { latency: { event: string } | null }).latency?.event === event, event);
      const result = await page.evaluate(() => (window as typeof window & { latency: { ms: number; journey_ms: number; rows: number; elements: number } }).latency);
      expect(result.rows).toBe(labels.length);
      samples.push({ phase, throttle, ...result, ms: phase === "typed-readFile" ? result.journey_ms : result.ms });
    }
    for (let i = 0; i < iterations; i++) {
      await sample("prefix-r", () => search.fill("r"), "r", expectedLabels("r"));
      await sample("prefix-re", () => search.fill("re"), "re", expectedLabels("re"));
      await sample("readFile", () => search.fill("readFile"), "readFile", expectedLabels("readFile"));
      await sample("clear", () => search.fill(""), "", roots);
      await sample("expand-all", () => page.getByRole("button", { name: "Expand all", exact: true }).click(), "Expand all", snapshot.rows.map(label));
      await sample("collapse-all", () => page.getByRole("button", { name: "Collapse all", exact: true }).click(), "Collapse all", roots);
      await sample("typed-readFile", () => search.pressSequentially("readFile"), "readFile", expectedLabels("readFile"));
      await search.fill("");
      await expect(page.locator("tbody tr")).toHaveCount(roots.length);
    }
  }
  const summaries = [1, 4].flatMap((throttle) => [...new Set(samples.map((sample) => sample.phase))].map((phase) => {
    const group = samples.filter((sample) => sample.throttle === throttle && sample.phase === phase);
    const times = group.map((sample) => sample.ms).sort((a, b) => a - b);
    return { throttle, phase, n: times.length, p50_ms: times[Math.ceil(times.length * 0.5) - 1], p95_ms: times[Math.ceil(times.length * 0.95) - 1], elements: group[0].elements, rows: group[0].rows };
  }));
  const result = { environment: { node: process.version, browser: browser.version(), platform: platform(), os: release(), arch: arch(), cpu: cpus()[0].model, viewport: { width: 1440, height: 1000 }, baseURL, censusRows: snapshot.rows.length }, summaries, samples, loads };
  if (process.env.SCRIPTC_DOCS_RESULT) writeFileSync(process.env.SCRIPTC_DOCS_RESULT, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
});
