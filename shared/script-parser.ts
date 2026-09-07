import { Fountain } from 'fountain-js';
import { z } from 'zod';
import {
  refreshScriptBreakdown,
  scriptBreakdownSchema,
  scriptParseSchema,
  type ScriptBreakdown,
  type ScriptDiagnostic,
  type ScriptItem,
  type ScriptScene,
} from './script-schema';

const inputDocument = z.object({
  title: z.string().trim().min(1).max(200),
  characters: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1).max(160).optional(),
        heading: z.string().trim().min(1).max(200),
        location: z.string().max(300).optional(),
        timeOfDay: z.string().max(100).optional(),
        characters: z.array(z.string().trim().min(1).max(200)).max(80).default([]),
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(160).optional(),
              kind: z.enum(['action', 'dialogue']),
              text: z.string().trim().min(1).max(10000),
              character: z.string().trim().min(1).max(200).optional(),
              direction: z.string().max(2000).optional(),
              durationSeconds: z.number().finite().min(0.1).max(600).optional(),
              durationEstimated: z.boolean().optional(),
              parallelGroup: z.string().min(1).max(160).optional(),
            }),
          )
          .max(500),
      }),
    )
    .min(1)
    .max(100),
});

function estimatedDuration(text: string, dialogue: boolean) {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const words = (
    text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, ' ').match(/[\p{L}\p{N}]+/gu) ??
    []
  ).length;
  return Math.min(
    600,
    Math.max(
      dialogue ? 1 : 2,
      Math.round((cjk / (dialogue ? 4 : 7) + words / (dialogue ? 2.5 : 3.5) + (dialogue ? 0.6 : 1.5)) * 10) /
        10,
    ),
  );
}
function headingFields(heading: string) {
  const parts = heading.split(/\s+[-–—]\s+/u);
  const timeOfDay = parts.length > 1 ? parts.pop()! : '';
  return {
    location: parts
      .join(' - ')
      .replace(/^(?:INT\.?\/EXT\.?|INT\.?|EXT\.?|I\/E\.?)\s*/i, '')
      .trim(),
    timeOfDay,
  };
}

