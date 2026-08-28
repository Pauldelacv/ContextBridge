/**
 * Seeds a demo organization with realistic content across all three sources.
 *
 * This exists so the system can be evaluated without connecting real Notion,
 * Drive and Slack accounts: it goes through the same ingestion pipeline as a
 * real sync, so chunking, embedding and retrieval are all genuinely exercised.
 *
 *   npm run db:seed
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/server/auth/password";
import { closeDb, getDb } from "../src/server/db/client";
import { integrations, memberships, organizations, users } from "../src/server/db/schema";
import type { IntegrationProvider } from "../src/server/db/schema";
import { encryptCredentials } from "../src/server/integrations/credentials";
import { ingestDocument } from "../src/server/ingestion/pipeline";
import type { NormalizedDocument } from "../src/server/ingestion/normalize";
import { logger } from "../src/server/logging/logger";

const DEMO_EMAIL = "demo@contextbridge.dev";
const DEMO_PASSWORD = "contextbridge-demo";

interface SeedDocument extends NormalizedDocument {
  provider: IntegrationProvider;
}

const DOCUMENTS: SeedDocument[] = [
  {
    provider: "notion",
    externalId: "notion-expense-policy",
    title: "Expense Policy",
    url: "https://www.notion.so/demo/expense-policy",
    sourceUpdatedAt: new Date("2026-06-14T09:00:00Z"),
    metadata: { space: "People Ops", owner: "Priya Raman" },
    content: `# Expense Policy

This policy covers what Northwind employees may expense, and how.

## Meals while travelling

Employees travelling for work may expense up to 75 EUR per day for meals. Alcohol is not reimbursable. Receipts are required for any single item above 25 EUR.

## Client entertainment

Client dinners are capped at 120 EUR per attendee. The client's company name must be recorded on the expense so Finance can attribute it correctly.

## Travel booking

Flights and rail must be booked through the travel portal. Economy is the default for journeys under six hours; business class requires director approval, recorded on the booking.

## Home office equipment

Every employee has a 600 EUR home office budget, refreshed every two years. Monitors, chairs and desks are covered. Personal phones are not.

## Submitting a claim

Submit claims in the expenses tool within 30 days of the spend. Claims older than 60 days need a written exception from your manager. Reimbursement lands with the next payroll run after approval.`,
  },
  {
    provider: "notion",
    externalId: "notion-time-off",
    title: "Time Off and Leave",
    url: "https://www.notion.so/demo/time-off",
    sourceUpdatedAt: new Date("2026-07-02T11:30:00Z"),
    metadata: { space: "People Ops", owner: "Priya Raman" },
    content: `# Time Off and Leave

## Paid vacation

Full-time employees receive 25 days of paid vacation per calendar year, accrued monthly. Part-time employees accrue pro rata.

## Carry-over

Up to 5 unused days may be carried into the following year and must be used before 31 March. Days beyond 5 are forfeited.

## Requesting time off

Request leave in the HR tool at least two weeks ahead for anything longer than three days. Your manager approves it; there is no second approval step.

## Sick leave

Sick leave is not deducted from vacation. Tell your manager on the first day. A doctor's note is required from the fourth consecutive day.

## Parental leave

Primary caregivers receive 16 weeks at full pay. Secondary caregivers receive 6 weeks at full pay. Both may be taken in up to three blocks within the first 18 months.`,
  },
  {
    provider: "notion",
    externalId: "notion-oncall",
    title: "On-call and Incident Response",
    url: "https://www.notion.so/demo/oncall",
    sourceUpdatedAt: new Date("2026-08-01T16:45:00Z"),
    metadata: { space: "Engineering", owner: "Marcus Adeyemi" },
    content: `# On-call and Incident Response

## Rotation

The platform team runs a weekly rotation, handing over on Wednesday at 10:00. Secondary on-call covers escalation after 15 minutes without acknowledgement.

## Severity levels

SEV1 means customer-facing downtime or data loss. SEV2 is degraded service with a workaround. SEV3 is internal-only impact.

SEV1 requires an incident channel within 5 minutes and a status page update within 15.

## Rollback

Deployments roll back with the release tool, not by reverting commits. If the post-deploy health check reports ERR_4021, the migration and the release are out of step: roll back the release first, then decide about the migration.

## Postmortems

Every SEV1 and SEV2 gets a written postmortem within five working days. Postmortems are blameless and name systems, not people.`,
  },
  {
    provider: "google_drive",
    externalId: "drive-security",
    title: "Security Handbook",
    url: "https://docs.google.com/document/d/demo-security/view",
    sourceUpdatedAt: new Date("2026-05-20T08:15:00Z"),
    metadata: { mimeType: "application/vnd.google-apps.document", owner: "Lena Fischer" },
    content: `# Security Handbook

## Passwords and MFA

Every company account must use the password manager. Hardware keys are mandatory for anyone with production access; TOTP is acceptable for everyone else.

## Device policy

Laptops are encrypted at rest and enrolled in device management. Report a lost or stolen device to security@northwind.example within one hour.

## Data classification

Public, Internal, Confidential and Restricted. Customer data is Confidential by default; anything containing payment details is Restricted and may not leave the production environment.

## Access reviews

Access to production systems is reviewed quarterly. Access not used in 90 days is revoked automatically.

## Reporting a vulnerability

Report suspected vulnerabilities to security@northwind.example. Do not open a public issue. The team acknowledges within one business day.`,
  },
  {
    provider: "google_drive",
    externalId: "drive-onboarding",
    title: "Engineering Onboarding Checklist",
    url: "https://docs.google.com/document/d/demo-onboarding/view",
    sourceUpdatedAt: new Date("2026-07-28T13:00:00Z"),
    metadata: { mimeType: "application/vnd.google-apps.document", owner: "Marcus Adeyemi" },
    content: `# Engineering Onboarding Checklist

## Day one

Collect your laptop and hardware key from IT. Sign in to the password manager and enrol your key. Join the #engineering and #announcements channels.

## First week

Pair with your onboarding buddy on a starter ticket. Read the on-call and incident response guide. Get access to staging; production access comes after two weeks and requires manager sign-off.

## Local environment

Clone the platform repository and run the bootstrap script. It provisions Postgres, applies migrations and seeds test data. If the bootstrap fails on the migration step, your Docker memory limit is probably too low — 4 GB is the minimum.

## First month

Ship a change to production, shadow one on-call shift, and write or improve one page of documentation.`,
  },
  {
    provider: "slack",
    externalId: "C0ENG:1721030400.000100",
    title: "#engineering: staging database resets",
    url: "https://app.slack.com/archives/C0ENG/p1721030400000100",
    sourceUpdatedAt: new Date("2026-07-15T10:00:00Z"),
    metadata: { channelName: "engineering", messageCount: 4 },
    content: `# #engineering: staging database resets

Marcus Adeyemi (2026-07-15T10:00:00Z): Heads up — staging database resets every Sunday at 02:00 UTC. If you are testing something long-running over a weekend, snapshot it first.

Dana Whitfield (2026-07-15T10:04:00Z): Does that wipe the seeded demo org too?

Marcus Adeyemi (2026-07-15T10:06:00Z): It re-seeds it. Same credentials, fresh ids. Anything you created by hand is gone.

Dana Whitfield (2026-07-15T10:08:00Z): Good to know. I will move my test fixtures into the seed script then.`,
  },
  {
    provider: "slack",
    externalId: "C0SUP:1722500000.000200",
    title: "#support: laptop refresh cycle",
    url: "https://app.slack.com/archives/C0SUP/p1722500000000200",
    sourceUpdatedAt: new Date("2026-08-01T09:20:00Z"),
    metadata: { channelName: "support", messageCount: 3 },
    content: `# #support: laptop refresh cycle

Ines Duarte (2026-08-01T09:20:00Z): How often do we replace laptops? Mine is starting to struggle with builds.

Lena Fischer (2026-08-01T09:26:00Z): The hardware refresh cycle is three years, or sooner if the machine cannot do its job. Build times count as cannot do its job — open an IT ticket and mention the build.

Ines Duarte (2026-08-01T09:31:00Z): Perfect, filing one now. Thanks.`,
  },
];

async function main(): Promise<void> {
  const db = getDb();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1);

  if (existing) {
    logger.info("seed.skipped", { reason: "demo user already exists", email: DEMO_EMAIL });
    await closeDb();
    return;
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: "Northwind Robotics", slug: "northwind-robotics" })
    .returning({ id: organizations.id });

  const [user] = await db
    .insert(users)
    .values({
      name: "Demo User",
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
    })
    .returning({ id: users.id });

  await db
    .insert(memberships)
    .values({ organizationId: organization!.id, userId: user!.id, role: "owner" });

  // One integration row per provider, so seeded documents look exactly like
  // synced ones to the rest of the system.
  const integrationIds = new Map<IntegrationProvider, string>();
  for (const provider of ["notion", "google_drive", "slack"] as const) {
    const [record] = await db
      .insert(integrations)
      .values({
        organizationId: organization!.id,
        provider,
        externalAccountId: `demo-${provider}`,
        displayName: `Demo ${provider.replace("_", " ")}`,
        status: "connected",
        credentials: encryptCredentials({ accessToken: "seed-only-not-a-real-token" }),
        config: provider === "slack" ? { teamId: "demo-slack" } : {},
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: integrations.id });
    integrationIds.set(provider, record!.id);
  }

  for (const document of DOCUMENTS) {
    const { provider, ...normalized } = document;
    const result = await ingestDocument(normalized, {
      organizationId: organization!.id,
      integrationId: integrationIds.get(provider)!,
      provider,
    });
    logger.info("seed.document", {
      title: normalized.title,
      provider,
      chunks: result.chunkCount,
    });
  }

  logger.info("seed.completed", {
    organization: "Northwind Robotics",
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    documents: DOCUMENTS.length,
  });

  await closeDb();
}

main().catch((error: unknown) => {
  logger.error("seed.failed", { error });
  process.exitCode = 1;
});
