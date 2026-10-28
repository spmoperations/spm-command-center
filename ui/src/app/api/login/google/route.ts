import { ready } from "@/server/boot";
import { googleSignInRedirect } from "@/server/google-sign-in";

/** The login page's Sign in with Google button: sends the person to Google's own page to pick their account. */
export async function GET(request: Request) {
  return googleSignInRedirect(request, await ready());
}
