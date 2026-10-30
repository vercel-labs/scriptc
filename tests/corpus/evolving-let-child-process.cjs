// An initializer-less `let` assigned a child process on every branch keeps
// the child's type, including when callbacks read it, as Node's
// child_process tests do when they choose a command per platform.
const { spawn } = require('child_process');

let child;
if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'echo', 'hi']);
else child = spawn('echo', ['hi']);
let text = '';
child.stdout.on('data', (chunk) => {
  text += chunk;
});

let producer, consumer;
if (process.platform === 'win32') {
  producer = spawn('cmd.exe', ['/c', 'echo', 'hello&&', 'echo', 'node']);
  consumer = spawn('findstr', ['o']);
} else {
  producer = spawn('printf', ['hello\nnode\nand\nworld\n']);
  consumer = spawn('grep', ['o']);
}
producer.stdout.on('data', (data) => {
  if (!consumer.stdin.write(data)) producer.stdout.pause();
});
consumer.stdin.on('drain', () => producer.stdout.resume());
producer.stdout.on('end', () => consumer.stdin.end());
let piped = '';
consumer.stdout.on('data', (data) => {
  piped += data.toString('utf8', 0, data.length);
});

let quiet;
if (process.platform === 'win32') quiet = spawn('cmd.exe', ['/c', 'echo', 'quiet']);
else quiet = spawn('echo', ['quiet']);
quiet.stdout.setEncoding('utf8');
quiet.stdout.resume();

let count;
if (process.argv.length > 10) count = Math.max(1, 2);
else count = Math.min(3, 4);
console.log(count.toFixed(1));

process.on('exit', () => {
  console.log(JSON.stringify(text), JSON.stringify(piped));
  console.log(child.exitCode, producer.exitCode, consumer.exitCode, consumer.signalCode, quiet.exitCode);
});
