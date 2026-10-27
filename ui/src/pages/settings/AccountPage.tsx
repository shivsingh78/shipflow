import { Bell, KeyRound, UserRound } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, KeyValue, PageHeader } from "@/components/ui";
import { useAuth } from "@/auth/AuthProvider";
import { useWhoAmI } from "@/data/hooks";
import "@/pages/infrastructure/infrastructure.css";

const UNSUPPORTED = [
  { icon: UserRound, title: "Profile", text: "There are no user profiles." },
  { icon: Bell, title: "Notifications", text: "Notification preferences are not supported." },
  { icon: KeyRound, title: "API keys", text: "Only the single shared API token exists; per-user keys are not supported." },
] as const;

export default function AccountPage() {
  const { demo, token, remembered, signOut } = useAuth();
  const who = useWhoAmI();

  return (
    <div className="stack">
      <PageHeader title="Account" description="Your current session." />
      <Banner tone="info" title="Single shared token">
        ShipFlow uses a single shared API token; there are no user accounts, roles or profiles yet.
      </Banner>

      <Card>
        <CardHeader title="Session" />
        <CardBody>
          <KeyValue
            items={[
              { label: "Session type", value: <Badge tone={demo ? "warning" : "success"}>{demo ? "Demo (sample data)" : "Live"}</Badge> },
              { label: "Server instance", value: who.data?.instance ?? (who.status === "error" ? "Unavailable" : "Loading…") },
              {
                label: "API token",
                value: demo ? "None: demo mode uses no token" : <span><code aria-label={`Token hidden, ${token?.length ?? 0} characters`}>••••••••</code> <span className="muted">({token?.length ?? 0} characters, never displayed)</span></span>,
              },
              { label: "Stored", value: demo ? "Nothing is stored" : remembered ? "On this device (localStorage), survives closing the browser" : "In this tab only (sessionStorage), cleared when the tab closes" },
            ]}
          />
          <div className="infra-actions">
            <Button variant="danger" onClick={() => signOut()}>Sign out</Button>
            {remembered && !demo ? <Button onClick={() => signOut()}>Forget token on this device</Button> : null}
          </div>
          <p className="muted" style={{ marginTop: "var(--space-3)" }}>Signing out removes the token from this browser. It does not revoke it on the server.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rotating the token" />
        <CardBody>
          <p>Change <code>SHIPFLOW_API_TOKEN</code> on the server and restart ShipFlow. Existing dashboard sessions are signed out automatically when the API answers 401; sign in again with the new token.</p>
        </CardBody>
      </Card>

      <div className="settings-grid">
        {UNSUPPORTED.map(({ icon: Icon, title, text }) => (
          <Card key={title}>
            <CardBody>
              <div className="disabled-block">
                <div className="row"><Icon size={16} aria-hidden /><strong>{title}</strong><Badge>Not supported yet</Badge></div>
                <p className="muted">{text}</p>
                <div><Button disabled aria-label={`${title}: not supported yet`}>Configure</Button></div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
