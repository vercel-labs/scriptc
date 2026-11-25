exports.say = (label) => {
  console.log(`island log ${label}`);
  process.stdout.write(`island write ${label}\n`);
};
