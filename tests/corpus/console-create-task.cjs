// React's development build stores console.createTask during module
// initialization (`createTask = console.createTask ? console.createTask :
// function () { return null; }`) and calls it through that binding. The task
// object's run() calls the callback it is given and answers its result.
"use strict";
var createTask = console.createTask ? console.createTask : function () {
  return null;
};
var task = createTask("React.startTransition");
console.log(typeof task, Object.keys(task).join(","));
console.log(task.run(function () {
  return "rendered";
}));
console.log(console.createTask === console.createTask);
try {
  console.createTask("");
} catch (err) {
  console.log(err.message);
}
try {
  task.run(5);
} catch (err) {
  console.log(err.message);
}
var receiver = "unset";
console.log(task.run(function () {
  "use strict";
  receiver = this;
  return this === undefined;
}), receiver);
var instance = new console.Console(process.stdout);
console.log(typeof instance.createTask);
