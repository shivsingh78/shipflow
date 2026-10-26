// Minimal typed Kubernetes REST client for the "kubernetes" deployment target.
//
// HONESTY NOTE: this client has only ever been exercised against an in-process
// fake API server in unit tests. It has NOT been run against a real Kubernetes
// or K3s cluster. Treat the first real use as an integration test.
//
// Scope: just what ShipFlow needs (Namespace, Deployment, Service, Secret,
// Pod list/log, service proxy, SelfSubjectAccessReview). No kubectl and no
// client library are used.
//
// Safety rules:
//   * the kubeconfig is supplied as secret text and is never read from disk;
//     file-path credentials (certificate-authority, client-certificate,
//     client-key, tokenFile) are rejected, so a kubeconfig cannot make
//     ShipFlow read arbitrary files
//   * exec and auth-provider plugins are rejected: a kubeconfig must never be
//     able to run commands on the ShipFlow worker
//   * TLS verification cannot be disabled (insecure-skip-tls-verify rejected);
//     plain http:// is accepted only for loopback hosts
//   * tokens, keys and kubeconfig contents are never put into error messages
import http from "http";
import https from "https";
import { parse as parseYaml } from "yaml";

export interface K8sResponse {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
  /** Raw body text (pod logs, proxied responses). */
  text: string;
}

/** Sends one request to the API server. Injectable for tests. */
export interface K8sTransport {
  request(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>
  ): Promise<K8sResponse>;
}

export interface KubeAuth {
  token?: string;
  clientCertificate?: string;
  clientKey?: string;
}

export interface KubeConnection {
  server: URL;
  /** PEM text of the cluster CA, when the kubeconfig carries one. */
  ca?: string;
  auth: KubeAuth;
  contextName: string;
}

export class KubeconfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KubeconfigError";
  }
}

export class K8sApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "K8sApiError";
    this.status = status;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function named(list: unknown, name: string, what: string): Json {
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isObject(entry) && entry.name === name) return entry;
    }
  }

  throw new KubeconfigError(`kubeconfig has no ${what} named "${name}"`);
}

