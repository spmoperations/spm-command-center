import { googleCallback } from "@/server/google-routes";

// Swapping Google's code and the first read can take a few seconds.
export const maxDuration = 60;

/** Where Google sends the person back to, with a one-time code or with why it did not connect. */
export async function GET(request: Request) {
  return googleCallback(request);
}
