import fs from "fs/promises";
import path from "path";

const TEMPLATES = new URL("./templates/", import.meta.url);

const fail = (marker) =>
  `console.error("intentional failure ${marker}");\nprocess.exit(1);\n`;

/**
 * Small controlled projects used by the tests. Each one is a template plus
 * file overrides / package.json edits.
 */
export const FIXTURES = {
  "site-v1": { template: "static-site", files: { VERSION: "v1\n" } },
  "site-v2": { template: "static-site", files: { VERSION: "v2\n" } },
  "site-pnpm": { template: "pnpm-site" },
  "site-yarn": { template: "yarn-site" },
  probe: { template: "probe" },

  "build-fail": {
    template: "static-site",
    files: { "build.js": fail("SF_BUILD_FAIL_MARKER") },
  },

  "test-fail": {
    template: "static-site",
    files: { "test.js": fail("SF_TEST_FAIL_MARKER") },
  },

  "no-tests": {
    template: "static-site",
    files: { VERSION: "no-tests\n" },
    packageJson: (pkg) => {
      delete pkg.scripts.test;
    },
  },

  "no-build": {
    template: "static-site",
    packageJson: (pkg) => {
      delete pkg.scripts.build;
    },
  },

  // Takes long enough to be cancelled while it builds.
  "slow-build": {
    template: "static-site",
    files: {
      VERSION: "slow\n",
      "package.json": JSON.stringify({
        name: "shipflow-fixture-site",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { build: "sleep 40 && node build.js", test: "node test.js" },
        dependencies: { "escape-html": "1.0.3" },
      }, null, 2),
    },
  },

  // Builds an index.html that references an asset the build never writes;
  // tests pass, so the release reaches DEPLOY and fails artifact validation.
  "missing-asset": {
    template: "static-site",
    files: {
      "test.js": 'console.log("tests pass");\n',
      "build.js": [
        'import fs from "fs";',
        'fs.mkdirSync("dist", { recursive: true });',
        'fs.writeFileSync("dist/index.html", \'<script src="/assets/missing.js"></script>\');',
        "",
      ].join("\n"),
    },
  },
};

export async function materializeFixture(name, destination) {
  const fixture = FIXTURES[name];

  if (!fixture) {
    throw new Error(`Unknown fixture ${name}`);
  }

  await fs.cp(new URL(`${fixture.template}/`, TEMPLATES), destination, {
    recursive: true,
  });

  for (const [file, content] of Object.entries(fixture.files || {})) {
    await fs.writeFile(path.join(destination, file), content);
  }

  if (fixture.packageJson) {
    const packageJsonPath = path.join(destination, "package.json");
    const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

    fixture.packageJson(pkg);
    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  return destination;
}