export function parseScript(raw: unknown): ScriptBreakdown {
  const input = scriptParseSchema.parse(raw);
  const result: ScriptBreakdown = {
    schemaVersion: 1,
    format: input.format,
    title: '未命名剧本',
    characters: [],
    scenes: [],
    diagnostics: [],
    estimatedDurationSeconds: 0,
  };
  const warn = (diagnostic: ScriptDiagnostic) => {
    if (result.diagnostics.length < 499) result.diagnostics.push(diagnostic);
  };
  if (input.format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.source);
    } catch {
      warn({ severity: 'error', code: 'JSON_SYNTAX', message: 'JSON 语法无效。' });
      return result;
    }
    const document = inputDocument.safeParse(parsed);
    if (!document.success) {
      for (const issue of document.error.issues)
        warn({
          severity: 'error',
          code: 'JSON_SCHEMA',
          message: `${issue.path.join('.')}: ${issue.message}`,
        });
      return result;
    }
    result.title = document.data.title;
    result.characters = document.data.characters;
    result.scenes = document.data.scenes.map((scene, index) => ({
      id: scene.id ?? `scene-${index + 1}`,
      heading: scene.heading,
      ...headingFields(scene.heading),
      ...(scene.location !== undefined ? { location: scene.location } : {}),
      ...(scene.timeOfDay !== undefined ? { timeOfDay: scene.timeOfDay } : {}),
      characters: scene.characters,
      items: scene.items.flatMap((item, itemIndex) => {
        if (item.kind === 'dialogue' && !item.character) {
          warn({
            severity: 'error',
            code: 'MISSING_CHARACTER',
            message: '对白缺少人物名称。',
            sceneId: scene.id ?? `scene-${index + 1}`,
            itemId: item.id ?? `item-${index + 1}-${itemIndex + 1}`,
          });
          return [];
        }
        return [
          {
            ...item,
            id: item.id ?? `item-${index + 1}-${itemIndex + 1}`,
            durationSeconds: item.durationSeconds ?? estimatedDuration(item.text, item.kind === 'dialogue'),
            durationEstimated: item.durationSeconds === undefined ? true : (item.durationEstimated ?? false),
          },
        ];
      }),
      durationSeconds: 0,
    }));
  } else {
    const parser = new Fountain();
    const document = parser.parse(input.source, true);
    let current: ScriptScene | undefined;
    let character: string | undefined;
    let direction = '';
    let parallelGroup: string | undefined;
    for (const [tokenIndex, token] of document.tokens.entries()) {
      const text = token.text?.trim() ?? '';
      if (token.type === 'title' && text) result.title = text.slice(0, 200);
      else if (token.type === 'scene_heading') {
        current = {
          id: `scene-${result.scenes.length + 1}`,
          heading: text.slice(0, 200),
          ...headingFields(text),
          characters: [],
          items: [],
          durationSeconds: 0,
        };
        result.scenes.push(current);
        character = undefined;
      } else if (token.type === 'dual_dialogue_begin') parallelGroup = `parallel-${tokenIndex}`;
      else if (token.type === 'dual_dialogue_end') parallelGroup = undefined;
      else if (token.type === 'character') {
        character = text
          .replace(/\s*\([^)]*\)\s*$/u, '')
          .trim()
          .slice(0, 200);
        direction = text.match(/\([^)]*\)\s*$/u)?.[0] ?? '';
        if (current && character) current.characters.push(character);
      } else if (token.type === 'parenthetical') direction = [direction, text].filter(Boolean).join('\n');
      else if (token.type === 'action' || token.type === 'dialogue') {
        if (!text) continue;
        if (!current) {
          warn({
            severity: 'warning',
            code: 'CONTENT_BEFORE_SCENE',
            message: '首个场景标题前的内容未分配到场次。',
            tokenIndex,
          });
          continue;
        }
        if (token.type === 'dialogue' && !character) {
          warn({
            severity: 'error',
            code: 'MISSING_CHARACTER',
            message: '对白缺少人物提示行。',
            sceneId: current.id,
            tokenIndex,
          });
          continue;
        }
        const item: ScriptItem = {
          id: `item-${tokenIndex}`,
          kind: token.type,
          text,
          durationSeconds: estimatedDuration(text, token.type === 'dialogue'),
          durationEstimated: true,
          ...(token.type === 'dialogue'
            ? { character, ...(direction ? { direction } : {}), ...(parallelGroup ? { parallelGroup } : {}) }
            : {}),
        };
        current.items.push(item);
        direction = '';
      } else if (text && !token.is_title && !['section', 'synopsis', 'note', 'boneyard'].includes(token.type))
        warn({
          severity: 'info',
          code: 'UNMAPPED_TOKEN',
          message: `未自动编排的 Fountain 元素：${token.type}。${text.slice(0, 160)}`,
          tokenIndex,
          ...(current ? { sceneId: current.id } : {}),
        });
    }
  }
  if (!result.scenes.length)
    warn({
      severity: 'error',
      code: 'NO_SCENES',
      message: '未识别场次。Fountain 使用 INT./EXT. 或以点开头的强制场景标题；中文人物使用 @ 人物提示行。',
    });
  const ids = new Set<string>();
  for (const scene of result.scenes) {
    if (ids.has(scene.id))
      warn({
        severity: 'error',
        code: 'DUPLICATE_SCENE_ID',
        message: `场次 ID 重复：${scene.id}`,
        sceneId: scene.id,
      });
    ids.add(scene.id);
    if (!scene.items.length)
      warn({
        severity: 'warning',
        code: 'EMPTY_SCENE',
        message: '场次没有可编排的动作或对白，应用时不会创建空镜头。',
        sceneId: scene.id,
      });
    const itemIds = new Set<string>();
    for (const item of scene.items) {
      if (itemIds.has(item.id))
        warn({
          severity: 'error',
          code: 'DUPLICATE_ITEM_ID',
          message: `场次内条目 ID 重复：${item.id}`,
          sceneId: scene.id,
        });
      itemIds.add(item.id);
    }
  }
  if (result.scenes.some((scene) => scene.items.some((item) => item.durationEstimated)))
    warn({
      severity: 'warning',
      code: 'ESTIMATED_TIMING',
      message: '对白时长按字数和词数估计，动作时长仅作占位；可以在应用前逐条调整。',
    });
  warn({
    severity: 'info',
    code: 'BLOCKING_REQUIRED',
    message: '动作保留为剧情节拍。人物初始站位和覆盖镜头为可编辑占位，未从自然语言推断走位、道具或具体表演。',
  });
  const refreshed = refreshScriptBreakdown(result);
  const validated = scriptBreakdownSchema.safeParse(refreshed);
  if (!validated.success) {
    warn({
      severity: 'error',
      code: 'SCRIPT_LIMIT',
      message: '解析结果超过结构上限（100 场、每场 500 条、单条 10000 字符或总时长 24 小时）。请分段导入。',
    });
    return { ...result, scenes: [], characters: [], estimatedDurationSeconds: 0 };
  }
  return validated.data;
}
