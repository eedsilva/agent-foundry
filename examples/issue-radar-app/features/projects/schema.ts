import { z } from 'zod';

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, 'Project name is required.')
  .max(140, 'Project name must be 140 characters or fewer.');
