// ─────────────────────────────────────────────────────────────────────────────
// Task plugin registry (§9.2: tasks are plugins behind one interface).
//
// A new task = one new file that calls registerTask(). Nothing else edits.
// ─────────────────────────────────────────────────────────────────────────────

import type { Task, TaskId } from "@/lib/types";
import type { TaskEventAdapter } from "./runner";

const registry = new Map<TaskId, Task<any, any>>();
const adapters = new Map<TaskId, TaskEventAdapter<any, any>>();

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

export function registerAdapter(id: TaskId, adapter: TaskEventAdapter<any, any>): void {
  adapters.set(id, adapter);
}

export function getAdapter(id: TaskId): TaskEventAdapter<any, any> {
  const a = adapters.get(id);
  if (!a) throw new Error(`No event adapter registered for task "${id}".`);
  return a;
}

export function registeredTaskIds(): TaskId[] {
  return [...registry.keys()];
}
