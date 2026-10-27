// The web dashboard: a static single-page app (ui/dist) served by the API
// under /ui. Same origin as the API, so it needs no CORS and the API token is
// only ever sent to the server that served the page.
//
// The files are public (they contain no secrets and no data); every API call
// the dashboard makes is authenticated with the bearer token like any other
// client. Responses carry a strict Content-Security-Policy so a page can only
// load its own scripts/styles and only talk to this server.
import fs from "fs";
import path from "path";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

export const DASHBOARD_PATH = "/ui";

export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", DASHBOARD_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

/** The built dashboard directory, or null when it is disabled or has not been built. */
export function resolveDashboardDir(configured: string | null | undefined, disabled: boolean): string | null {
  if (disabled) return null;

  const dir = configured ? path.resolve(configured) : path.resolve(import.meta.dirname, "../../ui/dist");

  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

/**
 * Serve the dashboard under /ui and send browsers that open the API root to it.
 * Must be mounted BEFORE the token middleware: the app shell is public, the API is not.
 */
export function mountDashboard(app: Express, dir: string): void {
  const index = path.join(dir, "index.html");

  // Hashed build assets never change; the HTML shell must always be revalidated.
  const assets = express.static(path.join(dir, "assets"), { index: false, dotfiles: "ignore", immutable: true, maxAge: "1y", fallthrough: true });
  const files = express.static(dir, { index: false, dotfiles: "ignore", maxAge: "10m", fallthrough: true });

  const sendIndex = (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(index);
  };

  // Browsers opening the server root land on the dashboard; API clients are unaffected.
  app.get("/", (req, res, next) => {
    if (req.accepts(["html", "json"]) === "html") {
      res.redirect(302, `${DASHBOARD_PATH}/`);
      return;
    }

    next();
  });

  // Express routes ignore the trailing slash, so only redirect the bare path.
  app.get(DASHBOARD_PATH, (req, res, next) => {
    if (req.path !== DASHBOARD_PATH) {
      next();
      return;
    }

    res.redirect(301, `${DASHBOARD_PATH}/`);
  });

  const router = express.Router();

  router.use(securityHeaders);
  router.use("/assets", assets, (_req, res) => {
    // A missing build asset is a plain 404 (not a thrown error, not the app shell).
    res.status(404).type("text/plain").send("Not found");
  });
  router.use(files);
  // Client-side routes (/ui/applications/...) fall back to the app shell; a missing
  // file with an extension is a real 404, not the shell.
  router.get(/.*/, (req, res, next) => {
    if (path.extname(req.path) !== "") {
      next();
      return;
    }

    sendIndex(req, res);
  });
  router.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use(DASHBOARD_PATH, router);
}
