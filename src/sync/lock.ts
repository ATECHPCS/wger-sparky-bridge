// Single in-process run lock shared by the scheduler and the manual trigger so
// a cron tick and a POST /sync/trigger can never run concurrently (concurrent
// runs double the load and race on the same records).
let running = false;

export function tryAcquireRun(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function releaseRun(): void {
  running = false;
}

export function isRunning(): boolean {
  return running;
}
