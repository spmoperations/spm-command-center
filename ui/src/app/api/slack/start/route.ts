import { slackLoginRedirect } from "@/server/slack-login";

/** The Connect Slack button: sends the person to Slack's own page to allow the team's Slack app. */
export async function GET(request: Request) {
  return slackLoginRedirect(request);
}
