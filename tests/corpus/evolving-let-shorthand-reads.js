// An initializer-less JavaScript `let` read through a shorthand property
// (`{ width }`) still reads undefined on the paths that never assign it, as
// npm packages do when they build an options or size object.
function size(tty) {
  let width;
  if (tty) width = 80;
  return { width };
}

/**
 * @param {boolean} tty
 * @returns {{ width: number | undefined }}
 */
function documented(tty) {
  /** @type {number | undefined} */
  let width;
  if (tty) width = 80;
  return { width };
}

function captured(tty) {
  let width;
  const read = () => ({ width });
  const before = read().width;
  if (tty) width = 80;
  return [before, read().width];
}

function nested(flags) {
  let columns;
  let rows;
  if (flags.columns) columns = 120;
  if (flags.rows) rows = 40;
  return { size: { columns, rows } };
}

console.log(size(true).width, size(false).width);
console.log(documented(true).width, documented(false).width);
console.log(JSON.stringify(size(false)), "width" in size(false));
console.log(captured(true), captured(false));
console.log(nested({ columns: true }), nested({ rows: true }), nested({}));
