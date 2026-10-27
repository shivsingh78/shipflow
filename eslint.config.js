import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "cli/dist/**", "ui/**", "node_modules/**", "cli/node_modules/**", "output/**", "artifacts/**", "docs/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.json", "./cli/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Catch variables and JSON are narrowed explicitly; keep `any` out.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // Method references on injected collaborators and Express handlers are
      // plain functions here; async event handlers catch their own errors.
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Tests, e2e helpers and tooling are plain Node JavaScript.
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly", console: "readonly", Buffer: "readonly", URL: "readonly",
        fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly", AbortController: "readonly",
        AbortSignal: "readonly", TextDecoder: "readonly", TextEncoder: "readonly",
        structuredClone: "readonly", URLSearchParams: "readonly", Response: "readonly", Request: "readonly", Headers: "readonly",
      },
    },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }] },
  }
);
