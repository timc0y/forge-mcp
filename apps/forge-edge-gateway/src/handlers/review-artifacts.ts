import { ForgeError, ids, type TenantId } from '@forge/core';
import { forgeToolResponse, type ForgeToolHandlers } from '@forge/mcp-core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { selectBrowserProvider } from '../browser-router';
import { assertPublicHost } from '@forge/policy';
import { normalizeViewports, prepareInlineImages } from '../review-images';
import { resolveWorkspaceId } from '../workspace-resolve';
import { storeGallery } from '../review-gallery';
import type { Env } from '../env';
import { isTextualArtifact } from '../artifact-content';
import { workspaceOperations } from '../workspace-operations';
import {
  recordUrlReviewOwner, lookupWorkspaceOwner, withDeadline, lookupUrlReviewOwner,
  summarizeStructure, mapWithConcurrency, MAX_GALLERY_IMAGES, REVIEW_CAPTURE_CONCURRENCY,
  findingCountOf, base64, text, number, workspaceAddress
} from './helpers';
import type { ReviewArtifactHandlerDependencies } from './types';

type WorkflowTool = 'forge_review' | 'forge_artifact_get' | 'forge_artifact_upload';

/** Focused reviewArtifact workflows behind the ForgeToolHandlers seam. */
export function reviewArtifactToolHandlers(env: Env, deps: ReviewArtifactHandlerDependencies): Pick<ForgeToolHandlers, WorkflowTool> {
  return {
      forge_review: async (input) => {
        const identity = deps.identity();
        // SSRF guard: the caller-supplied URL is fetched by the browser provider,
        // so reject private, loopback, link-local and metadata hosts BEFORE any
        // capture is attempted. assertPublicHost throws a ForgeError for blocked
        // targets (127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.x incl. the cloud
        // metadata IP, ::1, fc/fd/fe80, localhost, *.local).
        // URL.hostname wraps IPv6 literals in brackets ("[::1]"); strip them so
        // the policy's bare-address rules (::1, fc.., fd.., fe80:) still match.
        assertPublicHost(new URL(text(input.url)).hostname.replace(/^\[|\]$/g, ''));
        const workspaceId = ids.workspace();
        // Bind this url_review workspace to its owner so forge_artifact_get can
        // authorize by ownership, not R2 key shape (best-effort; see helper).
        await recordUrlReviewOwner(env, workspaceId, identity.tenantId, identity.projectId);
        const artifacts = new R2ArtifactStore(env.ARTIFACTS);
        // Arbitrary-URL review always renders on Cloudflare, never the mini (SSRF guard).
        const browser = await selectBrowserProvider(env, artifacts, identity.tenantId as TenantId, false);
        const captures = input.captures as Array<{ selection?: string; path: string; state: string }>;
        const viewports = normalizeViewports(input.viewports);
        const evidence: Array<Record<string, unknown>> = [];
        const failures: Array<Record<string, unknown>> = [];
        const skipped: Array<Record<string, unknown>> = [];
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
        // Each (capture × viewport) cell is captured independently so one slow
        // or failing route cannot discard evidence that already succeeded. Cells
        // run with bounded concurrency (Browser Run calls are seconds long) and
        // share a soft deadline so a slow route is skipped rather than lost — the
        // per-cell provider retry is deadline-aware so it stops in step.
        // Bounded by the caller's budget rather than a fixed 110s. A chat client
        // abandons a slow tool call and leaves the user with nothing at all, so
        // the default is short and we return whatever succeeded inside it;
        // callers that can genuinely wait raise time_budget_ms.
        const startedAt = Date.now();
        const deadlineAt = startedAt + number(input.time_budget_ms);
        const cells = captures.flatMap((capture) => viewports.map((viewport) => ({ capture, viewport })));
        type CellOutcome =
          | { kind: 'evidence'; value: Record<string, unknown>; inline?: { base64: string; contentType: string } }
          | { kind: 'failure'; value: Record<string, unknown> }
          | { kind: 'skipped'; value: Record<string, unknown> };
        const outcomes = await mapWithConcurrency<{ capture: typeof captures[number]; viewport: typeof viewports[number] }, CellOutcome>(
          cells,
          REVIEW_CAPTURE_CONCURRENCY,
          async ({ capture, viewport }) => {
            if (Date.now() >= deadlineAt) {
              return { kind: 'skipped', value: { route: capture.path, environment: viewport.id, reason: 'capture_deadline_reached' } };
            }
            try {
              const result = await browser.captureEvidence({
                workspaceId,
                url: text(input.url),
                path: capture.path,
                viewport: { width: viewport.width, height: viewport.height },
                fullPage: Boolean(input.full_page),
                operationId: ids.operation(),
                workspaceRevision: 1,
                // Public deployed sites: a short cache lets extra viewports of the
                // same route skip a full re-fetch; JPEG keeps evidence small.
                cacheTtlSeconds: 45,
                deadlineAt
              });
              const { inline, ...screenshotRef } = result.screenshot;
              return {
                kind: 'evidence',
                inline,
                value: {
                  selection: capture.selection ?? capture.path,
                  route: capture.path,
                  environment: viewport.id,
                  state: capture.state,
                  requestedViewport: { width: viewport.width, height: viewport.height },
                  observedViewport: { width: result.screenshot.width, height: result.screenshot.height },
                  screenshot: screenshotRef,
                  accessibility: result.accessibility,
                  inspected: false,
                  limitations: ['A static screenshot only proves what it shows — it does not prove that any unexecuted interaction works.']
                }
              };
            } catch (error) {
              return {
                kind: 'failure',
                value: { route: capture.path, environment: viewport.id, reason: error instanceof Error ? error.message.slice(0, 500) : 'The capture failed for an unknown reason.' }
              };
            }
          }
        );
        // Widget-only screenshot gallery: small JPEG data: URIs the console can
        // render inline. Reuses the same inline bytes the model receives via
        // MCP content, capped so the _meta payload stays bounded. This never
        // enters structuredContent (base64 stays out of what the model reads).
        const screenshots: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; dataUri: string }> = [];
        const captured: Array<{ route: unknown; viewport: unknown; state: unknown; findingCount: number; inline?: { base64: string; contentType: string } }> = [];
        for (const outcome of outcomes) {
          if (outcome.kind === 'evidence') {
            evidence.push(outcome.value);
            captured.push({
              route: outcome.value.route,
              viewport: outcome.value.observedViewport ?? outcome.value.requestedViewport,
              state: outcome.value.state,
              findingCount: findingCountOf(outcome.value),
              inline: outcome.inline
            });
            if (outcome.inline && screenshots.length < MAX_GALLERY_IMAGES) {
              screenshots.push({
                route: outcome.value.route,
                viewport: outcome.value.observedViewport ?? outcome.value.requestedViewport,
                state: outcome.value.state,
                findingCount: findingCountOf(outcome.value),
                dataUri: `data:${outcome.inline.contentType};base64,${outcome.inline.base64}`
              });
            }
          } else if (outcome.kind === 'failure') {
            failures.push(outcome.value);
          } else {
            skipped.push(outcome.value);
          }
        }
        // The images are the deliverable — send back as many as fit, spread across
        // routes rather than clustered on whichever finished first.
        const { chosen: inlineCells, omitted: omittedImages } = await prepareInlineImages(env, captured);
        for (const cell of inlineCells) {
          content.push({ type: 'image', data: cell.inline!.base64, mimeType: cell.inline!.contentType });
        }
        if (evidence.length === 0) {
          throw new ForgeError({
            code: 'FORGE_PREVIEW_UNAVAILABLE',
            message: 'Could not capture any screenshots from the requested URL. Check that the URL is reachable and the routes exist, then retry.',
            retryable: true,
            details: { failures, skipped }
          });
        }
        const complete = failures.length === 0 && skipped.length === 0;
        const structureSummary = summarizeStructure(
          evidence as Array<{ accessibility?: { structure?: { findingCount?: number; countsByKind?: Record<string, number>; truncated?: boolean } }; route?: unknown; environment?: unknown }>
        );
        // Concise per-cell rows for structuredContent: what the model needs to
        // reason about the review, with no base64 and no heavy accessibility
        // trees. The full evidence (screenshot refs, accessibility structure)
        // moves into _meta["forge/widget"] for the component to render.
        const evidenceCells = evidence.map((cell) => ({
          selection: cell.selection,
          route: cell.route,
          environment: cell.environment,
          state: cell.state,
          requestedViewport: cell.requestedViewport,
          observedViewport: cell.observedViewport,
          findingCount: findingCountOf(cell),
          inspected: cell.inspected
        }));
        // A link the model can simply hand over. Best-effort: the attached images
        // stay the primary path, so a failure to write the page must not fail the
        // review that produced them.
        const capturedAtIso = new Date().toISOString();
        const galleryUrl = await storeGallery(env, identity, workspaceId, text(input.url), capturedAtIso, captured);
        const packet = {
          schemaVersion: 1,
          provider: 'forge',
          executionMode: 'url_review',
          containerUsed: false,
          workspaceId,
          sourceUrl: text(input.url),
          capturedAt: capturedAtIso,
          requestedCaptures: cells.length,
          capturedCount: evidence.length,
          complete,
          evidence: evidenceCells,
          failures,
          skipped,
          structureSummary,
          limitations: ['A static screenshot only proves what it shows — it does not prove that any unexecuted interaction works.'],
          inlineImageCount: inlineCells.length,
          omittedImageCount: omittedImages,
          _meta: {
            'forge/widget': {
              schemaVersion: 1,
              executionMode: 'url_review',
              screenshots,
              evidence,
              failures,
              skipped,
              structureSummary
            }
          },
          // Deliberately does not send the caller off to fetch artifacts one by
          // one. The images are already attached; a chat client that cannot
          // reliably chain a second call would otherwise be told its screenshots
          // are somewhere else, having just been handed them.
          galleryUrl,
          nextStep: [
            `Inspect the ${inlineCells.length} image(s) attached to this result — they are the evidence.`,
            omittedImages > 0
              ? `${omittedImages} further capture(s) did not fit in this response; fetch them with forge_artifact_get on evidence[].screenshot.artifactId, or re-run with fewer routes or one viewport.`
              : '',
            complete ? '' : 'Some cells failed or were skipped (see failures and skipped) — re-run just those routes; fewer routes per call captures more reliably.',
            galleryUrl ? `Give the human this link to see them all in a browser: ${galleryUrl}` : '',
            'Then pass the evidence to Parallax with inspected set to true.'
          ].filter(Boolean).join(' ')
        };
        const structureNote =
          structureSummary.totalFindings > 0
            ? ` Structure health flagged ${structureSummary.totalFindings} heading defect(s) across ${structureSummary.affectedCells} evidence cell(s) (see structureSummary) — resolve or explicitly accept these before passing the review.`
            : '';
        const attachedNote = omittedImages > 0
          ? ` ${inlineCells.length} are attached here; ${omittedImages} more are stored.`
          : ' All are attached to this message.';
        const galleryNote = galleryUrl ? ` View them all in a browser: ${galleryUrl}` : '';
        const summary = complete
          ? `Captured ${evidence.length} screenshot(s) of ${text(input.url)} without starting a container.${attachedNote}${galleryNote}${structureNote}`
          : `Captured ${evidence.length} of ${cells.length} screenshot(s) of ${text(input.url)} without starting a container (${failures.length} failed, ${skipped.length} skipped).${attachedNote} Re-run the remaining routes in smaller batches.${galleryNote}${structureNote}`;
        content.unshift({ type: 'text', text: summary });
        return forgeToolResponse(packet, content);
      },
      forge_artifact_get: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, { workspaceId: input.workspace_id, ...workspaceAddress(input) });
        const artifactId = text(input.artifact_id);
        // A container-backed workspace has a coordinator record that binds it to
        // the caller's tenant and project. A URL-review workspace (from
        // forge_review) has no coordinator, so its artifacts are only reachable
        // through the tenant-scoped R2 key. Fall back to that path when — and
        // only when — no coordinator record exists, so real cross-project
        // workspaces still fail the authorization check above.
        let workspaceRevision: number | null = null;
        let source: 'workspace' | 'url_review' | 'degraded_workspace' = 'workspace';
        // Bounded: a workspace that has stopped answering must not be able to
        // block the read of its own recovery artifact. On timeout we fall
        // through to the D1 binding, which carries the same tenant/project
        // facts without needing the container.
        const state = await withDeadline((async () => workspaceOperations(env, workspaceId).tryGetState())(), 5_000);
        // D1 binding, consulted only when the coordinator did not answer. A
        // real container-backed workspace still authorizes on tenant AND
        // project — it just no longer needs to be alive to do it.
        const degradedOwner = state ? null : await lookupWorkspaceOwner(env, workspaceId);
        if (state || degradedOwner) {
          const ownerTenant = state ? state.tenantId : degradedOwner!.tenantId;
          const ownerProject = state ? state.projectId : degradedOwner!.projectId;
          if (ownerTenant !== identity.tenantId || ownerProject !== identity.projectId) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'This workspace belongs to a different project. Use owner/repo/branch (or none, to use the one you have open) to address a workspace in the current project instead.',
              retryable: false
            });
          }
          workspaceRevision = state ? state.revision : null;
          if (!state) source = 'degraded_workspace';
        } else {
          source = 'url_review';
          // Defense-in-depth: the R2 key below is scoped to the caller's own
          // tenant, so a cross-tenant read is already impossible — but the key
          // carries no project, so a same-tenant caller in a different project
          // could otherwise read a url_review artifact by guessing the (random)
          // workspace and artifact ids. If a binding was recorded at review
          // time, it is authoritative: assert both tenant AND project match.
          const owner = await lookupUrlReviewOwner(env, workspaceId);
          if (owner && (owner.tenantId !== identity.tenantId || owner.projectId !== identity.projectId)) {
            throw new ForgeError({
              code: 'FORGE_PERMISSION_DENIED',
              message: 'This url_review artifact belongs to a different project. Call forge_review again from this project — it mints a fresh workspace and artifacts you can fetch.',
              retryable: false
            });
          }
          // owner === null means no binding on record (pre-migration workspace or
          // a best-effort write that did not land): fall back to the tenant-scoped
          // R2 key path. Residual risk: same-tenant cross-project reads of such
          // legacy/unbound workspaces remain key-shape authorized only.
        }
        const object = await env.ARTIFACTS.get(
          `tenant/${identity.tenantId}/workspace/${workspaceId}/artifacts/${artifactId}`
        );
        if (!object) {
          throw new ForgeError({
            code: 'FORGE_ARTIFACT_NOT_FOUND',
            message: 'No artifact with this artifact_id exists in the resolved workspace. Artifact ids do not carry over between workspaces — call forge_review, forge_shell, or whichever tool produced it again to get a fresh one.',
            retryable: false
          });
        }
        const maxBytes = number(input.max_bytes);
        if (object.size > maxBytes) {
          throw new ForgeError({
            code: 'FORGE_OUTPUT_TRUNCATED',
            message: 'The artifact is larger than the requested max_bytes limit. Raise max_bytes and retry.',
            retryable: false,
            details: { sizeBytes: object.size, maxBytes }
          });
        }
        const mimeType = object.httpMetadata?.contentType ?? 'application/octet-stream';
        const value = {
          artifact_id: artifactId,
          workspace_id: workspaceId,
          workspace_revision: workspaceRevision,
          source,
          content_type: mimeType,
          size_bytes: object.size,
          metadata: object.customMetadata ?? {}
        };
        if (mimeType.startsWith('image/')) {
          return forgeToolResponse(value, [{
            type: 'image',
            data: base64(await object.arrayBuffer()),
            mimeType
          }]);
        }
        // Return bounded artifact bytes for both textual and binary artifacts.
        const bytes = await object.arrayBuffer();
        return isTextualArtifact(mimeType)
          ? { ...value, content: new TextDecoder().decode(bytes) }
          : { ...value, content_base64: base64(bytes) };
      },
      forge_artifact_upload: async (input) => {
        const identity = deps.identity();
        const workspaceId = await resolveWorkspaceId(env, identity, workspaceAddress(input));
        const artifactId = ids.artifact() as import('@forge/core').ArtifactId;
        const bytes = Uint8Array.from(atob(text(input.content_base64)), (c) => c.charCodeAt(0)).buffer;
        const store = new R2ArtifactStore(env.ARTIFACTS);
        const ref = await store.put({
          id: artifactId,
          tenantId: identity.tenantId as import('@forge/core').TenantId,
          workspaceId: workspaceId as import('@forge/core').WorkspaceId,
          kind: 'upload',
          contentType: text(input.content_type),
          bytes,
          metadata: (input.metadata as Record<string, string>) ?? {}
        });
        return {
          artifact_id: ref.id,
          key: ref.key,
          content_type: ref.contentType,
          size_bytes: ref.sizeBytes,
          sha256: ref.sha256
        };
      },

  };
}
