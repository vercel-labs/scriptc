// A position read over a union of tuples answers, per arm, that arm's element at the position,
// or undefined where the arm is shorter. Where one arm's element is a fetch handle (a
// checked-dynamic value) and the others are absent, null, a string, a number or a boolean, the
// read is the checked-dynamic value itself: the representation `Headers | undefined` or
// `string | Response` has in any other slot. Nothing is copied: the handle read is the handle the
// tuple holds.

// Different lengths: the second position exists in one arm only.
function forecast(station: number): [Error] | [null, Headers] {
  if (station < 0) return [new Error("no station " + station)];
  return [null, new Headers({ "x-wind": String(station * 3), "x-sky": "clear" })];
}

// The same after an await, with a handle of another kind.
async function reading(station: number): Promise<[Error] | [null, Response]> {
  if (station % 2 === 1) return [new Error("station " + station + " is offline")];
  return [null, new Response("gauge " + station, { status: 200 + station })];
}

// The same length, another element type at the position: a handle beside a string.
function bulletin(fresh: boolean): [boolean, string] | [number, Response] {
  if (!fresh) return [false, "yesterday's bulletin"];
  return [7, new Response("today's bulletin", { status: 203 })];
}

// Three arms: absent, a handle, a number.
function gauge(step: number): [Error] | [null, Headers] | [null, number, string] {
  if (step === 0) return [new Error("gauge is dry")];
  if (step === 1) return [null, new Headers({ "x-level": "14" })];
  return [null, 21, "manual"];
}

function describe(value: Headers | number | undefined): string {
  if (value === undefined) return "nothing";
  if (typeof value === "number") return "level " + value;
  return "header level " + value.get("x-level");
}

// The union as a parameter, and the position read before the first is tested.
function sky(answer: [Error] | [null, Headers]): string {
  const [problem, headers] = answer;
  const seen = headers === undefined ? "no headers" : "sky " + headers.get("x-sky");
  return seen + (problem === null ? "" : " (" + problem.message + ")");
}

async function main(): Promise<void> {
  for (const station of [4, -1]) {
    const [problem, headers] = forecast(station);
    if (problem) {
      console.log("forecast failed:", problem.message);
      continue;
    }
    // The checker narrows `headers` with the tuple; the binding holds the handle itself.
    console.log("wind", headers.get("x-wind"), "sky", headers.get("x-sky"));
    headers.set("x-seen", "yes");
    console.log("seen", headers.get("x-seen"));
  }

  for (const station of [2, 3]) {
    const [problem, response] = await reading(station);
    if (problem) {
      console.log("reading failed:", problem.message);
      continue;
    }
    console.log(response.status, await response.text());
  }

  for (const fresh of [true, false]) {
    const [mark, body] = bulletin(fresh);
    if (typeof body === "string") console.log("text", mark, body);
    else console.log("response", mark, body.status, await body.text());
  }

  for (let step = 0; step < 3; step++) {
    const [problem, level, source] = gauge(step);
    console.log(problem ? problem.message : "ok", describe(level), source ?? "no source");
  }

  // A default takes the place of the absent position only.
  const spare = new Headers({ "x-sky": "spare" });
  for (const station of [5, -2]) {
    const [, headers = spare] = forecast(station);
    console.log("default", headers.get("x-sky"), headers === spare);
  }

  // A conditional expression of two tuples.
  for (const calm of [true, false]) {
    const [problem, headers]: [Error] | [null, Headers] = calm
      ? [null, new Headers({ "x-sky": "calm" })]
      : [new Error("storm")];
    console.log(problem ? problem.message : "fine", headers ? headers.get("x-sky") : "none");
  }

  console.log(sky(forecast(1)));
  console.log(sky(forecast(-3)));

  // The handle read is the handle the tuple holds: a write through the binding is seen through
  // the tuple.
  const held: [Error] | [null, Headers] = forecast(6);
  const [, first] = held;
  if (first) first.set("x-sky", "overcast");
  const [, second] = held;
  console.log(second ? second.get("x-sky") : "none", first === second);

  // A value that does not hold the position its type names is a TypeError: where the member of
  // the missing handle is read in JavaScript, where the value is cast in the compiled program.
  try {
    const forged = [null] as unknown as [Error] | [null, Response];
    const [problem, response] = forged;
    if (!problem) console.log(response.status);
  } catch (error) {
    console.log("forged:", error instanceof TypeError);
  }
}

main();
export {};
