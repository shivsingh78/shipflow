import { CloudUpload } from "lucide-react";
import { DeployButton } from "@/components/releases/ReleaseActions";

/** Deploy needs an application: the standard deploy dialog lets you choose one. */
export function QuickDeploy({ projects }: { projects: string[] }) {
  if (projects.length === 0) return null;

  return <DeployButton projects={projects} label="Deploy…" variant="secondary" icon={<CloudUpload size={15} aria-hidden />} />;
}
