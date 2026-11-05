// @flow
// A scheduler's shapes: two task kinds in one union, and boundaries and a
// request that hold Sets of tasks.

type Root = null;

type SuspenseBoundary = {
  status: number,
  fallbackAbortableTasks: Set<Task>,
  parentFlushed: boolean,
};

type RenderTask = {
  replay: null,
  id: number,
  blockedBoundary: Root | SuspenseBoundary,
  abortSet: Set<Task>,
};

type ReplayTask = {
  replay: {pending: number},
  id: number,
  blockedBoundary: Root | SuspenseBoundary,
  abortSet: Set<Task>,
};

export type Task = RenderTask | ReplayTask;

export type Request = {
  abortableTasks: Set<Task>,
  pingedTasks: Array<Task>,
  currentTask: null | Task,
};

export function createRequest(): Request {
  return {abortableTasks: new Set(), pingedTasks: [], currentTask: null};
}

export function createBoundary(): SuspenseBoundary {
  return {status: 0, fallbackAbortableTasks: new Set(), parentFlushed: false};
}

export function renderTask(
  request: Request,
  id: number,
  boundary: Root | SuspenseBoundary,
): Task {
  const task: RenderTask = {replay: null, id, blockedBoundary: boundary, abortSet: request.abortableTasks};
  request.abortableTasks.add(task);
  request.pingedTasks.push(task);
  if (boundary !== null) boundary.fallbackAbortableTasks.add(task);
  return task;
}

export function replayTask(request: Request, id: number, pending: number): Task {
  const task: ReplayTask = {
    replay: {pending},
    id,
    blockedBoundary: null,
    abortSet: request.abortableTasks,
  };
  request.abortableTasks.add(task);
  return task;
}

export function performWork(request: Request): string {
  const done = [];
  for (const task of request.pingedTasks) {
    request.currentTask = task;
    task.abortSet.delete(task);
    done.push(task.id);
  }
  request.pingedTasks = [];
  request.currentTask = null;
  return done.join(',');
}

export function pendingOf(request: Request): number {
  let pending = 0;
  request.abortableTasks.forEach(task => {
    pending += task.replay === null ? 1 : task.replay.pending;
  });
  return pending;
}
