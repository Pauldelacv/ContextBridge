import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getAuthContext } from "@/server/auth/current";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getAuthContext()) redirect("/ask");

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="stack">
          <div>
            <h1>Sign in to ContextBridge</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Ask questions across everything your company knows.
            </p>
          </div>

          <AuthForm
            endpoint="/api/auth/login"
            submitLabel="Sign in"
            fields={[
              { name: "email", label: "Work email", type: "email", autoComplete: "email" },
              {
                name: "password",
                label: "Password",
                type: "password",
                autoComplete: "current-password",
              },
            ]}
          />

          <p className="subtle">
            No account yet? <Link href="/signup">Create an organization</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