function fromBase64(value: string, what: string): string {
  const decoded = Buffer.from(value, "base64").toString("utf8");

  if (!decoded.trim()) throw new KubeconfigError(`kubeconfig ${what} is empty or not valid base64`);

  return decoded;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * Parse kubeconfig YAML into a connection. Never echoes kubeconfig content in
 * errors (YAML parser messages quote the source, so they are replaced).
 */
export function parseKubeconfig(text: string): KubeConnection {
  let doc: unknown;

  try {
    doc = parseYaml(text);
  } catch {
    throw new KubeconfigError("kubeconfig is not valid YAML");
  }

  if (!isObject(doc)) throw new KubeconfigError("kubeconfig must be a YAML mapping");

  const contextName = str(doc["current-context"]);
  if (!contextName) throw new KubeconfigError("kubeconfig has no current-context");

  const context = named(doc.contexts, contextName, "context");
  const contextBody = isObject(context.context) ? context.context : {};
  const clusterName = str(contextBody.cluster);
  const userName = str(contextBody.user);

  if (!clusterName || !userName) {
    throw new KubeconfigError(`kubeconfig context "${contextName}" must name a cluster and a user`);
  }

  const clusterBody = (() => {
    const entry = named(doc.clusters, clusterName, "cluster");
    return isObject(entry.cluster) ? entry.cluster : {};
  })();
  const userBody = (() => {
    const entry = named(doc.users, userName, "user");
    return isObject(entry.user) ? entry.user : {};
  })();

  // Credentials that would run commands or read files are refused outright.
  if ("exec" in userBody) {
    throw new KubeconfigError(
      "kubeconfig users with an exec plugin are not supported (a kubeconfig must not run commands); use a service-account token or client certificate"
    );
  }
  if ("auth-provider" in userBody) {
    throw new KubeconfigError(
      "kubeconfig users with an auth-provider plugin are not supported; use a service-account token or client certificate"
    );
  }
  for (const key of ["tokenFile", "client-certificate", "client-key"]) {
    if (key in userBody) {
      throw new KubeconfigError(`kubeconfig user field "${key}" refers to a file; embed the data instead (client-certificate-data / client-key-data / token)`);
    }
  }
  if ("certificate-authority" in clusterBody) {
    throw new KubeconfigError('kubeconfig cluster field "certificate-authority" refers to a file; use certificate-authority-data');
  }
  if (clusterBody["insecure-skip-tls-verify"] === true) {
    throw new KubeconfigError("kubeconfig disables TLS verification (insecure-skip-tls-verify); this is not allowed");
  }
  if ("proxy-url" in clusterBody) {
    throw new KubeconfigError('kubeconfig cluster field "proxy-url" is not supported');
  }
  if ("username" in userBody || "password" in userBody) {
    throw new KubeconfigError("kubeconfig basic authentication is not supported; use a token or client certificate");
  }

  const serverText = str(clusterBody.server);
  if (!serverText) throw new KubeconfigError(`kubeconfig cluster "${clusterName}" has no server`);

  let server: URL;
  try {
    server = new URL(serverText);
  } catch {
    throw new KubeconfigError("kubeconfig cluster server is not a valid URL");
  }

  if (server.username || server.password) {
    throw new KubeconfigError("kubeconfig cluster server must not contain credentials");
  }
  if (server.protocol === "http:") {
    if (!isLoopbackHost(server.hostname)) {
      throw new KubeconfigError("kubeconfig cluster server uses plain http://; only https:// is allowed for non-loopback hosts");
    }
  } else if (server.protocol !== "https:") {
    throw new KubeconfigError("kubeconfig cluster server must be an https:// URL");
  }

  const caData = str(clusterBody["certificate-authority-data"]);
  const ca = caData ? fromBase64(caData, "certificate-authority-data") : undefined;

  const auth: KubeAuth = {};
  const token = str(userBody.token);
  const certData = str(userBody["client-certificate-data"]);
  const keyData = str(userBody["client-key-data"]);

  if (token) auth.token = token;
  if (certData || keyData) {
    if (!certData || !keyData) {
      throw new KubeconfigError("kubeconfig user needs both client-certificate-data and client-key-data");
    }
    auth.clientCertificate = fromBase64(certData, "client-certificate-data");
    auth.clientKey = fromBase64(keyData, "client-key-data");
  }

  if (!auth.token && !auth.clientCertificate) {
    throw new KubeconfigError(`kubeconfig user "${userName}" has no token or client certificate`);
  }

  const connection: KubeConnection = { server, auth, contextName };
  if (ca) connection.ca = ca;

  return connection;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The real transport: node:http(s), CA pinned from the kubeconfig, client cert if present. */
export function httpTransport(connection: KubeConnection): K8sTransport {
  const { server, ca, auth } = connection;
  const secure = server.protocol === "https:";
  const agent = secure
    ? new https.Agent({
        ...(ca ? { ca } : {}),
        ...(auth.clientCertificate && auth.clientKey ? { cert: auth.clientCertificate, key: auth.clientKey } : {}),
        keepAlive: true,
        rejectUnauthorized: true,
      })
    : undefined;

  return {
    request(method, path, body, headers = {}) {
      return new Promise<K8sResponse>((resolve, reject) => {
        const finalHeaders: Record<string, string> = { Accept: "application/json, text/plain", ...headers };
        if (auth.token) finalHeaders.Authorization = `Bearer ${auth.token}`;
        if (body !== undefined) finalHeaders["Content-Length"] = String(Buffer.byteLength(body));

        const base = server.pathname.replace(/\/$/, "");
        const options: http.RequestOptions = {
          method,
          hostname: server.hostname.replace(/^\[|\]$/g, ""),
          port: server.port || (secure ? 443 : 80),
          path: `${base}${path}`,
          headers: finalHeaders,
          timeout: REQUEST_TIMEOUT_MS,
          ...(agent ? { agent } : {}),
        };

        const req = (secure ? https : http).request(options, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;

          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size <= MAX_BODY_BYTES) chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown;

            try {
              json = text ? (JSON.parse(text) as unknown) : null;
            } catch {
              json = null;
            }

            resolve({ status: res.statusCode ?? 0, json, text });
          });
        });

        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", (error: Error) =>
          // Only the error code: messages can contain hostnames and TLS details.
          reject(new Error(`Kubernetes API request failed: ${(error as NodeJS.ErrnoException).code ?? error.message}`))
        );

        if (body !== undefined) req.write(body);
        req.end();
      });
    },
  };
}

export type K8sTransportFactory = (connection: KubeConnection) => K8sTransport;

const SEGMENT = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Path segment guard: names are validated, never trusted into URLs. */
function seg(value: string, what: string): string {
  if (!SEGMENT.test(value) || value.length > 253) throw new Error(`Invalid ${what} "${value.slice(0, 80)}"`);
  return value;
}

