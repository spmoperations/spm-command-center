// The one place the Command Center uses an AI model: finding the owner's tasks in new messages.
// Everything else (priority, labels, who can take a task, call notes) is plain logic.
//
// This file only makes the call. What the model is told is in `src/prompts/`.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEPTS } from "@/core/config";
import { FIELDS, message, SYSTEM, type TaskSearch } from "@/prompts/task-finder";

export type { TaskSearch };

// Development default: the cheapest current model. Set ANTHROPIC_MODEL to change it.
export const AI_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

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

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // A key that is not tied to one workspace must name the workspace on every request.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  return (client ??= new Anthropic({ defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined }));
}

/** Asks the model for tasks. Throws the SDK's typed errors; the job turns them into a readable message. */
export async function findTasks(input: TaskSearch): Promise<FoundTask[]> {
  const response = await anthropic().messages.parse({
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

/** Turns an SDK error into one line a person can act on. */
export function describeAiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "The AI key was rejected. Check ANTHROPIC_API_KEY.";
  if (error instanceof Anthropic.PermissionDeniedError) return "The AI key is not allowed to use this model.";
  if (error instanceof Anthropic.RateLimitError) return "The AI service is rate limited right now. It will try again on the next run.";
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach the AI service.";
  if (error instanceof Anthropic.APIError) {
    if (/credit balance/i.test(error.message)) return "The AI account has no credit. Add credit under Plans & Billing, then run this again.";
    return `The AI service answered ${error.status ?? "an error"}: ${error.message.slice(0, 160)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
