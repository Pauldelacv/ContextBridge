import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getAuthContext } from "@/server/auth/current";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
  if (await getAuthContext()) redirect("/ask");

  return (
    <div className="auth-shell">
      <div className="auth-card card">
        <div className="stack">
          <div>
            <h1>Create your organization</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              Your organization is the boundary around your data — every document,
              source and answer belongs to it.
            </p>
          </div>

          <AuthForm
            endpoint="/api/auth/signup"
            submitLabel="Create organization"
            fields={[
              {
                name: "organizationName",
                label: "Organization name",
                autoComplete: "organization",
                placeholder: "Acme Inc",
              },
              { name: "name", label: "Your name", autoComplete: "name" },
              { name: "email", label: "Work email", type: "email", autoComplete: "email" },
              {
                name: "password",
                label: "Password",
                type: "password",
                autoComplete: "new-password",
                placeholder: "At least 10 characters",
              },
            ]}
          />

          <p className="subtle">
            Already have an account? <Link href="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
