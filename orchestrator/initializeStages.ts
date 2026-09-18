import { stageRegistryFor } from "./stageRegistry";
import type { AssetType, Pipeline, Stage } from "@/types";

/** Pending stages for a run, from the ladder its page type and pipeline select. Shared by the strategy gate and direct run creation. */
export function initializeStages(assetType: AssetType | undefined, pipeline: Pipeline | undefined): Stage[] {
  return stageRegistryFor(assetType, pipeline).map((def) => ({
    number: def.number,
    title: def.title,
    ownerSlug: def.ownerSlug,
    status: "pending",
    output: "",
    feedbackHistory: [],
    subTasks: def.subTasks.map((st) => ({
      id: st.id,
      title: st.title,
      status: "pending" as const,
      output: "",
      feedbackHistory: [],
    })),
  }));
}
