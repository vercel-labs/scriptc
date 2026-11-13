// process.pid and process.ppid: positive integer ids of this process and
// its parent. They are stable across reads and print as integers, never as
// a fraction that a formatter would round.
const pid = process.pid;
const ppid = process.ppid;
console.log("pid", typeof pid, Number.isInteger(pid), pid > 0, pid === Math.floor(pid));
console.log("pid-stable", pid === process.pid, Object.is(pid, process.pid));
console.log("ppid", typeof ppid, Number.isInteger(ppid), ppid > 0, ppid === Math.floor(ppid));
console.log("ppid-stable", ppid === process.ppid);
console.log("distinct", pid !== ppid);
const held = process;
console.log("held", held.pid === pid, held.ppid === ppid);