export interface ObjectMeta {
  name?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
  [key: string]: unknown;
}

export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: ObjectMeta;
  spec?: Json;
  status?: Json;
  [key: string]: unknown;
}

export interface PodSummary {
  name: string;
  phase: string;
  /** Waiting reasons of containers (ImagePullBackOff, CrashLoopBackOff, ...). */
  waiting: string[];
  restarts: number;
}

export const FIELD_MANAGER = "shipflow";

export class K8sClient {
  readonly connection: KubeConnection;
  private readonly transport: K8sTransport;

  constructor(connection: KubeConnection, transport: K8sTransport) {
    this.connection = connection;
    this.transport = transport;
  }

  /** Short human description of the target, without credentials. */
  describe(): string {
    return `${this.connection.server.host} (context ${this.connection.contextName})`;
  }

  private fail(action: string, response: K8sResponse): K8sApiError {
    let message = "";

    if (isObject(response.json) && typeof response.json.message === "string") {
      message = `: ${response.json.message.slice(0, 300)}`;
    }

    if (response.status === 401) message = ": credentials were rejected (check the kubeconfig token or certificate)";
    if (response.status === 403 && !message) message = ": forbidden (check RBAC for this user)";

    return new K8sApiError(`Kubernetes API ${action} failed with HTTP ${response.status}${message}`, response.status);
  }

  /** GET returning the object, or null on 404. */
  async get(path: string, action = `GET ${path.split("?")[0] ?? path}`): Promise<K8sObject | null> {
    const response = await this.transport.request("GET", path);

    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw this.fail(action, response);

    return isObject(response.json) ? response.json : {};
  }

  async post(path: string, body: unknown, action: string): Promise<K8sObject> {
    const response = await this.transport.request("POST", path, JSON.stringify(body), {
      "Content-Type": "application/json",
    });

    if (response.status < 200 || response.status >= 300) throw this.fail(action, response);

    return isObject(response.json) ? response.json : {};
  }

  /** Server-side apply (create or update) of one object. */
  async apply(path: string, body: K8sObject, action: string): Promise<K8sObject> {
    const response = await this.transport.request(
      "PATCH",
      `${path}?fieldManager=${FIELD_MANAGER}&force=true`,
      JSON.stringify(body),
      { "Content-Type": "application/apply-patch+yaml" }
    );

    if (response.status < 200 || response.status >= 300) throw this.fail(action, response);

    return isObject(response.json) ? response.json : {};
  }

  /** DELETE; a missing object is not an error. Foreground propagation removes pods too. */
  async delete(path: string, action: string): Promise<void> {
    const response = await this.transport.request(
      "DELETE",
      `${path}?propagationPolicy=Foreground`,
      JSON.stringify({ propagationPolicy: "Foreground" }),
      { "Content-Type": "application/json" }
    );

    if (response.status === 404) return;
    if (response.status < 200 || response.status >= 300) throw this.fail(action, response);
  }

  // ---- paths

  static namespacePath(namespace: string): string {
    return `/api/v1/namespaces/${seg(namespace, "namespace")}`;
  }

  static deploymentPath(namespace: string, name?: string): string {
    return `/apis/apps/v1/namespaces/${seg(namespace, "namespace")}/deployments${name ? `/${seg(name, "deployment name")}` : ""}`;
  }

  static servicePath(namespace: string, name?: string): string {
    return `${K8sClient.namespacePath(namespace)}/services${name ? `/${seg(name, "service name")}` : ""}`;
  }

  static secretPath(namespace: string, name?: string): string {
    return `${K8sClient.namespacePath(namespace)}/secrets${name ? `/${seg(name, "secret name")}` : ""}`;
  }

  // ---- typed operations

  async version(): Promise<string> {
    const object = await this.get("/version", "GET /version");

    return typeof object?.gitVersion === "string" ? object.gitVersion : "unknown";
  }

  getNamespace(namespace: string): Promise<K8sObject | null> {
    return this.get(K8sClient.namespacePath(namespace));
  }

