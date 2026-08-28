import { redirect } from "next/navigation";
import { getAuthContext } from "@/server/auth/current";

export const dynamic = "force-dynamic";

export default async function IndexPage() {
  redirect((await getAuthContext()) ? "/ask" : "/login");
}
