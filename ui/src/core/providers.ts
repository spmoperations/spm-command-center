// The services a person connects from the Connections tab, and the checks run on what they
// type before anything is sent. Plain logic, no network.
import type { Provider } from "./types";

export const PROVIDERS: Provider[] = ["slack", "telegram", "fathom"];
/** The ones that can be connected on this server. Telegram only where the server says it can be used. */
export const liveProviders = (telegram: boolean): Provider[] => (telegram ? ["slack", "telegram", "fathom"] : ["slack", "fathom"]);

export const PROVIDER_NAME: Record<Provider, string> = { slack: "Slack", telegram: "Telegram", fathom: "Fathom" };

export const PROVIDER_ABOUT: Record<Provider, string> = {
  slack: "Reads your messages and sends your replies from your own account.",
  telegram: "Reads your one-to-one chats and the group messages addressed to you, and sends your replies from your own account.",
  fathom: "Brings in your recorded calls with notes, transcript and action items.",
};

/**
 * What the Slack app may do on the person's behalf. These are user scopes: the token they
 * produce starts with xoxp- and acts as the person. Added as bot scopes they would produce
 * an xoxb- bot token instead, which cannot read the person's own messages.
 */
export const SLACK_USER_SCOPES = [
  "channels:history", "groups:history", "im:history", "mpim:history",
  "channels:read", "groups:read", "im:read", "mpim:read",
  "users:read", "users:read.email", "chat:write", "im:write", "search:read",
  // To show the pictures people send. Slack gives a picture only to an app that may read files.
  "files:read",
];

/** The Slack app Jeremy creates in SPM's workspace. User scopes only: there is no bot. */
export const SLACK_MANIFEST = `display_information:
  name: SPM Command Center
  description: Reads Slack for the SPM Command Center dashboard and sends replies as the person who connects it.
oauth_config:
  scopes:
    user:
${SLACK_USER_SCOPES.map((scope) => `      - ${scope}`).join("\n")}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

/** Opens Slack's "create an app" screen with the manifest filled in. */
export const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_MANIFEST)}`;

export const FATHOM_API_ACCESS_URL = "https://fathom.video/customize#api-access-header";

/** Each check returns a message for the person, or null when the value looks right. */
export function checkSlackToken(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste the token from Slack.";
  if (v.startsWith("xoxb-")) return "That is the bot token (xoxb-). We need the User OAuth Token from the same page, which starts with xoxp-. If Slack shows no user token, the app was not created with the button in step 1.";
  if (!v.startsWith("xoxp-")) return "A Slack user token starts with xoxp-.";
  if (/\s/.test(v) || v.length < 20) return "That token looks cut off. Copy the whole thing.";
  return null;
}

export function checkFathomKey(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Paste the API key from Fathom.";
  if (/\s/.test(v) || v.length < 12) return "That key looks cut off. Copy the whole thing.";
  return null;
}

/** Digits of a phone number in international form, or null if it is not one. */
export function normalizePhone(raw: string): string | null {
  const v = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}

export const checkPhone = (raw: string): string | null =>
  normalizePhone(raw) ? null : "Type the number with its country code, for example +44 7700 900123.";

export const checkTelegramCode = (raw: string): string | null =>
  /^\d{5,6}$/.test(raw.trim()) ? null : "The code from Telegram is 5 or 6 digits.";

/** "+447700900123" becomes "+44 •••• 0123": enough to recognise, not enough to copy. */
export function maskPhone(raw: string): string {
  const v = normalizePhone(raw);
  if (!v) return "";
  return `${v.slice(0, 3)} •••• ${v.slice(-4)}`;
}