  async createNamespace(namespace: string): Promise<void> {
    await this.post(
      "/api/v1/namespaces",
      { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels: { "app.kubernetes.io/managed-by": FIELD_MANAGER } } },
      `create namespace ${namespace}`
    );
  }

  getDeployment(namespace: string, name: string): Promise<K8sObject | null> {
    return this.get(K8sClient.deploymentPath(namespace, name));
  }

  applyDeployment(namespace: string, deployment: K8sObject): Promise<K8sObject> {
    return this.apply(K8sClient.deploymentPath(namespace, deployment.metadata?.name), deployment, `apply deployment ${deployment.metadata?.name}`);
  }

  deleteDeployment(namespace: string, name: string): Promise<void> {
    return this.delete(K8sClient.deploymentPath(namespace, name), `delete deployment ${name}`);
  }

  async listDeployments(namespace: string, labelSelector: string): Promise<K8sObject[]> {
    const list = await this.get(`${K8sClient.deploymentPath(namespace)}?labelSelector=${encodeURIComponent(labelSelector)}`);

    return Array.isArray(list?.items) ? (list.items as K8sObject[]) : [];
  }

  getService(namespace: string, name: string): Promise<K8sObject | null> {
    return this.get(K8sClient.servicePath(namespace, name));
  }

  applyService(namespace: string, service: K8sObject): Promise<K8sObject> {
    return this.apply(K8sClient.servicePath(namespace, service.metadata?.name), service, `apply service ${service.metadata?.name}`);
  }

  deleteService(namespace: string, name: string): Promise<void> {
    return this.delete(K8sClient.servicePath(namespace, name), `delete service ${name}`);
  }

  applySecret(namespace: string, secret: K8sObject): Promise<K8sObject> {
    // Action text names the secret object only, never its data.
    return this.apply(K8sClient.secretPath(namespace, secret.metadata?.name), secret, `apply secret ${secret.metadata?.name}`);
  }

  deleteSecret(namespace: string, name: string): Promise<void> {
    return this.delete(K8sClient.secretPath(namespace, name), `delete secret ${name}`);
  }

  async listPods(namespace: string, labelSelector: string): Promise<PodSummary[]> {
    const list = await this.get(`${K8sClient.namespacePath(namespace)}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
    const items = Array.isArray(list?.items) ? (list.items as K8sObject[]) : [];

    return items.map((pod) => {
      const status = isObject(pod.status) ? pod.status : {};
      const containers = Array.isArray(status.containerStatuses) ? (status.containerStatuses as unknown[]) : [];
      const waiting: string[] = [];
      let restarts = 0;

      for (const container of containers) {
        if (!isObject(container)) continue;
        if (typeof container.restartCount === "number") restarts += container.restartCount;

        const state = isObject(container.state) ? container.state : {};
        const wait = isObject(state.waiting) ? state.waiting : null;
        if (wait && typeof wait.reason === "string") waiting.push(wait.reason);
      }

      return {
        name: pod.metadata?.name ?? "",
        phase: typeof status.phase === "string" ? status.phase : "Unknown",
        waiting,
        restarts,
      };
    });
  }

  /** Last lines of a pod's log (empty string when unavailable). */
  async podLogTail(namespace: string, pod: string, lines: number, previous = false): Promise<string> {
    const path = `${K8sClient.namespacePath(namespace)}/pods/${seg(pod, "pod name")}/log?tailLines=${lines}${previous ? "&previous=true" : ""}`;
    const response = await this.transport.request("GET", path);

    return response.status === 200 ? response.text : "";
  }

  /** GET through the API server's service proxy; returns status and body without throwing on HTTP errors. */
  async proxyGet(namespace: string, service: string, port: number, path: string): Promise<K8sResponse> {
    const clean = path.replace(/^\/+/, "");
    const base = `${K8sClient.namespacePath(namespace)}/services/${seg(service, "service name")}:${port}/proxy/${clean}`;

    return this.transport.request("GET", base);
  }

  /** SelfSubjectAccessReview: may this user perform `verb` on the resource? */
  async can(namespace: string | null, verb: string, group: string, resource: string, subresource?: string): Promise<boolean> {
    const resourceAttributes: Json = { verb, group, resource };
    if (namespace) resourceAttributes.namespace = namespace;
    if (subresource) resourceAttributes.subresource = subresource;

    const review = await this.post(
      "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes } },
      "SelfSubjectAccessReview"
    );

    return isObject(review.status) && review.status.allowed === true;
  }
}

export function createK8sClient(kubeconfigText: string, makeTransport: K8sTransportFactory = httpTransport): K8sClient {
  const connection = parseKubeconfig(kubeconfigText);

  return new K8sClient(connection, makeTransport(connection));
}
