// The one place the Command Center uses an AI model: checking whether each message the rules
// flagged is a real task (task-check), and finding other tasks in new messages (task-suggest).
// Everything else (priority, labels, who can take a task, call notes) is plain logic.
//
// This file only makes the call. What the model is told is in `src/prompts/`.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DEPTS } from "@/core/config";
import { FIELDS, message, SYSTEM, type TaskSearch } from "@/prompts/task-finder";
import * as check from "@/prompts/task-check";
import { keysForNew, type AnthropicKeys } from "./app-keys";
import type { Db } from "./db";

export type { TaskSearch };
export type TaskCheck = check.TaskCheck;

// Telling a real task from small talk is a judgment, so the most capable current model makes it,
// thinking as much as each request needs. Few messages reach it (about 7 a day), so it costs
// little. Set ANTHROPIC_MODEL to change it.
export const AI_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";

/**
 * How hard the model thinks. Telling a task from a chat line needs some thought, not a lot:
 * medium, which is also this model's own default, written out so it never changes unseen.
 */
const CHECK_EFFORT = "medium" as const;

/** What one request used, in tokens: what the model read, and what it wrote (its thinking included). */
export interface AiUsage {
  input: number;
  output: number;
}

/** List prices in dollars per million tokens, to say roughly what a run cost. */
const PRICE_PER_MILLION: Record<string, AiUsage> = { "claude-opus-5-5": { input: 4, output: 20 } };

/** Roughly what `usage` cost in dollars, or null for a model whose price is not listed here. */
export function roughCost(usage: AiUsage, model = AI_MODEL): number | null {
  const price = PRICE_PER_MILLION[model];
  return price ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : null;
}

/** The model answered without verdicts: it declined, or its answer was cut short. What it used is still paid for. */
export class NoVerdicts extends Error {
  constructor(
    message: string,
    readonly reason: "declined" | "cut_short" | "unreadable",
    readonly usage: AiUsage,
  ) {
    super(message);
  }
}

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
  // Every test uses a pretend model, so a test can never spend money, whatever key is about.
  if (process.env.VITEST) throw new Error("Tests never call the AI: give the job a pretend model.");
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

const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      id: z.string().describe(check.FIELDS.id),
      is_task: z.boolean().describe(check.FIELDS.is_task),
      confidence: z.number().describe(check.FIELDS.confidence),
      title: z.string().describe(check.FIELDS.title),
      summary: z.string().describe(check.FIELDS.summary),
      for_whom: z.string().describe(check.FIELDS.for_whom),
      already_done: z.boolean().describe(check.FIELDS.already_done),
      done_evidence: z.string().describe(check.FIELDS.done_evidence),
    }),
  ),
});

export type Verdict = z.infer<typeof Verdicts>["verdicts"][number];

export interface CheckResult {
  verdicts: Verdict[];
  usage: AiUsage;
}

/**
 * Asks the model whether each flagged message is a real task. Throws the SDK's typed errors, which
 * the job turns into a readable message, and `NoVerdicts` when it answered without any.
 */
export async function checkCandidates(input: check.TaskCheck, keys: AnthropicKeys): Promise<CheckResult> {
  const response = await anthropic(keys).beta.messages.parse({
    model: AI_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: check.SYSTEM,
    messages: [{ role: "user", content: check.message(input) }],
    output_config: { format: betaZodOutputFormat(Verdicts), effort: CHECK_EFFORT },
    // Should the model decline a batch, another model answers it in the same request, so the same
    // messages are not sent again and again.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const usage: AiUsage = {
    input: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0),
    output: response.usage.output_tokens,
  };
  if (response.stop_reason === "refusal") throw new NoVerdicts("The model declined to read these messages.", "declined", usage);
  if (response.stop_reason === "max_tokens") throw new NoVerdicts("The model's answer was cut short.", "cut_short", usage);
  if (!response.parsed_output) throw new NoVerdicts("The model's answer could not be read.", "unreadable", usage);
  return { verdicts: response.parsed_output.verdicts, usage };
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
