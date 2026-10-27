export function pipeAll(source, destination, done) {
  source.on("end", () => done());
  source.pipe(destination);
}
