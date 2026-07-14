// ─────────────────────────────────────────────────────────────────────────────
// Task plugin registry (§9.2: tasks are plugins behind one interface).
//
// A new task = one new file that calls registerTask(). Nothing else edits.
// ─────────────────────────────────────────────────────────────────────────────

import type { Task, TaskId } from "@/lib/types";

const registry = new Map<TaskId, Task<any, any>>();

export function registerTask(task: Task<any, any>): void {
  registry.set(task.id, task);
}

export function getTask(id: TaskId): Task<any, any> {
  const t = registry.get(id);
  if (!t) {
    throw new Error(
      `No task registered for "${id}". Registered: [${[...registry.keys()].join(", ") || "none"}]. ` +
        `Did you import the engine barrel (src/lib/engine) to load built-ins?`,
    );
  }
  return t;
}

export function registeredTaskIds(): TaskId[] {
  return [...registry.keys()];
}
