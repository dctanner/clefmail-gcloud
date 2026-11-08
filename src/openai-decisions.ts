import { z } from "zod";
import type { DecisionPrompt } from "./decision.js";
import { SafeError } from "./errors.js";

export function openaiPrompt(prompt: DecisionPrompt) {
  return {
    model: prompt.model,
    input: [{ role: "user", content: [{ type: "input_json", data: prompt.state }] }],
    questions: Object.entries(prompt.questions).map(([name, question]) => ({
      name, type: question.type, instructions: question.instructions,
      choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
    })),
  };
}

const choice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.array(z.object({ value: z.string(), probability: z.number() })),
});

export function openaiAnswers(raw: unknown) {
  const envelope = z.object({ model: z.string(), answers: z.tuple([z.object({
    name: z.literal("route"), type: z.string(),
  }).passthrough()]) }).safeParse(raw);
  if (!envelope.success) throw new SafeError("invalid_openai_answers");
  const answer = envelope.data.answers[0];
  if (answer.type === "refusal") throw new SafeError("classifier_refused");
  const parsed = choice.safeParse(answer);
  if (!parsed.success || new Set(parsed.data.probabilities.map(p => p.value)).size !== parsed.data.probabilities.length)
    throw new SafeError("invalid_route_answer");
  const { probabilities, ...rest } = parsed.data;
  return { model: envelope.data.model, answers: { route: {
    ...rest, probabilities: Object.fromEntries(probabilities.map(p => [p.value, p.probability])),
  } } };
}
