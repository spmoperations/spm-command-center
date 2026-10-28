import { ready } from "@/server/boot";
import { googleCallback } from "@/server/google-routes";
import { googleSignInCallback, isGoogleSignIn } from "@/server/google-sign-in";

// Swapping Google's code and the first read can take a few seconds.
export const maxDuration = 60;

/**
 * Where Google sends the person back to, with a one-time code or with why it did not connect.
 * The same way back serves Sign in with Google, so Google Cloud needs no second address.
 */
export async function GET(request: Request) {
  if (isGoogleSignIn(request)) return googleSignInCallback(request, await ready());
  return googleCallback(request);
}
