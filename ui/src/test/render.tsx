import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider } from "@/components/layout/Theme";
import { ToastProvider } from "@/components/ui";

/**
 * Render a page the way the app does (router, theme, toasts, auth) with the
 * in-memory DEMO API client, so page tests never need a server. Only tests use
 * this; the demo client is not reachable from production code paths except the
 * explicit "Explore with sample data" entry.
 */
export function renderPage(element: ReactElement, { route = "/", path = "*" }: { route?: string; path?: string } = {}) {
  sessionStorage.setItem("shipflow.demo", "1");

  return render(
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route path={path} element={element} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
