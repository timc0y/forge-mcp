import type {
  Claim,
  ContextPack,
  DataClassification,
  InferencePolicy,
  Observation,
  Source,
  SubjectRef,
  WorkspaceRef,
} from '@timcoy/context-core';
import { evaluateInferenceRequest, validateContextPack } from '@timcoy/context-core';

export const FORGE_PRODUCT_ID = 'forge';

export interface ForgeInferenceEnvironment {
  FORGE_INFERENCE_POLICY?: string | null;
  FORGE_APPROVED_CLOUD_PROVIDERS?: string | null;
}

function providerList(value: string | null | undefined): string[] {
  return (value ?? '').split(',').map((provider) => provider.trim()).filter(Boolean);
}

/**
 * Forge currently uses its configured Workers AI binding. Other cloud
 * providers must be named deliberately; there is no URL-derived fallback.
 */
export function resolveForgeInferencePolicy(env: ForgeInferenceEnvironment): InferencePolicy {
  const requestedMode = env.FORGE_INFERENCE_POLICY?.trim();
  const approvedCloudProviders = providerList(env.FORGE_APPROVED_CLOUD_PROVIDERS);
  const mode = requestedMode === 'local_only' || requestedMode === 'redacted_cloud' || requestedMode === 'approved_cloud'
    ? requestedMode
    : 'approved_cloud';
  return {
    mode,
    scope: { kind: 'product', productId: FORGE_PRODUCT_ID },
    approvedCloudProviders: approvedCloudProviders.length ? approvedCloudProviders : ['cloudflare-workers-ai'],
    cloudClassifications: mode === 'local_only'
      ? []
      : mode === 'redacted_cloud'
        ? ['public', 'private', 'sensitive']
        : ['public', 'private'],
  };
}

export function assertForgeWorkersAiAllowed(input: {
  env: ForgeInferenceEnvironment;
  tenantId: string;
  projectId: string;
  purpose: string;
  classification: DataClassification;
}): void {
  const decision = evaluateInferenceRequest({
    workspace: { productId: FORGE_PRODUCT_ID, id: `${input.tenantId}:${input.projectId}` },
    purpose: input.purpose,
    classification: input.classification,
    providerId: 'cloudflare-workers-ai',
    providerKind: 'cloud',
  }, resolveForgeInferencePolicy(input.env));
  if (!decision.allowed) {
    throw new Error(`Inference policy denied cloudflare-workers-ai: ${decision.reason}`);
  }
}

/**
 * Forge workspaces are ephemeral checkouts. Context Core therefore scopes the
 * private data boundary to tenant + project and treats the checkout as a
 * subject inside it.
 */
export interface ForgeContextScope {
  workspaceId: string;
  tenantId: string;
  projectId: string;
  repository: { owner: string; name: string };
}

export function forgeContextWorkspace(scope: ForgeContextScope): WorkspaceRef {
  return {
    productId: FORGE_PRODUCT_ID,
    id: `${scope.tenantId}:${scope.projectId}`,
    label: `${scope.repository.owner}/${scope.repository.name}`,
  };
}

export interface ForgeContextPackInput {
  scope: ForgeContextScope;
  subject: SubjectRef;
  createdAt: string;
  sources: Source[];
  observations?: Observation[];
  claims?: Claim[];
}

/**
 * Adapts Forge review/deployment evidence to the product-neutral contract.
 * Callers pass opaque locators or artifacts; repository file contents remain
 * in Forge's authorised repository plane rather than this portable snapshot.
 */
export function createForgeContextPack(input: ForgeContextPackInput): ContextPack {
  const result = validateContextPack({
    schemaVersion: 1,
    id: `forge:${input.scope.workspaceId}:${input.subject.kind}:${input.subject.id}`,
    workspace: forgeContextWorkspace(input.scope),
    subject: input.subject,
    createdAt: input.createdAt,
    sources: input.sources,
    observations: input.observations ?? [],
    claims: input.claims ?? [],
    decisions: [],
    actions: [],
    training: { disposition: 'excluded' },
  });
  if (!result.ok) {
    throw new Error(`Forge context pack failed validation: ${result.issues.map(({ path }) => path).join(', ')}`);
  }
  return result.value;
}
