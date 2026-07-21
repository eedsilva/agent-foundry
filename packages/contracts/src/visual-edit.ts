import { z } from 'zod';
import { SandboxSnapshotPathSchema } from './sandbox.js';

export const VisualEditPropertySchema = z.enum([
  'text',
  'color',
  'backgroundColor',
  'borderColor',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'gap',
  'rowGap',
  'columnGap',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'alignContent',
  'gridTemplateColumns',
  'gridTemplateRows',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
]);
export type VisualEditProperty = z.infer<typeof VisualEditPropertySchema>;

export const VisualEditBreakpointSchema = z.enum(['sm', 'md', 'lg', 'xl', '2xl']);
export type VisualEditBreakpoint = z.infer<typeof VisualEditBreakpointSchema>;

export const VisualEditTargetSchema = z
  .object({
    domPath: z.string().min(1),
    file: SandboxSnapshotPathSchema.refine(
      (path) => !path.includes('\\'),
      'Visual edit targets must use workspace-relative POSIX paths',
    ),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    componentName: z.string().min(1).optional(),
  })
  .strict();
export type VisualEditTarget = z.infer<typeof VisualEditTargetSchema>;

const TOKEN_REFERENCE_PATTERN = /^var\(--[a-zA-Z][a-zA-Z0-9-]*\)$/;
const UNSAFE_STYLE_VALUE_PATTERN =
  /[;{}<>]|\/\*|!important|@import|expression\s*\(|url\s*\(|javascript:|[\u0000-\u001F\u007F]/i;

function isSafeStyleValue(value: string, allowEmpty: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return allowEmpty;
  if (trimmed.includes('var(') || trimmed.includes('--')) {
    return TOKEN_REFERENCE_PATTERN.test(trimmed);
  }
  return !UNSAFE_STYLE_VALUE_PATTERN.test(trimmed);
}

export const VisualEditSchema = z
  .object({
    target: VisualEditTargetSchema,
    property: VisualEditPropertySchema,
    oldValue: z.string().max(10_000),
    newValue: z.string().max(10_000),
    breakpoint: VisualEditBreakpointSchema.optional(),
  })
  .strict()
  .superRefine((edit, context) => {
    if (edit.property === 'text') {
      if (/[\u0000\u007F]/.test(edit.oldValue) || /[\u0000\u007F]/.test(edit.newValue)) {
        context.addIssue({ code: 'custom', path: ['newValue'], message: 'Invalid text value' });
      }
      return;
    }
    if (!isSafeStyleValue(edit.oldValue, true)) {
      context.addIssue({ code: 'custom', path: ['oldValue'], message: 'Unsafe CSS value' });
    }
    if (!isSafeStyleValue(edit.newValue, false)) {
      context.addIssue({ code: 'custom', path: ['newValue'], message: 'Unsafe CSS value' });
    }
  });
export type VisualEdit = z.infer<typeof VisualEditSchema>;

export const VisualEditPreviewMessageSchema = z
  .object({ type: z.literal('af:visual-edit:preview'), payload: VisualEditSchema })
  .strict();
export type VisualEditPreviewMessage = z.infer<typeof VisualEditPreviewMessageSchema>;

export const VisualEditClearMessageSchema = z
  .object({ type: z.literal('af:visual-edit:clear') })
  .strict();
export type VisualEditClearMessage = z.infer<typeof VisualEditClearMessageSchema>;
