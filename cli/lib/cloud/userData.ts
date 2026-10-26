import { asText } from "../errors.js";

// EC2 user-data bootstrap. It contains only public information: the deploy
// user's PUBLIC key and fixed configuration. The private key never leaves the
// machine that generated it except through ShipFlow's encrypted secret store.
export const DEPLOY_USER = "shipflow-deploy";
export const BOOTSTRAP_MARKER = "SHIPFLOW-BOOTSTRAP-COMPLETE";
export const HOSTKEY_BEGIN = "SHIPFLOW-HOSTKEY-BEGIN";
export const HOSTKEY_END = "SHIPFLOW-HOSTKEY-END";

const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEPLOYMENT = /^sf-[a-f0-9]{8}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68} ?[A-Za-z0-9@._:-]*$/;

export function sitePath(project: string): string {
  return `/srv/shipflow/${project}`;
}

/**
 * @returns the script as plain text (callers base64-encode it for RunInstances)
 */
export function buildUserData({
  project,
  deploymentId,
  publicKey,
}: {
  project: string;
  deploymentId: string;
  publicKey: string;
}): string {
  if (!PROJECT.test(project)) throw new Error("Invalid project name for user-data");
  if (!DEPLOYMENT.test(deploymentId)) throw new Error("Invalid deployment ID for user-data");
  if (!PUBLIC_KEY.test(publicKey.trim())) throw new Error("Not an ssh-ed25519 public key");
  if (/PRIVATE KEY/i.test(publicKey)) throw new Error("Refusing to put a private key in user-data");

  const root = sitePath(project);

  return `#!/bin/bash
# ShipFlow bootstrap (${deploymentId}): nginx + an unprivileged deploy user.
set -euo pipefail
exec > >(tee -a /var/log/shipflow-bootstrap.log) 2>&1

DEPLOY_USER="${DEPLOY_USER}"

dnf install -y nginx tar

id -u "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
cat > "/home/$DEPLOY_USER/.ssh/authorized_keys" <<'SHIPFLOW_PUBLIC_KEY'
${publicKey.trim()}
SHIPFLOW_PUBLIC_KEY
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"

# Key-only SSH, no root login.
cat > /etc/ssh/sshd_config.d/40-shipflow.conf <<'SSHD'
PasswordAuthentication no
PermitRootLogin no
SSHD
systemctl reload sshd

# ShipFlow deploys releases/<id>/ and a "current" symlink inside this directory.
install -d -m 755 -o root -g root /srv/shipflow
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${root}"

cat > /etc/nginx/conf.d/shipflow.conf <<'NGINX'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  root ${root}/current;
  index index.html;
  add_header Cache-Control "no-cache";
  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX
nginx -t
systemctl enable --now nginx

# Report the SSH host key and completion on the console so the ShipFlow CLI can
# read them through the authenticated AWS API (EC2 GetConsoleOutput).
{
  echo "${HOSTKEY_BEGIN}"
  cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub
  echo "${HOSTKEY_END}"
  echo "${BOOTSTRAP_MARKER} ${deploymentId}"
} | tee /dev/console >/dev/null || true
`;
}

/**
 * Parse EC2 console output for the bootstrap markers.
 * GetConsoleOutput returns base64 text; decoded text is accepted too.
 */
export function parseConsoleOutput(
  output: unknown,
  deploymentId: string
): { complete: boolean; hostKey: string | null } {
  let text = asText(output);

  if (!text.includes("SHIPFLOW-")) {
    try {
      const decoded = Buffer.from(text, "base64").toString("utf8");
      if (decoded.includes("SHIPFLOW-")) text = decoded;
    } catch {
      // not base64: use as is
    }
  }

  const complete = text.includes(`${BOOTSTRAP_MARKER} ${deploymentId}`);
  const block = new RegExp(
    `${HOSTKEY_BEGIN}\\r?\\n(ssh-ed25519 [A-Za-z0-9+/]{68})\\r?\\n${HOSTKEY_END}`
  ).exec(text);

  return { complete, hostKey: block?.[1] ?? null };
}
