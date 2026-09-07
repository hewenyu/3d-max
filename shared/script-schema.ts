import { z } from 'zod';

const name = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(160);
export const scriptParseSchema = z
  .object({
    format: z.enum(['fountain', 'json']),
    source: z.string().min(1).max(200000),
  })
  .strict();
export const scriptItemSchema = z
  .object({
    id,
    kind: z.enum(['action', 'dialogue']),
    text: z.string().trim().min(1).max(10000),
    character: name.optional(),
    direction: z.string().max(2000).optional(),
    durationSeconds: z.number().finite().min(0.1).max(600),
    durationEstimated: z.boolean(),
    parallelGroup: id.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.kind === 'dialogue' && !item.character)
      context.addIssue({ code: 'custom', message: 'Dialogue requires a character', path: ['character'] });
  });
export const scriptSceneSchema = z
  .object({
    id,
    heading: name,
    location: z.string().max(300),
    timeOfDay: z.string().max(100),
    characters: z.array(name).max(80),
    items: z.array(scriptItemSchema).max(500),
    durationSeconds: z.number().finite().min(0).max(86400),
  })
  .strict();
export const scriptDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1).max(80),
    message: z.string().max(2000),
    sceneId: id.optional(),
    itemId: id.optional(),
    tokenIndex: z.number().int().min(0).optional(),
  })
  .strict();
export const scriptBreakdownSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.enum(['fountain', 'json']),
    title: name,
    characters: z.array(name).max(500),
    scenes: z.array(scriptSceneSchema).max(100),
    diagnostics: z.array(scriptDiagnosticSchema).max(500),
    estimatedDurationSeconds: z.number().finite().min(0).max(86400),
  })
  .strict();
export const scriptApplySchema = z
  .object({
    breakdown: scriptBreakdownSchema,
    options: z
      .object({
        prefix: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)
          .optional(),
        createCoverage: z.boolean().default(true),
        sceneIds: z.array(id).min(1).max(100).optional(),
      })
      .strict()
      .default({ createCoverage: true }),
  })
  .strict();
export type ScriptParseInput = z.infer<typeof scriptParseSchema>;
export type ScriptItem = z.infer<typeof scriptItemSchema>;
export type ScriptScene = z.infer<typeof scriptSceneSchema>;
export type ScriptDiagnostic = z.infer<typeof scriptDiagnosticSchema>;
export type ScriptBreakdown = z.infer<typeof scriptBreakdownSchema>;
export type ScriptApplyInput = z.infer<typeof scriptApplySchema>;

export function scriptBlocks(scene: ScriptScene) {
  const blocks: { start: number; duration: number; items: ScriptItem[] }[] = [];
  let end = 0;
  for (const item of scene.items) {
    const previous = blocks.at(-1);
    if (item.parallelGroup && previous?.items[0]?.parallelGroup === item.parallelGroup) {
      previous.items.push(item);
      previous.duration = Math.max(previous.duration, item.durationSeconds);
      end = previous.start + previous.duration;
    } else {
      blocks.push({ start: end, duration: item.durationSeconds, items: [item] });
      end += item.durationSeconds;
    }
  }
  return blocks;
}

export function refreshScriptBreakdown(input: ScriptBreakdown): ScriptBreakdown {
  const result = structuredClone(input);
  for (const scene of result.scenes) {
    scene.characters = [
      ...new Set([
        ...scene.characters,
        ...scene.items.flatMap((item) => (item.character ? [item.character] : [])),
      ]),
    ];
    scene.durationSeconds = scriptBlocks(scene).reduce((sum, block) => sum + block.duration, 0);
  }
  result.characters = [
    ...new Set([...result.characters, ...result.scenes.flatMap((scene) => scene.characters)]),
  ];
  result.estimatedDurationSeconds = result.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  return result;
}
