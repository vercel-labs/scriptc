/** @param {string | undefined} needle */
function probe(needle) {
  const value = "ababa";
  console.log(
    value.indexOf(needle),
    value.indexOf(needle, 1),
    value.includes(needle),
    value.includes(needle, 1),
    value.startsWith(needle),
    value.startsWith(needle, 1),
    value.endsWith(needle),
    value.endsWith(needle, 2),
  );
}

probe("ba");
probe(undefined);
