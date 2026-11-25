// The built dist of a workspace member whose declared API is typed with the
// record types of a declarations-only sibling.
export function summarize(entries) {
  let titles = "";
  for (const entry of entries) titles += (titles === "" ? "" : ",") + entry.title;
  return { count: entries.length, titles };
}

export function label(entry) {
  const tags = (entry.tags ?? []).join("+");
  return `${entry.id}:${entry.title}${tags === "" ? "" : ` [${tags}]`}`;
}
