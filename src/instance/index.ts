export {
  openLoomInstance,
  type LoomInstance,
  type LoomInstanceRunResult,
  type LoomInstanceOpportunityResult,
  type LoomInstanceStatus,
  type OpenLoomInstanceOptions,
} from "./loom-instance.js";
export type { InteractionChannelAgentSurface } from "../channels/surface.js";
export {
  initializeLoomInstance,
  type InitializeLoomInstanceResult,
} from "./initialization.js";
export {
  createProcessDriver,
  type ProcessDriver,
  type ProcessDriverOptions,
  type ProcessDriverStatus,
  type ProcessDriverWait,
} from "./process-driver.js";
