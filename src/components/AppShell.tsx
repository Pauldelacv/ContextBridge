import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/LogoutButton";

const NAV = [
  { href: "/ask", label: "Ask" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/sources", label: "Sources" },
  { href: "/documents", label: "Documents" },
] as const;

/** Server component: the shell renders from the session, no client state. */
export function AppShell({
  current,
  organizationName,
  userName,
  children,
}: {
  current: string;
  organizationName: string;
  userName: string;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            CB
          </span>
          <span className="brand-name">ContextBridge</span>
        </div>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              aria-current={current === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div style={{ padding: "0 8px 10px" }}>
            <div style={{ fontWeight: 550, fontSize: "0.88rem" }}>{organizationName}</div>
            <div className="subtle">{userName}</div>
          </div>
          <LogoutButton />
        </div>
      </aside>

      <main className="main">
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
