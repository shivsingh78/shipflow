import { useState } from "react";
import type { FormEvent } from "react";
import { FlaskConical, KeyRound } from "lucide-react";
import { describeError } from "@/api/errors";
import { Banner, Button, Card, Checkbox, SecretField } from "@/components/ui";
import { Logo } from "@/components/layout/Logo";
import { useAuth } from "./AuthProvider";

export function LoginPage() {
  const { signIn, enterDemo, notice } = useAuth();
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!token.trim()) {
      setError("Enter the API token.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await signIn(token, remember);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <Card className="login__card">
        <div className="login__brand">
          <Logo size={36} />
          <div>
            <h1 style={{ fontSize: "var(--text-xl)" }}>Sign in to ShipFlow</h1>
            <p className="muted">Self-hosted deployments</p>
          </div>
        </div>
        <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
          {notice ? <Banner tone="warning">{notice}</Banner> : null}
          <SecretField label="API token" value={token} onChange={setToken} required placeholder="SHIPFLOW_API_TOKEN" error={error} hint="The value of SHIPFLOW_API_TOKEN from your server's .env file." />
          <Checkbox label="Remember on this device" description="Stores the token in this browser until you sign out. Leave off on shared computers." checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <Button type="submit" variant="primary" size="lg" loading={busy} icon={<KeyRound size={15} aria-hidden />}>
            Sign in
          </Button>
        </form>
        <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "var(--space-5) 0" }} />
        <div className="stack--sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <Button onClick={enterDemo} icon={<FlaskConical size={14} aria-hidden />}>
            Explore with sample data
          </Button>
          <p className="field__hint">Demo mode never contacts a server. It shows made-up applications so you can look around.</p>
        </div>
      </Card>
    </div>
  );
}
