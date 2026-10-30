import { Fragment } from "react";
import type { Release } from "@/api/types";
import { describeStages, stageStates } from "@/lib/pipeline";
import { stageLabel } from "@/lib/status";

/**
 * Six stage dots joined by a line: PREPARE → … → ACTIVATE. State comes from the
 * release record only; the text alternative reads out every stage.
 */
export function PipelineTrack({ release }: { release: Pick<Release, "status" | "current_stage" | "mode"> }) {
  const states = stageStates({ status: release.status, stage: release.current_stage, mode: release.mode });

  return (
    <span className="track" role="img" aria-label={`Pipeline: ${describeStages(states)}`}>
      {states.map(({ stage, state }, index) => (
        <Fragment key={stage}>
          {index > 0 ? <span className="track__line" data-state={states[index - 1]?.state === "done" ? "done" : "pending"} aria-hidden /> : null}
          <span className="track__node" data-state={state} title={`${stageLabel(stage)}: ${state}`} aria-hidden />
        </Fragment>
      ))}
    </span>
  );
}
