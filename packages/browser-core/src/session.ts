/**
 * Pure model for interactive browser sessions. A browser session is distinct
 * from a preview (a preview is a URL; a session is an interactive browser
 * visiting one). Sessions are deliberate, never opened automatically for
 * documentation, backend-only, type, unit-test or config-only changes.
 */

export type BrowserSessionState = 'opening' | 'open' | 'closing' | 'closed' | 'failed';

export interface Viewport {
  width: number;
  height: number;
}

export const PHONE_VIEWPORT: Viewport = { width: 390, height: 844 };
export const DESKTOP_VIEWPORT: Viewport = { width: 1440, height: 900 };

export interface BrowserSession {
  id: string;
  workspaceId: string;
  previewId: string;
  state: BrowserSessionState;
  viewport: Viewport;
  currentPath: string;
  /** Evidence artifact ids captured during this session. */
  captureIds: string[];
  openedAt: string;
  updatedAt: string;
  /** Accumulated open duration in ms, for cost accounting. */
  activeMs: number;
}

const transitions: Record<BrowserSessionState, readonly BrowserSessionState[]> = {
  opening: ['open', 'failed', 'closing'],
  open: ['open', 'closing', 'failed'],
  closing: ['closed', 'failed'],
  closed: [],
  failed: ['closing', 'closed']
};

export function assertBrowserTransition(from: BrowserSessionState, to: BrowserSessionState): void {
  if (from === to) return;
  if (!transitions[from].includes(to)) {
    throw new Error(`Browser session cannot transition from ${from} to ${to}.`);
  }
}

export function openBrowserSession(input: {
  id: string;
  workspaceId: string;
  previewId: string;
  viewport?: Viewport;
  path?: string;
  at: string;
}): BrowserSession {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    previewId: input.previewId,
    state: 'opening',
    viewport: input.viewport ?? DESKTOP_VIEWPORT,
    currentPath: input.path ?? '/',
    captureIds: [],
    openedAt: input.at,
    updatedAt: input.at,
    activeMs: 0
  };
}

export type BrowserInteraction =
  | { kind: 'navigate'; path: string }
  | { kind: 'set-viewport'; viewport: Viewport }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string };

/** Apply an interaction to session state purely; the caller performs I/O. */
export function applyInteraction(session: BrowserSession, interaction: BrowserInteraction, at: string): BrowserSession {
  assertBrowserTransition(session.state, 'open');
  const next: BrowserSession = { ...session, state: 'open', updatedAt: at };
  if (interaction.kind === 'navigate') next.currentPath = interaction.path;
  if (interaction.kind === 'set-viewport') next.viewport = interaction.viewport;
  return next;
}

export function recordCapture(session: BrowserSession, captureId: string, at: string): BrowserSession {
  return { ...session, captureIds: [...session.captureIds, captureId], updatedAt: at };
}

export function closeBrowserSession(session: BrowserSession, at: string): BrowserSession {
  if (session.state === 'closed') return session;
  const activeMs = session.activeMs + Math.max(0, Date.parse(at) - Date.parse(session.updatedAt));
  return { ...session, state: 'closed', updatedAt: at, activeMs };
}
