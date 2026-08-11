import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';

export const UiQualityRubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type UiQualityRubricCriterion = z.infer<typeof UiQualityRubricCriterionSchema>;

export const UiQualityRubricSchema = z
  .object({
    version: z.literal('1'),
    criteria: z.array(UiQualityRubricCriterionSchema).min(1),
  })
  .strict();
export type UiQualityRubric = z.infer<typeof UiQualityRubricSchema>;

export const CURRENT_UI_QUALITY_RUBRIC_VERSION = '1' as const;

export const UI_QUALITY_RUBRIC_V1: UiQualityRubric = UiQualityRubricSchema.parse({
  version: '1',
  criteria: [
    {
      id: 'layout-coherence',
      title: 'Layout coherence',
      description:
        'Elements are visually organized with consistent spacing, alignment, and clear visual hierarchy.',
    },
    {
      id: 'navigation',
      title: 'Navigation',
      description:
        'Interactive elements are clearly identifiable and navigation paths are intuitive and discoverable.',
    },
    {
      id: 'empty-loading-error-states',
      title: 'Empty/loading/error states',
      description:
        'Empty states, loading indicators, and error messages are handled gracefully with appropriate feedback.',
    },
    {
      id: 'contrast-readability',
      title: 'Contrast & readability',
      description:
        'Text has sufficient contrast against backgrounds and is legible at normal viewing distances.',
    },
    {
      id: 'responsive-sanity',
      title: 'Responsive sanity',
      description:
        'Layout adapts appropriately to different viewport sizes without broken elements or text overflow.',
    },
  ],
});

/**
 * The shape the UI-quality judge model must emit as its artifact `data`
 * (#475). Deliberately looser than `UiQualityJudgeResultSchema`: the judge
 * supplies only the scores, and the orchestrator adds the rubric version,
 * model identity, and reviewed screenshot references around them.
 */
export const UiQualityJudgeOutputSchema = z
  .object({
    overallScore: z.number(),
    criteria: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            score: z.number(),
            finding: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type UiQualityJudgeOutput = z.infer<typeof UiQualityJudgeOutputSchema>;

export const UI_QUALITY_JUDGE_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/ui-quality-judge-artifact-v1.json',
  ...z.toJSONSchema(AgentArtifactSchema.extend({ data: UiQualityJudgeOutputSchema })),
};
