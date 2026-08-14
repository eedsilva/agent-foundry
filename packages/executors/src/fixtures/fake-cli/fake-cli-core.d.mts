export interface FakeCliIdentity {
  stepId: string;
  role: string;
  taskKind: string;
  mutationAllowed: boolean;
  outputSchemaId?: string | undefined;
}
export function resolveRequest(prompt: string): Promise<FakeCliIdentity>;
export function mutateWorkspace(cwd: string, stepId: string, label?: string): Promise<void>;
export function buildArtifact(
  identity: Pick<FakeCliIdentity, 'stepId' | 'role' | 'taskKind'> & {
    outputSchemaId?: string | undefined;
  },
  options?: { label?: string; t2AcceptanceMode?: string; uiQualityScore?: number },
): unknown;
export function respond(
  prompt: string,
  options?: { outputSchemaJson?: string | undefined },
): Promise<unknown>;
export function readStdin(): Promise<string>;
export function argValue(argv: string[], flag: string): string | undefined;
