import { NextResponse } from "next/server";
import { decryptCredentials } from "@/server/integrations/credentials";
import { findIntegrationByExternalAccount } from "@/server/integrations/service";
import { SlackClient } from "@/server/integrations/slack/client";
import { route } from "@/server/http/handler";
import { createLogger } from "@/server/logging/logger";
import { ask } from "@/server/retrieval/ask";
import { formatSlackAnswer, verifySlackSignature } from "@/server/slack/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/contextbridge <question>` from Slack.
 *
 * Slack gives a slash command three seconds before it shows the user a
 * timeout error, and a retrieval-plus-generation round trip does not fit in
 * three seconds. So this acknowledges immediately and posts the real answer
 * to the `response_url` when it is ready.
 */
export const POST = route("slack.command", async (request, context) => {
  // The signature is computed over the raw body, so read text before parsing.
  const rawBody = await request.text();
  verifySlackSignature(
    rawBody,
    request.headers.get("x-slack-signature"),
    request.headers.get("x-slack-request-timestamp"),
  );

  const form = new URLSearchParams(rawBody);
  const teamId = form.get("team_id") ?? "";
  const question = (form.get("text") ?? "").trim();
  const responseUrl = form.get("response_url");
  const userName = form.get("user_name") ?? "someone";

  if (question.length < 3) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "Ask me something about your company's documentation, for example: `/contextbridge what is the expense limit for travel?`",
    });
  }

  // The Slack team id is what maps an inbound command to a tenant.
  const integration = await findIntegrationByExternalAccount("slack", teamId);
  if (!integration) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "This Slack workspace is not connected to a ContextBridge organization yet.",
    });
  }

  const log = createLogger({
    requestId: context.requestId,
    organizationId: integration.organizationId,
    surface: "slack",
  });

  // Answer out of band; Slack only waits three seconds for this handler.
  void (async () => {
    try {
      const result = await ask(
        { question },
        { organizationId: integration.organizationId, surface: "slack" },
      );
      const payload = formatSlackAnswer(question, result.answer, result.citations);

      if (responseUrl) {
        await fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ response_type: "in_channel", ...payload }),
        });
      } else {
        // No response_url (rare): fall back to posting into the channel.
        const credentials = decryptCredentials<{ accessToken: string }>(integration.credentials);
        const channel = form.get("channel_id");
        if (channel) {
          await new SlackClient(credentials.accessToken, log).postMessage(channel, payload.text);
        }
      }
    } catch (error) {
      log.error("slack.answer_failed", { error });
      if (responseUrl) {
        await fetch(responseUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: "Something went wrong answering that. Please try again in a moment.",
          }),
        }).catch(() => undefined);
      }
    }
  })();

  return NextResponse.json({
    response_type: "in_channel",
    text: `Looking through your connected sources for ${userName}...`,
  });
});
