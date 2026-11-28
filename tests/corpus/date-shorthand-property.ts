// A Date created by its declaration is a time value only when every use
// reads the time value; shorthand and property positions carry the Date
// object itself.
interface Span {
  start: Date;
  end: Date;
}

function width(span: Span): number {
  return span.end.getTime() - span.start.getTime();
}

function collect(): Span {
  const end = new Date(1700000000000);
  const start = new Date(end.getTime() - 1000);
  return { start, end };
}

console.log(width(collect()));

const epoch = new Date(0);
console.log(epoch.getTime(), epoch.toISOString());
