import { slackCallback } from "@/server/slack-login";

// Swapping Slack's code and checking the token take a few seconds.
export const maxDuration = 60;

/** Where Slack sends the person back to, with a one-time code or with why it did not connect. */
export async function GET(request: Request) {
  return slackCallback(request);
}
