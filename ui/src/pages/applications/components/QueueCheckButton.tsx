import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { TestTube2 } from "lucide-react";
import { describeError } from "@/api/errors";
import { useApi } from "@/auth/AuthProvider";
import { Button, useToast } from "@/components/ui";

/** Queue a check-only run (prepare, build, test; never deploys) of the default branch. */
export function QueueCheckButton({ project, branch }: { project: string; branch: string }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);

    try {
      const release = await api.deploy({ project, ref: branch, mode: "check" });

      toast.success("Check queued", `Release ${release.release_id} will prepare, build and test ${branch}. Nothing is deployed.`);
      void navigate(`/releases/${release.release_id}`);
    } catch (caught) {
      toast.error("Could not queue the check", describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button onClick={() => void run()} loading={busy} icon={<TestTube2 size={14} aria-hidden />} title="Prepare, build and test without deploying">
      Re-run as check
    </Button>
  );
}
