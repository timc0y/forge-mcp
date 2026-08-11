import { z } from 'zod';
import { assertForgeWorkersAiAllowed } from '@forge/insight';
import { ids, type ArtifactId, type SiteReviewId, type TenantId, type WorkspaceId } from '@forge/core';
import { R2ArtifactStore } from '@forge/artifacts-r2';
import { CloudflareBrowserProvider } from '@forge/browser-cloudflare';
import { assertPublicHost } from '@forge/policy';
import { storeGallery } from './review-gallery';
import type { Env } from './env';

export type SiteReviewState = 'queued' | 'discovering' | 'planning' | 'capturing' | 'completed' | 'failed';
type PlannerSource = 'ai_gateway' | 'deterministic_fallback';

interface SiteReviewRow {
  id: string; tenant_id: string; project_id: string; origin: string; requested_url: string; goal: string;
  state: SiteReviewState; planner_source: PlannerSource | null; route_catalog_artifact_id: string | null;
  plan_artifact_id: string | null; evidence_artifact_id: string | null; gallery_url: string | null;
  discovered_count: number; captured_count: number; failures_json: string; limitations_json: string;
  error_message: string | null; created_at: string; updated_at: string; completed_at: string | null;
}

export interface SiteReview {
  id: SiteReviewId; tenantId: string; projectId: string; origin: string; requestedUrl: string; goal: string;
  state: SiteReviewState; plannerSource: PlannerSource | null; routeCatalogArtifactId: string | null;
  planArtifactId: string | null; evidenceArtifactId: string | null; galleryUrl: string | null;
  discoveredCount: number; capturedCount: number; failures: Array<Record<string, unknown>>; limitations: string[];
  errorMessage: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
}

const ACTIVE = new Set<SiteReviewState>(['queued', 'discovering', 'planning', 'capturing']);
const MAX_ROUTES = 12;
const MAX_CAPTURE_ROUTES = 6;
const sitemapPaths = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
const planSchema = z.object({ routes: z.array(z.string().startsWith('/')).min(1).max(MAX_CAPTURE_ROUTES) });

function fromRow(row: SiteReviewRow): SiteReview {
  return {
    id: row.id as SiteReviewId, tenantId: row.tenant_id, projectId: row.project_id, origin: row.origin,
    requestedUrl: row.requested_url, goal: row.goal, state: row.state, plannerSource: row.planner_source,
    routeCatalogArtifactId: row.route_catalog_artifact_id, planArtifactId: row.plan_artifact_id,
    evidenceArtifactId: row.evidence_artifact_id, galleryUrl: row.gallery_url,
    discoveredCount: Number(row.discovered_count), capturedCount: Number(row.captured_count),
    failures: JSON.parse(row.failures_json || '[]') as Array<Record<string, unknown>>,
    limitations: JSON.parse(row.limitations_json || '[]') as string[], errorMessage: row.error_message,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at
  };
}

export function normalizeSiteUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) public site URLs are supported.');
  url.hash = '';
  assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''));
  return url;
}

