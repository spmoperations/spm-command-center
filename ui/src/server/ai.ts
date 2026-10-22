// The one place the Command Center uses an AI model: finding the owner's tasks in new messages.
// Everything else (priority, labels, who can take a task, call notes) is plain logic.
//
// This file only makes the call. What the model is told is in `src/prompts/`.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEPTS } from "@/core/config";
import { FIELDS, message, SYSTEM, type TaskSearch } from "@/prompts/task-finder";
import { keysForNew, type AnthropicKeys } from "./app-keys";
import type { Db } from "./db";

export type { TaskSearch };

// Development default: the cheapest current model. Set ANTHROPIC_MODEL to change it.
export const AI_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

/** The AI key this person's checks use: their own, else the team's, else the server's settings (see app-keys.ts). */
export const aiKeys = async (db: Db, ownerId: string): Promise<AnthropicKeys | null> => (await keysForNew(db, ownerId, "anthropic"))?.keys ?? null;
export const aiConfigured = async (db: Db, ownerId: string) => (await aiKeys(db, ownerId)) !== null;

const FoundTasks = z.object({
  tasks: z.array(
    z.object({
      title: z.string().describe(FIELDS.title),
      source_id: z.string().describe(FIELDS.source_id),
      priority: z.enum(["high", "mid", "low"]),
      due: z.string().describe(FIELDS.due),
      dept: z.enum(DEPTS),
      why: z.string().describe(FIELDS.why),
      delegable: z.boolean().describe(FIELDS.delegable),
    }),
  ),
});

export type FoundTask = z.infer<typeof FoundTasks>["tasks"][number];

const clients = new Map<string, Anthropic>();
function anthropic(keys: AnthropicKeys): Anthropic {
  // A key that is not tied to one workspace must name the workspace on every request.
  const key = `${keys.apiKey}:${keys.workspaceId ?? ""}`;
  let client = clients.get(key);
  if (!client) clients.set(key, (client = new Anthropic({ apiKey: keys.apiKey, defaultHeaders: keys.workspaceId ? { "anthropic-workspace-id": keys.workspaceId } : undefined })));
  return client;
}

/** Asks the model for tasks. Throws the SDK's typed errors; the job turns them into a readable message. */
export async function findTasks(input: TaskSearch, keys: AnthropicKeys): Promise<FoundTask[]> {
  const response = await anthropic(keys).messages.parse({
    model: AI_MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: message(input) }],
    output_config: { format: zodOutputFormat(FoundTasks) },
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to read these conversations.");
  if (!response.parsed_output) throw new Error("The model's answer could not be read.");
  return response.parsed_output.tasks;
}

/** Checks an AI key before it is saved: asking which models it may use costs nothing. */
export async function checkAiKey(keys: AnthropicKeys): Promise<void> {
  try {
    await anthropic(keys).models.list({ limit: 1 });
  } catch (error) {
    throw new Error(error instanceof Anthropic.AuthenticationError ? "Anthropic does not accept that key." : describeAiError(error));
  }
}

/** Turns an SDK error into one line a person can act on. */
export function describeAiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "The AI key was rejected. Check it in the app keys.";
  if (error instanceof Anthropic.PermissionDeniedError) return "The AI key is not allowed to use this model.";
  if (error instanceof Anthropic.RateLimitError) return "The AI service is rate limited right now. It will try again on the next run.";
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach the AI service.";
  if (error instanceof Anthropic.APIError) {
    if (/credit balance/i.test(error.message)) return "The AI account has no credit. Add credit under Plans & Billing, then run this again.";
    return `The AI service answered ${error.status ?? "an error"}: ${error.message.slice(0, 160)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
