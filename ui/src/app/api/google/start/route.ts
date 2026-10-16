import { googleLoginRedirect } from "@/server/google-routes";

/** The Connect Google button: sends the person to Google's own page to pick their account and allow it. */
export async function GET(request: Request) {
  return googleLoginRedirect(request);
}
