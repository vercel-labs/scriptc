import { expect, test } from "vitest";
import type * as ts from "../ts7/adapter.js";
import { SiteDependencies } from "./site-dependencies.js";

/** A stand-in node fact: facts are compared by identity. */
const node = (): ts.Node => ({}) as ts.Node;

test("a changed fact makes the sites that read it stale", () => {
  const dependencies = new SiteDependencies(3);
  const a = node();
  const b = "key";
  dependencies.begin(0);
  dependencies.read(a);
  dependencies.end(false);
  dependencies.begin(1);
  dependencies.read(b);
  dependencies.end(false);
  expect([0, 1, 2].map((site) => dependencies.isStale(site))).toEqual([false, false, false]);
  dependencies.changed(b);
  expect([0, 1, 2].map((site) => dependencies.isStale(site))).toEqual([false, true, false]);
  dependencies.begin(1);
  expect(dependencies.isStale(1)).toBe(false);
});

test("a visit that changes a fact makes every reader of its facts stale", () => {
  const dependencies = new SiteDependencies(3);
  const shared = node();
  const own = node();
  dependencies.begin(0);
  dependencies.read(shared);
  dependencies.end(false);
  dependencies.begin(2);
  dependencies.read(own);
  dependencies.end(false);
  dependencies.begin(1);
  dependencies.read(shared);
  dependencies.read(shared);
  dependencies.end(true);
  expect([0, 1, 2].map((site) => dependencies.isStale(site))).toEqual([true, true, false]);
});

test("reads outside a visit are not recorded", () => {
  const dependencies = new SiteDependencies(1);
  const fact = node();
  dependencies.read(fact);
  dependencies.changed(fact);
  expect(dependencies.isStale(0)).toBe(false);
});

test("a site visited again is listed once per fact", () => {
  const dependencies = new SiteDependencies(3);
  const fact = node();
  for (const site of [0, 2, 1, 2, 0]) {
    dependencies.begin(site);
    dependencies.read(fact);
    dependencies.end(false);
  }
  dependencies.changed(fact);
  expect([0, 1, 2].map((site) => dependencies.isStale(site))).toEqual([true, true, true]);
});
