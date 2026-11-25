/** How the target's committed runtime profile matched the speed units it
 * guided, from the helper's report for each unit object (runtime-unit.mjs).
 *
 * The profile is applied when a unit object is compiled, one function at a
 * time: the helper looks a function up by its profile name and takes the
 * record whose control-flow hash is the function's. A record is keyed by
 * name and hash, never by object. The pack compiles some units more than
 * once (the default, workers and young-nursery variants, for example), and
 * some names twice (a stub in one unit, the function in another), and where
 * the control flow of two such builds differs, the profile's record matches
 * one of them and reads as mismatched in the other however fresh it is.
 *
 * `annotated`, `mismatched` and `missing` add up the objects' functions, so
 * they say how much of the pack is optimized with the profile (`missing`:
 * functions it holds no record for) and count a function once per object.
 *
 * The other fields count by profile name, from helpers that list the
 * functions: a name annotated in any object counts as annotated, and a name
 * is mismatched only when no object's build of it matches, which is what a
 * change to the function since the profile was collected looks like.
 * `annotated_names` and `mismatched_names` count those names,
 * `annotated_counts` and `mismatched_counts` add up their counters in the
 * profile, and `stale` names the mismatched functions with the most counts.
 *
 * A name with records for two builds of it stays annotated when only one of
 * the builds changes, so that change is not counted. */
export function profileMatchSummary(matches) {
  const total = (field) => matches.reduce((sum, match) => sum + match[field], 0);
  const objects = {
    annotated: total("annotated"),
    mismatched: total("mismatched"),
    missing: total("missing"),
  };
  if (!matches.every((match) => match.annotated_counts !== undefined)) return objects;
  const annotated = new Map();
  const mismatched = new Map();
  for (const match of matches) {
    for (const [name, counts] of Object.entries(match.annotated_counts))
      annotated.set(name, counts);
    for (const [name, counts] of Object.entries(match.mismatched_counts))
      mismatched.set(name, counts);
  }
  for (const name of annotated.keys()) mismatched.delete(name);
  const sum = (map) => [...map.values()].reduce((counts, value) => counts + value, 0);
  return {
    ...objects,
    annotated_names: annotated.size,
    mismatched_names: mismatched.size,
    annotated_counts: sum(annotated),
    mismatched_counts: sum(mismatched),
    stale: [...mismatched]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name]) => name),
  };
}
