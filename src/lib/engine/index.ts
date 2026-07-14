// ─────────────────────────────────────────────────────────────────────────────
// Engine barrel. Importing this registers the built-in tasks. Call
// loadBuiltinMaps() once (in scripts / server startup / tests) to load map data
// from disk into the retrieval map registry.
// ─────────────────────────────────────────────────────────────────────────────

import { loadMap } from "@/lib/config";
import { registerTask } from "./registry";
import { retrievalTask, registerRetrievalMap } from "@/lib/tasks/retrieval";

// Register tasks at import time (pure, no I/O).
registerTask(retrievalTask);

let mapsLoaded = false;

/** Idempotent: load all built-in maps from src/config/maps into the registry. */
export function loadBuiltinMaps(): void {
  if (mapsLoaded) return;
  registerRetrievalMap(loadMap("retrieval_6room"));
  mapsLoaded = true;
}

export { runTrial } from "./runner";
export type {
  BotPolicy,
  BotContext,
  EventSink,
  TaskEventAdapter,
} from "./runner";
export { getTask, registerTask, registeredTaskIds } from "./registry";
export { retrievalTask, retrievalAdapter } from "@/lib/tasks/retrieval";
export { randomBot, moveOnlyBot, oracleRetrievalBot } from "./bots";
