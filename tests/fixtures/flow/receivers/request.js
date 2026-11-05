// A request built with a constructor function, and functions with a typed
// `this` that receive it through `.call` and `forEach`.
import {AsyncLocalStorage} from 'async_hooks';

export type Task = {id: number, done: boolean};

export type Request = {
  name: string,
  pending: number,
  log: Array<string>,
  tasks: Set<Task>,
  byId: Map<number, Task>,
  destination: null | {write: (text: string) => void},
};

// A constructor function whose instance the context types as a record.
function RequestInstance(this: $FlowFixMe, name: string, tasks: Set<Task>) {
  const byId: Map<number, Task> = new Map();
  tasks.forEach(task => byId.set(task.id, task));
  this.name = name;
  this.pending = tasks.size;
  this.log = [];
  this.tasks = tasks;
  this.byId = byId;
  this.destination = null;
}

export function createRequest(name: string, count: number): Request {
  const tasks: Set<Task> = new Set();
  for (let id = 1; id <= count; id++) tasks.add({id, done: false});
  const request: Request = new (RequestInstance: any)(name, tasks);
  return request;
}

// A function with a typed `this`, reached only with its receiver bound.
function finishTask(this: Request, task: Task): void {
  task.done = true;
  this.pending--;
  this.log.push('finished ' + task.id);
}

// Exported under another name: used there as a value, so it keeps the
// call-time receiver.
function markTask(this: Request, task: Task): void {
  this.log.push('marked ' + task.id);
}
export {markTask as mark};

function noteTask(this: Request, task: Task, id: number): void {
  this.log.push('task ' + id + (task.done ? ' done' : ' open'));
}

export function finishAll(request: Request): void {
  request.tasks.forEach(finishTask, request);
}

export function finishOne(request: Request, id: number): void {
  const task = request.byId.get(id);
  if (task !== undefined && !task.done) finishTask.call(request, task);
}

export function noteAll(request: Request): void {
  request.byId.forEach(noteTask, request);
}

const requestStorage: AsyncLocalStorage<Request> = new AsyncLocalStorage();

function performWork(request: Request, label: string): number {
  request.log.push(label + ' in ' + String(requestStorage.getStore() !== undefined));
  request.pending = 0;
  return request.log.length;
}

export function work(request: Request, label: string): number {
  return requestStorage.run(request, performWork, request, label);
}
