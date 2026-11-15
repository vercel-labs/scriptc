exports.speak = (label) => {
  console.log(`island log ${label}`);
  process.stdout.write(Buffer.from(`island bytes ${label}\n`));
  console.error(`island error ${label}`);
};
