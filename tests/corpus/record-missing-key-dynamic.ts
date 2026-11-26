// A dictionary whose value is checked-dynamic (typed by an assertion from
// `unknown`) reads a key the value does not hold as undefined, exactly as a
// record's index-signature read does and as Node reads any object. The
// undefined arm is kept for every value type, so a presence probe observes
// the absence instead of the read throwing the value's type check.
function read(raw: unknown): void {
  const strings = raw as Record<string, string>;
  if (!strings.projectId) console.log("probe", "no projectId");
  console.log("dot", strings.projectId, strings.projectId === undefined);
  console.log("bracket", strings["projectId"]);
  const { projectId } = strings;
  console.log("binding", projectId, projectId ?? "fallback");

  const numbers = raw as Record<string, number>;
  console.log("number", numbers.port, numbers.port === undefined);
  const flags = raw as Record<string, boolean>;
  console.log("bool", flags.verbose, flags.verbose === undefined);
  const objects = raw as Record<string, { label: string }>;
  console.log("object", objects.item, objects.item === undefined);

  const present = strings.name;
  console.log("present", present, present.length);

  const key = "projectId";
  console.log("computed", strings[key], strings[key] === undefined);

  // Keys the `.name` path spelling cannot name: an empty name and a
  // fractional index still read as undefined, and a failing check on one
  // keeps the bare root path.
  console.log("empty key", strings[""], strings[""] === undefined);
  console.log("fractional key", numbers[1.5], numbers[1.5] === undefined);
}

read({ name: "cli", count: 2, verbose: true, item: { label: "x" } });
