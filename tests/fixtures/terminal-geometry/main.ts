function geometry(): number[] {
  return [
    (process.stdout as typeof process.stdout & { columns?: number }).columns ?? -1,
    (process.stdout as typeof process.stdout & { rows?: number }).rows ?? -1,
    (process.stderr as typeof process.stderr & { columns?: number }).columns ?? -1,
    (process.stderr as typeof process.stderr & { rows?: number }).rows ?? -1,
  ];
}
console.log(JSON.stringify(geometry()));
let ticks = 0;
const timer = setInterval(() => {
  const size = geometry();
  if (size[0] === 100 && size[1] === 52 && size[2] === 80 && size[3] === 24) {
    console.log(JSON.stringify(size));
    clearInterval(timer);
  } else if (++ticks > 500) {
    clearInterval(timer);
    process.exitCode = 1;
  }
}, 5);
