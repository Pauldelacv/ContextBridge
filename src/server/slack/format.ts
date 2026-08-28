/**
 * Formats an answer as Slack Block Kit.
 *
 * Citations are rendered as links back to the source document — in Slack the
 * provenance is the difference between an answer someone acts on and one they
 * have to go and verify themselves.
 */
export function formatSlackAnswer(
  question: string,
  answer: string,
  citations: Array<{ sourceNumber: number; title: string; url: string | null; provider: string }>,
): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Q:* ${question}` }],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: answer.slice(0, 2900) },
    },
  ];

  if (citations.length > 0) {
    const sources = citations
      .map((citation) => {
        const label = `${citation.title} (${citation.provider.replace("_", " ")})`;
        return citation.url ? `<${citation.url}|${label}>` : label;
      })
      .join("\n");

    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Sources*\n${sources}` },
    });
  }

  // `text` is the notification fallback and the accessibility text.
  return { text: answer.slice(0, 2900), blocks };
}
