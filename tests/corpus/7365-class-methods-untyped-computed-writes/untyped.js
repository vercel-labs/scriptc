// Untyped helpers with computed writes whose keys TypeScript cannot know.
// They put every class method name in play for the method census.
export function tally(words) {
  const counts = {};
  for (const word of words) counts[word] = (counts[word] || 0) + 1;
  return counts;
}

export function patch(target, name, impl) {
  target[name] = impl;
}

export function unpatch(target, name) {
  delete target[name];
}
