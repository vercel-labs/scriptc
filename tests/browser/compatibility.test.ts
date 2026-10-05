import { expect, test, type Page } from "@playwright/test";
import { expectedLabels, label, snapshot } from "./compatibility-oracle";

const rowLabels = (page: Page) => page.locator("tbody tr td:first-child a");

test.beforeEach(async ({ page }) => {
  await page.goto("/compatibility");
  await expect(page.getByRole("button", { name: "Expand all", exact: true })).toBeVisible();
});

test("all APIs remain reachable without eagerly mounting hidden tooltips", async ({ page }) => {
  await expect(rowLabels(page)).toHaveText(snapshot.rows.filter((row) => row.depth === 0).map(label));
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(rowLabels(page)).toHaveText(snapshot.rows.map(label));
  // Stable work ceilings, not noisy CI timing: no hidden popup DOM, and a
  // bounded number of elements per API even when the whole census is open.
  await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
  const elements = await page.locator("*").count();
  expect(elements).toBeLessThanOrEqual(snapshot.rows.length * 17 + 500);
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(rowLabels(page)).toHaveText(snapshot.rows.filter((row) => row.depth === 0).map(label));
});

test("search and independent tier filters preserve every match and its parents", async ({ page }) => {
  const search = page.getByRole("searchbox");
  for (const query of ["r", "readFile", "file"]) {
    await search.fill(query);
    await expect(rowLabels(page)).toHaveText(expectedLabels(query));
  }
  await page.getByRole("combobox", { name: /^Static/ }).selectOption("partial");
  await expect(rowLabels(page)).toHaveText(expectedLabels("file", "partial"));
  await page.getByRole("combobox", { name: /^Dynamic/ }).selectOption("supported");
  await expect(rowLabels(page)).toHaveText(expectedLabels("file", "partial", "supported"));
  await search.fill("scriptc-no-such-api-unique");
  await expect(page.getByText("No API rows match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("combobox", { name: /^Static/ })).toHaveValue("all");
  await expect(page.getByRole("combobox", { name: /^Dynamic/ })).toHaveValue("all");
  await expect(rowLabels(page)).toHaveText(snapshot.rows.filter((row) => row.depth === 0).map(label));
});

test("retained API badges do not rerender on every search keystroke", async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Debugger.enable");
  await session.send("Profiler.enable");
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  await page.mouse.move(0, 0);
  await page.getByRole("searchbox").fill("r");
  await expect(rowLabels(page)).toHaveText(expectedLabels("r"));
  const initial = await session.send("Profiler.takePreciseCoverage");
  const markers = [{ text: "Verification:", column: 3 }, { text: "Node.js Stability", column: 2 }];
  const candidates: { text: string; scriptId: string; start: number; end: number; count: number }[] = [];
  for (const script of initial.result) {
    if (!script.url.includes("/_next/")) continue;
    const { scriptSource } = await session.send("Debugger.getScriptSource", { scriptId: script.scriptId });
    for (const fn of script.functions) {
      const range = fn.ranges[0];
      // The smallest covered function containing the badge's fixed text is
      // its renderer. This observes real calls without production counters
      // or depending on identifiers rewritten by Next's minifier.
      for (const { text } of markers) {
        if (scriptSource.slice(range.startOffset, range.endOffset).includes(text)) {
          candidates.push({ text, scriptId: script.scriptId, start: range.startOffset, end: range.endOffset, count: range.count });
        }
      }
    }
  }
  candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const badges = markers.map(({ text, column }) => {
    const badge = candidates.find((candidate) => candidate.text === text);
    expect(badge).toBeDefined();
    expect(badge!.count).toBeGreaterThan(0);
    return { ...badge!, column };
  });
  await page.getByRole("searchbox").fill("re");
  await expect(rowLabels(page)).toHaveText(expectedLabels("re"));
  const next = await session.send("Profiler.takePreciseCoverage");
  for (const badge of badges) {
    const fn = next.result.find((script) => script.scriptId === badge.scriptId)?.functions.find((fn) => fn.ranges[0].startOffset === badge.start);
    // Small allowance for hover/focus work, never thousands of unchanged
    // badge renders. Precise coverage resets counts between snapshots.
    expect(fn?.ranges[0].count ?? 0).toBeLessThanOrEqual(16);
    // V8 may omit a function with no calls. An actual hover render proves
    // the same renderer is still being observed after the zero interval.
    const target = page.locator(`tbody td:nth-child(${badge.column}) > span[tabindex="0"]`).first();
    await target.hover();
    await expect(target.getByRole("tooltip")).toBeVisible();
    const control = await session.send("Profiler.takePreciseCoverage");
    const rendered = control.result.find((script) => script.scriptId === badge.scriptId)?.functions.find((fn) => fn.ranges[0].startOffset === badge.start);
    expect(rendered?.ranges[0].count).toBeGreaterThan(0);
  }
  await session.send("Profiler.stopPreciseCoverage");
});

test("status and stability details remain available to mouse and keyboard users", async ({ page }) => {
  for (const column of [3, 2]) {
    const badge = page.locator(`tbody td:nth-child(${column}) > span[tabindex="0"]`).first();
    const title = await badge.locator("span[title]").first().getAttribute("title");
    expect(title).toBeTruthy();
    await badge.hover();
    const tooltip = badge.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(title!, { useInnerText: true });
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
    await page.keyboard.press("Tab");
    await badge.focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(title!, { useInnerText: true });
    await badge.hover();
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeVisible(); // Focus survives pointer leave.
    await badge.hover();
    await page.getByRole("searchbox").focus();
    await expect(tooltip).toBeVisible(); // Hover survives keyboard blur.
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(0);
  }
});
