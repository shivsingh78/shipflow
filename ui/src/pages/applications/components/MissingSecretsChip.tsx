import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui";

export function MissingSecretsChip({ names }: { names: string[] }) {
  if (names.length === 0) return null;

  return (
    <Badge tone="warning" title={`Required secrets not set: ${names.join(", ")}`}>
      <KeyRound size={12} aria-hidden />
      {names.length === 1 ? "1 secret missing" : `${names.length} secrets missing`}
    </Badge>
  );
}
