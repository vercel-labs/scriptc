import { describe, expect, test } from "vitest";
import { regexCaptureParticipation } from "./replacer-params.js";

describe("regex capture participation", () => {
  test("counts captures and marks the ones every match sets", () => {
    expect(regexCaptureParticipation("\\{(\\w+)\\}", "g")).toEqual({
      count: 2,
      always: [true, true],
    });
    expect(regexCaptureParticipation("(\\d{4})-(\\d{2})(?:-(\\d{2}))?", "g")).toEqual({
      count: 4,
      always: [true, true, true, false],
    });
    expect(regexCaptureParticipation("(a)|(b)", "")).toEqual({
      count: 3,
      always: [true, false, false],
    });
    expect(regexCaptureParticipation("((a)|b)", "")).toEqual({
      count: 3,
      always: [true, true, false],
    });
    expect(regexCaptureParticipation("(?:(a)|b)(c)", "")).toEqual({
      count: 3,
      always: [true, false, true],
    });
    expect(regexCaptureParticipation("(a)*(b)+(c){0,2}(d){1,3}(e){00}", "")).toEqual({
      count: 6,
      always: [true, false, true, false, true, false],
    });
    expect(regexCaptureParticipation("(?=(a))(?!(b))(?<=(c))(?<!(d))(?<name>e)", "")).toEqual({
      count: 6,
      always: [true, false, false, false, false, true],
    });
  });

  test("skips escapes, classes and non-capturing groups", () => {
    expect(regexCaptureParticipation("\\((a)\\)[(|)\\]](?:b)(?i:c)", "")).toEqual({
      count: 2,
      always: [true, true],
    });
    expect(regexCaptureParticipation("[](a)", "")).toEqual({ count: 2, always: [true, true] });
    expect(regexCaptureParticipation("(a)[", "")).toBeNull();
    expect(regexCaptureParticipation("(a", "")).toBeNull();
    expect(regexCaptureParticipation("a)", "")).toBeNull();
    expect(regexCaptureParticipation("(a)", "v")).toBeNull();
  });
  test("marks captures in alternations, optional groups and lookarounds", () => {
    const always = (pattern: string): boolean[] | null =>
      regexCaptureParticipation(pattern, "")?.always ?? null;
    expect(always("tag(\\d+)")).toEqual([true, true]);
    expect(always("((a)b)+c")).toEqual([true, true, true]);
    expect(always("(?<name>\\d)(x)")).toEqual([true, true, true]);
    expect(always("(a){2,3}")).toEqual([true, true]);
    expect(always("(?:x|y)(a)")).toEqual([true, true]);
    expect(always("(?:(a)|b)c")).toEqual([true, false]);
    expect(always("(x)?(\\d)")).toEqual([true, false, true]);
    expect(always("(?:(t)a)*g")).toEqual([true, false]);
    expect(always("((a)?)")).toEqual([true, true, false]);
    expect(always("(?<=(-))(\\w)")).toEqual([true, false, true]);
    expect(always("[\\]|(](b)")).toEqual([true, true]);
    expect(always("[^)](c)\\|")).toEqual([true, true]);
  });
});
