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
  const envelope = z.object({ model: z.string(), answers: z.array(z.object({
    name: z.enum(["label", "action"]), type: z.string(),
  }).passthrough()).length(2) }).safeParse(raw);
  if (!envelope.success || new Set(envelope.data.answers.map(a => a.name)).size !== 2)
    throw new SafeError("invalid_openai_answers");
  const answers = Object.fromEntries(envelope.data.answers.map(answer => {
    if (answer.type === "refusal") throw new SafeError("classifier_refused");
    const parsed = choice.safeParse(answer);
    if (!parsed.success || new Set(parsed.data.probabilities.map(p => p.value)).size !== parsed.data.probabilities.length)
      throw new SafeError(`invalid_${answer.name}_answer`);
    const { probabilities, ...rest } = parsed.data;
    return [answer.name, { ...rest, probabilities: Object.fromEntries(probabilities.map(p => [p.value, p.probability])) }];
  }));
  return { model: envelope.data.model, answers };
}
