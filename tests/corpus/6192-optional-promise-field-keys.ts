// Object.keys over an instance whose optional field holds a promise:
// boxing the instance links the promise adapter of the runtime.

class Job {
  done?: Promise<void>;
  name = "job";
}

const job = new Job();
console.log(Object.keys(job).join(","));
job.done = Promise.resolve();
console.log(Object.keys(job).join(","), typeof job.done);
