// A stateful stand-in for a Docker host reached over SSH, for the docker
// target's lifecycle tests. Unlike a command-by-command script, it keeps the
// state that matters (containers, images, the proxy's config file and what
// nginx has actually loaded) so a whole deploy / failed live check / revert
// sequence can be replayed and its outcome asserted: who serves traffic, which
// containers run, which files exist.
//
// It understands exactly the command shapes src/targets/docker.ts issues and
// throws on anything else, so a new command cannot slip through unmodelled.
import { Readable } from "node:stream";

export const HOME = "/home/deploy";
export const digestOf = (releaseId) => `sha256:${releaseId.toLowerCase().replace(/[^a-f0-9]/g, "a").padEnd(64, "0").slice(0, 64)}`;

const quoted = (command) => [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1].replace(/'\\''/g, "'"));
const ok = (output = "") => ({ exitCode: 0, timedOut: false, output });
const no = (output = "", exitCode = 1) => ({ exitCode, timedOut: false, output });

export function createFakeHost({ project = "shop", port = 3000 } = {}) {
  const host = {
    project,
    port,
    commands: [],
    containers: new Map(), // name -> { running, image, release, role }
    images: new Map(), // tag -> digest
    digests: new Set(), // image IDs present on the host
    files: new Map(), // path -> { content, mode }
    loadedConf: null, // what nginx is actually running
    proxyRunning: false,
    release: new Map(), // releaseId -> { candidate: status, live: status }
    failNginxTest: false,
    /** Simulates workers that keep serving the previous config after a reload. */
    proxyIgnoresReload: false,
    failConfRead: false,
    nginxOutput: "nginx: [emerg] unexpected end of file",
    /** Behaviour of a release's app: HTTP status seen inside the Docker network / from outside. */
    behave(releaseId, behaviour) {
      host.release.set(releaseId, { candidate: 200, live: 200, ...behaviour });
    },
    conf: () => host.files.get(`${HOME}/.shipflow/${project}/conf/default.conf`)?.content ?? null,
    /** Release the proxy currently serves traffic for (null = none / 503 / upstream down). */
    serving() {
      const text = host.loadedConf;
      const match = text && /# shipflow-upstream: (\S+):(\d+) release=(\w{8})/.exec(text);

      if (!match) return null;

      const container = host.containers.get(match[1]);

      return container?.running ? match[3] : null;
    },
    running: () => [...host.containers.values()].filter((c) => c.role === "release" && c.running).map((c) => c.release).sort(),
    existing: () => [...host.containers.values()].filter((c) => c.role === "release").map((c) => c.release).sort(),
    ranContainer: (releaseId) => host.commands.some((c) => c.command.startsWith(`'docker' 'run' '-d' '--name' 'shipflow-${project}-${releaseId}'`)),
  };


  function run(command, options) {
    host.commands.push({ command, options });

    if (command.startsWith('printf %s "$HOME"')) return ok(HOME);
    if (command.startsWith("mkdir -p")) return ok();

    if (command.startsWith("test -f ")) {
      const file = quoted(command)[0];
      return host.files.has(file) ? ok() : no();
    }

    if (command.startsWith("cat '")) {
      const file = quoted(command)[0];
      if (host.failConfRead && file.endsWith("default.conf")) return no("cat: read error");
      return host.files.has(file) ? ok(host.files.get(file).content) : no("No such file");
    }

    if (command.startsWith("umask ")) {
      const [temp, , file] = quoted(command);
      const mode = command.startsWith("umask 077") ? "private" : "public";
      // `cat > temp && mv temp file`: the file appears only once complete.
      host.files.set(file, { content: options?.stdin?.text ?? "", mode });
      host.files.delete(temp);
      return ok();
    }

    if (command.startsWith("rm -f ")) {
      for (const file of quoted(command)) host.files.delete(file);
      return ok();
    }

    if (command.startsWith("'docker' 'network' 'inspect'")) return ok();

    if (command.includes("| grep '^shipflow-build/'")) return ok();

    if (command.startsWith("'docker' ")) return docker(quoted(command), command);

    throw new Error(`fake host: unmodelled command: ${command}`);
  }

  function docker(args, raw) {
    const rest = args.slice(1);

    switch (rest[0]) {
      case "version":
        return ok("27.0.0");

      case "load": {
        // Streaming an archive adds the image it carries.
        const file = /image-(\w{8})\.tar/.exec(host.pendingArchive ?? "")?.[1];
        if (file) host.digests.add(digestOf(file));
        return ok(`Loaded image ID: ${file ? digestOf(file) : "?"}`);
      }

      case "image": {
        // image inspect --format {{.Id}} <tag|digest>
        const ref = rest.at(-1);
        const digest = host.images.get(ref) ?? (host.digests.has(ref) ? ref : null);
        return digest ? ok(digest) : no(`Error: No such image: ${ref}`);
      }

      case "tag":
        host.images.set(rest[2], rest[1]);
        return ok();

      case "rmi":
        host.images.delete(rest[1]);
        return ok();

      case "run": {
        const name = rest[rest.indexOf("--name") + 1];
        const tag = rest.at(-1);
        const published = rest.includes("-p");

        if (host.containers.has(name)) return no(`Conflict. The container name "${name}" is already in use`, 125);

        if (published) {
          host.proxyRunning = true;
          host.containers.set(name, { running: true, image: null, release: null, role: "proxy" });
          return ok("proxyid");
        }

        const releaseId = /shipflow\.release=(\w{8})/.exec(rest.join(" "))?.[1] ?? "";
        const image = host.images.get(tag);

        if (!image) return no("Unable to find image locally", 125);

        host.containers.set(name, { running: true, image, release: releaseId, role: "release" });
        return ok("containerid");
      }

      case "start": {
        const c = host.containers.get(rest[1]);
        if (!c) return no(`Error: No such container: ${rest[1]}`);
        c.running = true;
        return ok(rest[1]);
      }

      case "stop": {
        const c = host.containers.get(rest.at(-1));
        if (!c) return no("No such container");
        c.running = false;
        return ok();
      }

      case "rm": {
        const name = rest.at(-1);
        host.containers.delete(name);
        return ok();
      }

      case "logs":
        return ok("listening on 3000");

      case "inspect": {
        const format = rest[2];
        const name = rest[3];
        const c = host.containers.get(name);

        if (!c) return no(`Error: No such container: ${name}`);
        if (format === "{{.State.Running}}") return ok(String(c.running));
        if (format.startsWith("{{.Image}}")) return ok(`${c.image}|${c.running}|false|0`);
        throw new Error(`fake host: unmodelled inspect format ${format}`);
      }

      case "ps": {
        const all = rest.includes("-a");
        const format = rest[rest.indexOf("--format") + 1];
        const rows = [...host.containers.entries()]
          .filter(([, c]) => c.role === "release" && (all || c.running))
          .reverse()
          .map(([name, c]) => (format.includes("shipflow.release") ? `${name}|${c.release}` : name));
        return ok(rows.join("\n"));
      }

      case "exec": {
        const target = rest[1];

        if (rest[2] === "nginx") {
          if (rest[3] === "-t") {
            if (host.failNginxTest) return no(host.nginxOutput);
            return host.conf()?.includes("shipflow-upstream") ? ok("syntax is ok") : no("no config");
          }

          if (rest[3] === "-s" && rest[4] === "reload") {
            if (!host.proxyIgnoresReload) host.loadedConf = host.conf();
            return ok();
          }
        }

        if (rest[2] === "wget") {
          const url = rest.at(-1).replace(/ 2>&1$/, "");

          // The handshake: answers only on the token path of the config nginx is RUNNING.
          const handshake = /127\.0\.0\.1\/__shipflow_([a-f0-9]{16})$/.exec(url);

          if (handshake) {
            const running = host.loadedConf ?? "";
            const token = /# shipflow-handshake: ([a-f0-9]{16})/.exec(running)?.[1];
            const marker = /# shipflow-upstream: (?:none|\S+:\d+ release=(\w{8}))/.exec(running);

            return token === handshake[1] && marker ? ok(marker[1] ?? "none") : no("wget: server returned error: HTTP/1.1 404 Not Found");
          }

          const name = /^http:\/\/([^:/]+):/.exec(url)?.[1];
          const container = host.containers.get(name);
          const release = container?.release;
          const status = release ? (host.release.get(release)?.candidate ?? 200) : null;

          if (!container?.running || status === null) return no("wget: can't connect to remote host");

          return ok(`  HTTP/1.1 ${status} X`);
        }

        throw new Error(`fake host: unmodelled exec ${rest.slice(1, 4).join(" ")} on ${target}`);
      }

      default:
        throw new Error(`fake host: unmodelled docker command: ${raw}`);
    }
  }

  const deps = {
    openRemote: async () => ({
      exec: async (command, options) => {
        if (command.includes("'load'") && options?.stdin && "file" in options.stdin) host.pendingArchive = options.stdin.file;
        return run(command, options);
      },
      close: async () => undefined,
    }),
    /** The public URL: served through the proxy, so it follows what nginx has loaded. */
    httpGet: async () => {
      const served = host.serving();
      const status = served ? (host.release.get(served)?.live ?? 200) : 503;
      return { status, headers: {}, body: Buffer.alloc(0) };
    },
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 20_000); })(),
  };

  return { host, deps };
}

