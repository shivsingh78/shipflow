// Non-secret metadata about cloud deployments, kept in
// ~/.config/shipflow/cloud/ (directory 0700, files 0600). It exists so that
// `cloud status` and `cloud destroy` know exactly which resources belong to a
// deployment. It never contains AWS credentials or private keys.
import fs from "fs";
import path from "path";

import { configDir } from "../credentials.js";
import { errorCode } from "../errors.js";

export const DEPLOYMENT_ID = /^sf-[a-f0-9]{8}$/;

/** Non-secret metadata about one cloud deployment. */
export interface DeploymentRecord {
  id: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  destroyedAt?: string;
  region?: string;
  project?: string;
  repository?: string;
  branch?: string;
  configFile?: string;
  instanceId?: string;
  instanceType?: string;
  diskGiB?: number;
  securityGroupId?: string;
  keyPairName?: string;
  sshCidr?: string;
  publicIp?: string | null;
  url?: string;
  releaseId?: string;
}

export interface Store {
  dir: string;
  save(id: string, fields: Partial<DeploymentRecord>): DeploymentRecord;
  load(id: string): DeploymentRecord | null;
  list(): DeploymentRecord[];
}

const ALLOWED_FIELDS: (keyof DeploymentRecord)[] = [
  "id", "state", "createdAt", "updatedAt", "destroyedAt",
  "region", "project", "repository", "branch", "configFile",
  "instanceId", "instanceType", "diskGiB", "securityGroupId", "keyPairName",
  "sshCidr", "publicIp", "url", "releaseId",
];

const SECRET_PATTERNS = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /aws_secret_access_key|aws_session_token|SecretAccessKey|SessionToken/i,
];

export function cloudDir(): string {
  return path.join(configDir(), "cloud");
}

export function createStore({ dir = cloudDir() }: { dir?: string } = {}): Store {
  const fileFor = (id: string): string => {
    if (!DEPLOYMENT_ID.test(id)) {
      throw new Error(`Invalid deployment ID: ${JSON.stringify(id)}`);
    }
    return path.join(dir, `${id}.json`);
  };

  return {
    dir,

    /** Merge `fields` into the record for `id` (creating it) and persist. */
    save(id, fields) {
      const current = this.load(id) ?? { id };
      const next: DeploymentRecord = { ...current };

      for (const key of ALLOWED_FIELDS) {
        // Only whitelisted keys are copied, and values keep the type of their key.
        if (fields[key] !== undefined) Object.assign(next, { [key]: fields[key] });
      }

      next.id = id;
      next.updatedAt = new Date().toISOString();

      const text = `${JSON.stringify(next, null, 2)}\n`;

      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
        throw new Error("Refusing to store metadata that looks like it contains a credential");
      }

      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);

      const file = fileFor(id);
      const temp = `${file}.${process.pid}.tmp`;

      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, file);

      return next;
    },

    load(id) {
      try {
        return JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as DeploymentRecord;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },

    /** All records, newest first. Unreadable files are skipped. */
    list() {
      let names: string[];

      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }

      return names
        .filter((name) => /^sf-[a-f0-9]{8}\.json$/.test(name))
        .map((name) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as DeploymentRecord;
          } catch {
            return null;
          }
        })
        .filter((record): record is DeploymentRecord => record !== null)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
  };
}
