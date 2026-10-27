import { Compass } from "lucide-react";
import { EmptyState, LinkButton } from "@/components/ui";

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass size={22} aria-hidden />}
      title="Page not found"
      description="That page does not exist in this dashboard."
      action={<LinkButton to="/overview" variant="primary">Back to overview</LinkButton>}
    />
  );
}