export function sameOriginPath(value: string, origin: string): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
    assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.pathname || '/'}${url.search}`;
  } catch { return null; }
}

export function xmlLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc[^>]*>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!);
}

function htmlLinks(html: string): string[] {
  return [...html.matchAll(/\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)].map((match) => match[1]!);
}

async function safeFetch(url: URL): Promise<Response> {
  const response = await fetch(url.toString(), { redirect: 'follow', headers: { accept: 'text/html,application/xml;q=0.9,*/*;q=0.1' } });
  const finalUrl = normalizeSiteUrl(response.url || url.toString());
  if (finalUrl.origin !== url.origin) throw new Error('Redirect left the requested origin.');
  return response;
}

async function discoverRoutes(env: Env, review: SiteReview): Promise<string[]> {
  const routes = new Set<string>(['/']);
  const pendingSitemaps = sitemapPaths.map((path) => new URL(path, review.origin));
  const seenSitemaps = new Set<string>();
  while (pendingSitemaps.length > 0 && seenSitemaps.size < 8 && routes.size < MAX_ROUTES) {
    const sitemap = pendingSitemaps.shift()!;
    if (seenSitemaps.has(sitemap.toString())) continue;
    seenSitemaps.add(sitemap.toString());
    try {
      const response = await safeFetch(sitemap);
      if (!response.ok) continue;
      const body = (await response.text()).slice(0, 2_000_000);
      for (const loc of xmlLocs(body)) {
        if (/<sitemapindex\b/i.test(body)) {
          try {
            const child = new URL(loc, review.origin);
            if (child.origin === review.origin) pendingSitemaps.push(child);
          } catch { /* invalid sitemap child is ignored */ }
          continue;
        }
        const route = sameOriginPath(loc, review.origin);
        if (route) routes.add(route);
        if (routes.size >= MAX_ROUTES) break;
      }
    } catch { /* sitemap discovery is best-effort; robots.txt is intentionally ignored */ }
  }
  try {
    // Kitesurf is the preferred read-only reconnaissance engine. Its markdown
    // link extraction is bounded and never runs model-provided selectors.
    const kitesurf = new CloudflareBrowserProvider(
      env.BROWSER,
      new R2ArtifactStore(env.ARTIFACTS),
      review.tenantId as TenantId,
      { browser: 'kitesurf' }
    );
    const discovered = await kitesurf.discoverPublicPage({
      workspaceId: review.id as unknown as WorkspaceId,
      url: review.origin,
      path: '/',
      viewport: { width: 1280, height: 900 },
      fullPage: false,
      operationId: ids.operation(),
      workspaceRevision: 1
    });
    for (const href of discovered.links) {
      const route = sameOriginPath(href, review.origin);
      if (route) routes.add(route);
      if (routes.size >= MAX_ROUTES) break;
    }
  } catch { /* Browser Run/Kitesurf incompatibility falls through to HTML links. */ }
  try {
    const response = await safeFetch(new URL(review.requestedUrl));
    const html = (await response.text()).slice(0, 1_000_000);
    for (const href of htmlLinks(html)) {
      const route = sameOriginPath(href, review.origin);
      if (route) routes.add(route);
      if (routes.size >= MAX_ROUTES) break;
    }
  } catch { /* capture stage records failures separately */ }
  return [...routes].sort((a, b) => a.localeCompare(b));
}

export function deterministicPlan(routes: string[]): string[] {
  const selected = ['/'];
  for (const route of routes) {
    if (selected.includes(route)) continue;
    const segment = route.split('/').filter(Boolean)[0] ?? '';
    if (!selected.some((item) => (item.split('/').filter(Boolean)[0] ?? '') === segment)) selected.push(route);
    if (selected.length >= MAX_CAPTURE_ROUTES) break;
  }
  return selected.filter((route) => routes.includes(route)).slice(0, MAX_CAPTURE_ROUTES);
}

async function selectPlan(env: Env, review: SiteReview, routes: string[]): Promise<{ routes: string[]; source: PlannerSource }> {
  const fallback = deterministicPlan(routes);
  const gatewayId = env.FORGE_SITE_REVIEW_GATEWAY_ID?.trim();
  const model = env.FORGE_SITE_REVIEW_MODEL?.trim();
  if (!gatewayId || !model) return { routes: fallback, source: 'deterministic_fallback' };
  try {
    assertForgeWorkersAiAllowed({
      env,
      tenantId: review.tenantId,
      projectId: review.projectId,
      purpose: 'forge.site-review-route-plan',
      classification: 'public',
    });
    const gateway = (env.AI as unknown as { gateway(id: string): { run(model: string, input: unknown): Promise<unknown> } }).gateway(gatewayId);
    const result = await gateway.run(model, {
      messages: [
        { role: 'system', content: 'Select representative public website routes for read-only screenshot review. Return JSON only: {"routes":["/path"]}. Use only supplied routes. Select at most 6.' },
        { role: 'user', content: JSON.stringify({ goal: review.goal, routes }) }
      ]
    });
    const raw = typeof result === 'string' ? result : (result as { response?: unknown })?.response;
    const parsed = planSchema.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!parsed.success || parsed.data.routes.some((route) => !routes.includes(route))) throw new Error('Invalid route plan.');
    return { routes: [...new Set(parsed.data.routes)], source: 'ai_gateway' };
  } catch {
    return { routes: fallback, source: 'deterministic_fallback' };
  }
}

async function putJson(env: Env, review: SiteReview, kind: string, value: unknown): Promise<ArtifactId> {
  const id = ids.artifact() as ArtifactId;
  await new R2ArtifactStore(env.ARTIFACTS).put({
    id, tenantId: review.tenantId as TenantId, workspaceId: review.id as unknown as WorkspaceId, kind,
    contentType: 'application/json; charset=utf-8', bytes: new TextEncoder().encode(JSON.stringify(value)).buffer,
    metadata: { review_id: review.id, origin: review.origin }
  });
  return id;
}

async function update(env: Env, review: SiteReview, patch: Partial<SiteReview>): Promise<SiteReview> {
  const next = { ...review, ...patch, updatedAt: new Date().toISOString() };
  await env.METADATA.prepare(`UPDATE site_reviews SET state=?1, planner_source=?2, route_catalog_artifact_id=?3, plan_artifact_id=?4, evidence_artifact_id=?5, gallery_url=?6, discovered_count=?7, captured_count=?8, failures_json=?9, limitations_json=?10, error_message=?11, updated_at=?12, completed_at=?13 WHERE id=?14`)
    .bind(next.state, next.plannerSource, next.routeCatalogArtifactId, next.planArtifactId, next.evidenceArtifactId, next.galleryUrl, next.discoveredCount, next.capturedCount, JSON.stringify(next.failures), JSON.stringify(next.limitations), next.errorMessage, next.updatedAt, next.completedAt, next.id).run();
  // Analytics Engine is append-only operational evidence: it records Forge's
  // observed lifecycle, never model claims or page contents. A telemetry write
  // must not be able to fail a review.
  try {
    env.SITE_REVIEW_ANALYTICS.writeDataPoint({
      blobs: [next.origin, next.state, next.plannerSource ?? 'unselected'],
      doubles: [next.discoveredCount, next.capturedCount, next.failures.length],
      indexes: [next.tenantId]
    });
  } catch { /* observability is deliberately non-critical */ }
  return next;
}

export async function getSiteReview(env: Env, identity: { tenantId: string; projectId: string }, url: string): Promise<SiteReview | null> {
  const normalized = normalizeSiteUrl(url);
  const row = await env.METADATA.prepare('SELECT * FROM site_reviews WHERE tenant_id=?1 AND project_id=?2 AND origin=?3 ORDER BY updated_at DESC LIMIT 1')
    .bind(identity.tenantId, identity.projectId, normalized.origin).first<SiteReviewRow>();
  return row ? fromRow(row) : null;
}

export async function startSiteReview(env: Env, identity: { tenantId: string; projectId: string }, url: string, goal = ''): Promise<{ review: SiteReview; reused: boolean }> {
  const normalized = normalizeSiteUrl(url);
  const existing = await getSiteReview(env, identity, normalized.toString());
  if (existing && ACTIVE.has(existing.state)) return { review: existing, reused: true };
  const now = new Date().toISOString();
  const review: SiteReview = { id: ids.siteReview(), tenantId: identity.tenantId, projectId: identity.projectId, origin: normalized.origin, requestedUrl: normalized.toString(), goal, state: 'queued', plannerSource: null, routeCatalogArtifactId: null, planArtifactId: null, evidenceArtifactId: null, galleryUrl: null, discoveredCount: 0, capturedCount: 0, failures: [], limitations: ['Robots.txt is intentionally ignored for human-requested reviews.', 'Capture is read-only and does not prove unexecuted interactions work.'], errorMessage: null, createdAt: now, updatedAt: now, completedAt: null };
  await env.METADATA.prepare(`INSERT INTO site_reviews (id,tenant_id,project_id,origin,requested_url,goal,state,failures_json,limitations_json,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'[]',?8,?9,?9)`)
    .bind(review.id, review.tenantId, review.projectId, review.origin, review.requestedUrl, review.goal, review.state, JSON.stringify(review.limitations), now).run();
  await env.SITE_REVIEW_WORKFLOW.create({ id: `site-review-${review.id}`, params: { reviewId: review.id } });
  return { review, reused: false };
}

export async function executeSiteReview(env: Env, reviewId: string): Promise<SiteReview> {
  const row = await env.METADATA.prepare('SELECT * FROM site_reviews WHERE id=?1').bind(reviewId).first<SiteReviewRow>();
  if (!row) throw new Error(`Site review ${reviewId} was not found.`);
  let review = fromRow(row);
  if (review.state === 'completed') return review;
  try {
    review = await update(env, review, { state: 'discovering' });
    const routes = await discoverRoutes(env, review);
    const routeCatalogArtifactId = await putJson(env, review, 'site-review.routes', { origin: review.origin, routes });
    review = await update(env, review, { routeCatalogArtifactId, discoveredCount: routes.length, state: 'planning' });
    const plan = await selectPlan(env, review, routes);
    const planArtifactId = await putJson(env, review, 'site-review.plan', plan);
    review = await update(env, review, { planArtifactId, plannerSource: plan.source, state: 'capturing' });
    const artifacts = new R2ArtifactStore(env.ARTIFACTS);
    const kitesurf = new CloudflareBrowserProvider(env.BROWSER, artifacts, review.tenantId as TenantId, { browser: 'kitesurf' });
    const chromium = new CloudflareBrowserProvider(env.BROWSER, artifacts, review.tenantId as TenantId);
    const evidence: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    const galleryCells: Array<{ route: string; viewport: unknown; state: string; findingCount: number; inline?: { base64: string; contentType: string } }> = [];
    for (const route of plan.routes) for (const viewport of [{ id: 'phone', width: 390, height: 844 }, { id: 'desktop', width: 1440, height: 1000 }]) {
      const input = { workspaceId: review.id as unknown as WorkspaceId, url: review.origin, path: route, viewport: { width: viewport.width, height: viewport.height }, fullPage: false, operationId: ids.operation(), workspaceRevision: 1, cacheTtlSeconds: 45 };
      try {
        let result; let engine: 'kitesurf' | 'chromium' = 'kitesurf';
        try { result = await kitesurf.captureEvidence(input); } catch { engine = 'chromium'; result = await chromium.captureEvidence(input); }
        const { inline, ...screenshot } = result.screenshot;
        evidence.push({ route, viewport, engine, screenshot, accessibility: result.accessibility, captured_at: new Date().toISOString() });
        galleryCells.push({ route, viewport, state: engine, findingCount: result.accessibility.structure.findingCount, inline });
      } catch (error) { failures.push({ route, viewport: viewport.id, reason: error instanceof Error ? error.message.slice(0, 300) : 'capture_failed' }); }
    }
    const capturedAt = new Date().toISOString();
    const evidenceArtifactId = await putJson(env, review, 'site-review.evidence', { source_url: review.requestedUrl, captured_at: capturedAt, evidence, failures });
    const galleryUrl = await storeGallery(env, { tenantId: review.tenantId }, review.id, review.requestedUrl, capturedAt, galleryCells);
    return await update(env, review, { state: 'completed', evidenceArtifactId, galleryUrl: galleryUrl ?? null, capturedCount: evidence.length, failures, completedAt: new Date().toISOString() });
  } catch (error) {
    return await update(env, review, { state: 'failed', errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'site_review_failed', completedAt: new Date().toISOString() });
  }
}

export function siteReviewStatus(review: SiteReview): Record<string, unknown> {
  return { state: review.state, source_url: review.requestedUrl, origin: review.origin, discovered_count: review.discoveredCount, captured_count: review.capturedCount, planner_source: review.plannerSource, gallery_url: review.galleryUrl, failures: review.failures, limitations: review.limitations, ...(review.errorMessage ? { error: review.errorMessage } : {}), allowed_actions: review.state === 'completed' || review.state === 'failed' ? ['start_site_review'] : ['check_site_review_status'] };
}