/** A release context for the docker target, with the image archive named after the release. */
export function releaseContext(host, releaseId, { secrets = {}, logs = [], runtimeSecrets = [], overrides = {} } = {}) {
  return {
    project: host.project,
    releaseId,
    targetConfig: {
      host: "docker.example.com", port: 22, user: "deploy", hostKey: "ssh-ed25519 AAAAC3",
      privateKeySecret: "DOCKER_KEY", publishPort: 8080, url: "http://docker.example.com:8080",
    },
    verification: { path: "/health", expectStatus: 200 },
    secrets: { DOCKER_KEY: "-----BEGIN KEY-----\nkeymaterial\n-----END KEY-----", ...secrets },
    artifact: { type: "image", key: `releases/${releaseId}/image/image.tar`, digest: digestOf(releaseId), sizeBytes: 10, port: host.port },
    runtime: { port: host.port, env: {}, secrets: runtimeSecrets },
    ensureArtifactDir: async () => "/unused",
    ensureImageArchive: async () => `/tmp/image-${releaseId}.tar`,
    log: (message) => logs.push(message),
    ...overrides,
  };
}

/** A fake artifact store whose objects are small tar-like blobs (used when a revert must reload an image). */
export function fakeStore() {
  return {
    kind: "local",
    describe: () => "fake",
    put: async () => undefined,
    list: async () => [],
    get: async () => ({ Body: Readable.from([Buffer.from("tar")]) }),
    remove: async () => undefined,
    isNotFound: () => false,
  };
}
