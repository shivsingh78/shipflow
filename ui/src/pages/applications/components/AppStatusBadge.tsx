import { Badge } from "@/components/ui";
import type { Tone } from "@/lib/status";
import { APP_STATUS_LABEL } from "../lib/appState";
import type { AppStatus } from "../lib/appState";

const TONE: Record<AppStatus, Tone> = { healthy: "success", failed: "danger", running: "info", never: "neutral" };
const HINT: Record<AppStatus, string> = {
  healthy: "The latest deployment succeeded and passed its live check at deploy time. ShipFlow does not monitor continuously.",
  failed: "The latest deployment failed.",
  running: "A deployment is queued or running.",
  never: "No deployment has been run yet.",
};

export function AppStatusBadge({ status }: { status: AppStatus }) {
  return (
    <Badge tone={TONE[status]} title={HINT[status]}>
      <span className={`dot${status === "running" ? " dot--pulse" : ""}`} aria-hidden />
      {APP_STATUS_LABEL[status]}
    </Badge>
  );
}
