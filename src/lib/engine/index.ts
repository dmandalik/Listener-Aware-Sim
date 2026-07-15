// ─────────────────────────────────────────────────────────────────────────────
// Engine barrel. Importing this registers the built-in tasks. Call
// loadBuiltinMaps() once (in scripts / server startup / tests) to load map data
// from disk into the retrieval map registry.
// ─────────────────────────────────────────────────────────────────────────────

import { loadMap, loadTeleopMap, loadRepairDiagram } from "@/lib/config";
import { registerTask, registerAdapter } from "./registry";
import {
  retrievalTask,
  retrievalAdapter,
  registerRetrievalMap,
} from "@/lib/tasks/retrieval";
import { teleopTask, teleopAdapter, registerTeleopMap } from "@/lib/tasks/teleop";
import { repairTask, repairAdapter, registerRepairDiagram } from "@/lib/tasks/repair";

// Register tasks + their event adapters at import time (pure, no I/O).
registerTask(retrievalTask);
registerAdapter("retrieval", retrievalAdapter);
registerTask(teleopTask);
registerAdapter("teleop", teleopAdapter);
registerTask(repairTask);
registerAdapter("repair", repairAdapter);

let mapsLoaded = false;

/** Idempotent: load all built-in maps from src/config/maps into the registry. */
export function loadBuiltinMaps(): void {
  if (mapsLoaded) return;
  registerRetrievalMap(loadMap("retrieval_6room"));
  registerRetrievalMap(loadMap("retrieval_facility"));
  registerRetrievalMap(loadMap("retrieval_facility_2"));
  registerRetrievalMap(loadMap("retrieval_facility_3"));
  registerTeleopMap(loadTeleopMap("teleop_corridor"));
  registerTeleopMap(loadTeleopMap("teleop_yard"));
  registerTeleopMap(loadTeleopMap("teleop_yard_2"));
  registerTeleopMap(loadTeleopMap("teleop_yard_3"));
  registerRepairDiagram(loadRepairDiagram("repair_board"));
  registerRepairDiagram(loadRepairDiagram("repair_board_2"));
  registerRepairDiagram(loadRepairDiagram("repair_board_3"));
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
export { teleopTask, teleopAdapter } from "@/lib/tasks/teleop";
export { repairTask, repairAdapter } from "@/lib/tasks/repair";
export {
  randomBot,
  moveOnlyBot,
  oracleRetrievalBot,
  oracleTeleopBot,
  keyMashTeleopBot,
  oracleRepairBot,
} from "./bots";
