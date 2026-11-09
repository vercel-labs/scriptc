// Promise.all over optional entries whose promises fulfill a value or
// undefined (`Promise<T | undefined> | undefined`). An entry that is undefined
// fulfills its position with undefined; a present one with its own value.
interface Reading {
  station: string;
  celsius: number;
}

// A probe that answers after `ms`, or with nothing when the sensor is out of range.
function probe(station: string, celsius: number, ms: number): Promise<Reading | undefined> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(celsius < -80 ? undefined : { station, celsius }), ms);
  });
}

function label(reading: Reading | undefined): string {
  return reading === undefined ? "-" : `${reading.station}@${reading.celsius}`;
}

// Three positions of two value types, each of which may be absent. The middle
// one is made by an optional call that maps its promise to a value or undefined.
async function survey(
  hill: Promise<Reading | undefined> | undefined,
  gauge: Promise<number> | undefined,
  coast: Promise<Reading | undefined> | undefined,
): Promise<string> {
  const [high, rain, low] = await Promise.all([
    hill,
    gauge?.then(
      (mm) => (mm > 0 ? mm : undefined),
      () => undefined,
    ),
    coast,
  ]);
  return `${label(high)} ${rain === undefined ? "dry" : rain.toFixed(1)} ${label(low)}`;
}

async function main(): Promise<void> {
  console.log(await survey(undefined, undefined, undefined));
  // The slower entry comes first: positions keep the order of the list.
  console.log(await survey(probe("hill", 4, 15), Promise.resolve(2.5), probe("coast", 11, 1)));
  console.log(await survey(probe("hill", -95, 1), Promise.resolve(0), undefined));
  // A rejection the entry's own handler answers.
  console.log(await survey(undefined, Promise.reject(new Error("gauge offline")), probe("coast", 9, 1)));

  // A rejection in an optional entry rejects the whole call.
  try {
    await survey(Promise.reject(new Error("mast down")), undefined, probe("coast", 9, 1));
    console.log("no rejection");
  } catch (error) {
    console.log("rejected:", (error as Error).message);
  }

  // The result unread: two optional entries awaited as a statement.
  const stations = new Map<string, Promise<Reading | undefined>>([["pier", probe("pier", 7, 2)]]);
  await Promise.all([stations.get("pier"), stations.get("ridge")]);
  console.log("pier", label(await stations.get("pier")));

  // The call settles in the same turn as Node's, against other microtasks.
  const trace: string[] = [];
  const present: Promise<string | undefined> | undefined = Promise.resolve("p");
  const absent: Promise<string | undefined> | undefined = stations.size > 5 ? present : undefined;
  const done = Promise.all([absent, present, 3]).then((all) => trace.push(`all(${all.join("/")})`));
  let turn = Promise.resolve();
  for (const name of ["m1", "m2", "m3", "m4", "m5"]) turn = turn.then(() => void trace.push(name));
  await done;
  await turn;
  console.log(trace.join(" "));
}
main();
