import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Compatibility stub for the removed Forge Console widget.
 *
 * Forge used to serve an MCP Apps widget at this URI, and every tool carried
 * `openai/outputTemplate` pointing at it. Both were removed — no tool
 * advertises a widget any more, so a client that reads the current tool list
 * never asks for this.
 *
 * A client that connected BEFORE the removal is the problem. ChatGPT caches
 * tool metadata for the life of a connection, so an open session still believes
 * each Forge tool renders `ui://forge/workspace-console`, requests it on every
 * tool result, and — once the resource was gone — sat on an empty skeleton card
 * that never resolved. Three tool calls meant three grey placeholders stacked
 * above the answer.
 *
 * So the URI still resolves, and resolves to nothing: an empty document that
 * paints no chrome, reserves no height and makes no network calls. A stale
 * session collapses it to nothing instead of hanging on a spinner, which is the
 * same end state as a fresh session. Removing this again is only safe once no
 * client can still be holding metadata from before the widget was dropped.
 */
export const FORGE_LEGACY_WIDGET_URI = 'ui://forge/workspace-console';

/** MIME type MCP Apps hosts use for `ui://` resources. */
const RESOURCE_MIME_TYPE = 'text/html+skybridge';

// Deliberately empty. `display:none` on the root keeps a host that measures the
// document from reserving a card-sized gap for it. The CSP allowlists are empty
// because the document has nothing to fetch.
const HTML = '<!doctype html><html><head><meta charset="utf-8">'
  + '<style>html,body{margin:0;padding:0;height:0;overflow:hidden;display:none}</style>'
  + '</head><body></body></html>';

const UI_META = {
  prefersBorder: false,
  csp: {
    connectDomains: [] as string[],
    resourceDomains: [] as string[],
    frameDomains: [] as string[],
    baseUriDomains: [] as string[]
  }
} as const;

export function registerLegacyWidgetStub(server: McpServer): void {
  server.registerResource(
    'Forge Console (retired)',
    FORGE_LEGACY_WIDGET_URI,
    {
      description: 'Retired Forge Console widget. Renders nothing; kept so sessions opened before it was removed resolve instead of showing an unresolved placeholder.',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: UI_META }
    },
    async () => ({
      contents: [{
        uri: FORGE_LEGACY_WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: HTML,
        _meta: { ui: UI_META }
      }]
    })
  );
}
