// read() on a paused object-mode stream answers the pushed objects
// themselves, in order, one per call.
import { Readable } from "node:stream";

type Job = { id: number; done: boolean };

const jobs: Job[] = [];
const source = new Readable({ objectMode: true, read() {} });
for (let i = 0; i < 3; i++) {
  const job = { id: i, done: false };
  jobs.push(job);
  source.push(job);
}
console.log(`length ${source.readableLength}`);
const first = source.read();
console.log(`first ${first.id} same=${first === jobs[0]}`);
first.done = true;
console.log(`jobs[0].done ${jobs[0]!.done}`);
source.push(null);
source.on("readable", () => {
  let job: any;
  while ((job = source.read()) !== null) {
    console.log(`read ${job.id} same=${job === jobs[job.id]} done=${job.done}`);
  }
});
source.on("end", () => console.log("end"));
