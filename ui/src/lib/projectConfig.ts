// The shipflow.yml schema is shared with the server and the CLI (pure
// TypeScript, no dependencies), so the dashboard validates exactly what the
// server will validate.
export {
  validateProjectConfig,
  requiredSecrets,
  ProjectConfigError,
  TARGETS,
  IMAGE_TARGETS,
  BUILD_STRATEGIES,
} from "../../../cli/lib/projectConfig.ts";
export type {
  ProjectConfig,
  RuntimeConfig,
  BuildConfig,
  DeploymentConfig,
  DockerTarget,
  KubernetesTarget,
  SshTarget,
  ShipflowTarget,
  ProjectConfigIssue,
  TargetName,
  BuildStrategyName,
} from "../../../cli/lib/projectConfig.ts";
