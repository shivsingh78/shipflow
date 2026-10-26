import { dockerfileStrategy } from "./dockerfile.js";
import { nodeStrategy } from "./node.js";
import { staticStrategy } from "./static.js";
import type { BuildStrategy, StrategyId } from "./types.js";

const STRATEGIES: Record<StrategyId, BuildStrategy> = {
  static: staticStrategy,
  node: nodeStrategy,
  dockerfile: dockerfileStrategy,
};

export function getStrategy(id: StrategyId): BuildStrategy {
  return STRATEGIES[id];
}

export { detectStrategy } from "./detect.js";
export type { DetectInput } from "./detect.js";
export { DetectionError } from "./types.js";
export type { BuildStrategy, Detection, LocalArtifact, StrategyId, StrategyInput } from "./types.js";
