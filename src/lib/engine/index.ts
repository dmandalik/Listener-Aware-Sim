// ─────────────────────────────────────────────────────────────────────────────
// Engine barrel. Importing this registers the built-in tasks. Call
// loadBuiltinMaps() once (in scripts / server startup / tests) to load map data
// from disk into the retrieval map registry.
// ─────────────────────────────────────────────────────────────────────────────

import { loadMap } from "@/lib/config";
import { registerTask, registerAdapter } from "./registry";
import {
  retrievalTask,
  retrievalAdapter,
  registerRetrievalMap,
} from "@/lib/tasks/retrieval";

// Register tasks + their event adapters at import time (pure, no I/O).
registerTask(retrievalTask);
registerAdapter("retrieval", retrievalAdapter);

let mapsLoaded = false;

/** Idempotent: load all built-in maps from src/config/maps into the registry. */
export function loadBuiltinMaps(): void {
  if (mapsLoaded) return;
  registerRetrievalMap(loadMap("retrieval_6room"));
  registerRetrievalMap(loadMap("retrieval_facility"));
  mapsLoaded = true;
}

export { runTrial } from "./runner";
export type {
  BotPolicy,
  BotContext,
  EventSink,
  TaskEventAdapter,
} from "./runner";
export {
  getTask,
  getAdapter,
  registerTask,
  registerAdapter,
  registeredTaskIds,
} from "./registry";
export { retrievalTask, retrievalAdapter } from "@/lib/tasks/retrieval";
export { randomBot, moveOnlyBot, oracleRetrievalBot } from "./bots";
