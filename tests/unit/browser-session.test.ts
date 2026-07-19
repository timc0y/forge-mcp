import { describe, expect, it } from 'vitest';
import {
  applyInteraction,
  assertBrowserTransition,
  closeBrowserSession,
  openBrowserSession,
  PHONE_VIEWPORT,
  recordCapture
} from '@forge/browser-core';

const T0 = '2026-07-16T00:00:00.000Z';
const T1 = '2026-07-16T00:00:05.000Z';

describe('browser session lifecycle', () => {
  it('opens, navigates, captures and closes with accumulated active time', () => {
    let session = openBrowserSession({ id: 'bs_1', workspaceId: 'ws_1', previewId: 'prv_1', at: T0 });
    expect(session.state).toBe('opening');
    session = applyInteraction(session, { kind: 'navigate', path: '/cart' }, T0);
    expect(session.state).toBe('open');
    expect(session.currentPath).toBe('/cart');
    session = applyInteraction(session, { kind: 'set-viewport', viewport: PHONE_VIEWPORT }, T0);
    expect(session.viewport).toEqual(PHONE_VIEWPORT);
    session = recordCapture(session, 'art_shot', T0);
    expect(session.captureIds).toEqual(['art_shot']);
    session = closeBrowserSession(session, T1);
    expect(session.state).toBe('closed');
    expect(session.activeMs).toBe(5000);
  });

  it('rejects illegal transitions and is idempotent on close', () => {
    expect(() => assertBrowserTransition('closed', 'open')).toThrow();
    const session = openBrowserSession({ id: 'bs_2', workspaceId: 'ws_1', previewId: 'prv_1', at: T0 });
    const closed = closeBrowserSession(applyInteraction(session, { kind: 'navigate', path: '/' }, T0), T1);
    expect(closeBrowserSession(closed, T1)).toBe(closed);
  });
});
