function probe(needle, position) {
  const value = "ababa";
  console.log(
    value.indexOf(needle, position),
    value.includes(needle, position),
    value.startsWith(needle, position),
    value.endsWith(needle, position),
  );
}

probe("ba", 1);
probe(1, 0);
probe(undefined, 0);
