import { ForgeError } from '@forge/core';
import type { Env } from './env';
import { getWebSession, hasForgeAccess, type UserRow } from './github';
import { buildLiveWorkspaceList, buildWorkspaceObserverDetail, posthogLiveEmbedUrl } from './observer-api';
import { listWorkspaceActivity } from './workspace-activity';
import { escapeHtml, page } from './ui';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function requireSession(request: Request, env: Env): Promise<UserRow> {
  const user = await getWebSession(request, env);
  if (!user) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Sign in required.', retryable: false });
  if (!hasForgeAccess(user)) throw new ForgeError({ code: 'FORGE_PERMISSION_DENIED', message: 'Forge access pending.', retryable: false });
  return user;
}

export async function liveApiSnapshot(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  const snapshot = await buildLiveWorkspaceList(env, user.tenant_id);
  const recentActivity = await listWorkspaceActivity(env, user.tenant_id, { limit: 25 });
  return json({ ...snapshot, recentActivity });
}

export async function liveApiWorkspaceDetail(request: Request, env: Env, workspaceId: string): Promise<Response> {
  const user = await requireSession(request, env);
  return json(await buildWorkspaceObserverDetail(env, user.tenant_id, workspaceId));
}

const STREAM_INTERVAL_MS = 4000;

export async function liveApiStream(request: Request, env: Env): Promise<Response> {
  const user = await requireSession(request, env);
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id')?.trim() || '';

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const tick = async () => {
        if (closed) return;
        try {
          const list = await buildLiveWorkspaceList(env, user.tenant_id);
          send('snapshot', list);
          if (workspaceId) {
            const detail = await buildWorkspaceObserverDetail(env, user.tenant_id, workspaceId);
            send('workspace', detail);
          }
        } catch (error) {
          send('error', { message: error instanceof Error ? error.message : 'stream_failed' });
        }
      };
      void tick();
      const interval = setInterval(() => void tick(), STREAM_INTERVAL_MS);
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive'
    }
  });
}

export async function liveDashboardPage(request: Request, env: Env): Promise<Response> {
  try {
    await requireSession(request, env);
  } catch {
    return Response.redirect(`${env.FORGE_PUBLIC_ORIGIN}/login/github?return_to=${encodeURIComponent('/app/live')}`, 302);
  }
  const embedUrl = posthogLiveEmbedUrl(env);
  const posthogSection = embedUrl
    ? `<section class="card" id="posthog"><h3>Optional PostHog charts</h3>
<iframe class="ph-embed" title="PostHog MCP analytics" src="${escapeHtml(embedUrl)}" loading="lazy"></iframe>
<p class="meta">Optional product charts only. Complete activity is the D1 trail above and <code>forge_observer_activity</code> (<code>payloads:true</code>).</p></section>`
    : `<section class="card" id="activity-source"><h3>Complete activity log</h3>
<p class="meta">Source of truth: D1 <code>mcp_tool_calls</code> (redacted request/response per tool) and <code>workspace_activity</code>. Read via this page or MCP <code>forge_observer_activity</code> with <code>payloads:true</code>. PostHog is optional and not required — set <code>FORGE_POSTHOG_LIVE_EMBED_URL</code> only if you want a separate sharing embed.</p></section>`;

  return page({
    title: 'Forge — live activity',
    topRight: '<a href="/app">Dashboard</a>',
    css: `
.live-grid{display:grid;gap:1rem}
@media(min-width:900px){.live-grid{grid-template-columns:1fr 1fr}}
.card{border:1px solid var(--line);border-radius:12px;padding:1rem;background:var(--panel)}
.card h3{margin:0 0 .35rem;font-size:1rem}
.meta{color:var(--muted);font-size:.85rem;margin:.25rem 0}
.pill{display:inline-block;font-size:.75rem;padding:.15rem .45rem;border-radius:6px;border:1px solid var(--line);margin-right:.35rem}
.pill.ok{border-color:var(--ok);color:var(--ok)}
.pill.warn{border-color:var(--bad);color:var(--bad)}
.log{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.65rem .75rem;font:.8rem/1.45 ui-monospace,Menlo,monospace;max-height:14rem;overflow:auto;white-space:pre-wrap;word-break:break-word}
.activity{list-style:none;margin:.5rem 0 0;padding:0;font-size:.82rem;max-height:16rem;overflow:auto}
.activity li{padding:.35rem 0;border-bottom:1px solid var(--line)}
.activity li:last-child{border-bottom:0}
.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:1rem 0}
.toolbar small{color:var(--muted)}
select{min-height:44px;padding:.4rem .6rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
.ph-embed{width:100%;min-height:280px;border:0;border-radius:8px;background:var(--bg)}
.status-live{color:var(--ok);font-size:.85rem}
`,
    body: `<h1>Live activity</h1>
<p class="meta">Read-only. Uses SSE when supported, with polling fallback. Does not mutate agent workspaces.</p>
<p class="status-live" id="transport">Connecting…</p>
<div class="toolbar"><label for="ws">Workspace</label><select id="ws"><option value="">— select —</option></select><small id="clock"></small></div>
<div class="live-grid">
<section class="card" id="summary"><h3>Overview</h3><p class="meta">Loading…</p></section>
<section class="card" id="tenant-activity"><h3>Account tool trail (D1)</h3><ul class="activity" id="tenant-activity-list"></ul></section>
<section class="card" id="activity"><h3>Workspace MCP tools</h3><ul class="activity" id="activity-list"></ul></section>
<section class="card" id="processes"><h3>Processes</h3><div id="process-list" class="meta">—</div></section>
<section class="card" id="logs"><h3>Log tail</h3><pre class="log" id="log-tail">—</pre></section>
${posthogSection}
</div>
<script>
let selected = new URLSearchParams(location.search).get('workspace_id') || '';
const wsSelect = document.getElementById('ws');
const clock = document.getElementById('clock');
const transport = document.getElementById('transport');
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderList(data){
  const prev = wsSelect.value;
  wsSelect.innerHTML = '<option value="">— select —</option>' + (data.workspaces||[]).map(w=>
    '<option value="'+esc(w.workspaceId)+'">'+esc((w.repository||'workspace')+' · '+w.state+(w.idleMinutes!=null?' · '+w.idleMinutes+'m idle':''))+'</option>'
  ).join('');
  if(selected) wsSelect.value = selected;
  else if((data.workspaces||[]).length===1){ selected=data.workspaces[0].workspaceId; wsSelect.value=selected; }
  else if(prev) wsSelect.value=prev;
  const summary = document.getElementById('summary');
  if(!(data.workspaces||[]).length){ summary.innerHTML='<h3>Overview</h3><p class="meta">No live workspaces.</p>'; return; }
  summary.innerHTML='<h3>Active workspaces ('+data.workspaces.length+')</h3>'+(data.workspaces||[]).map(w=>{
    const task = w.task ? '<p><strong>Task</strong> '+esc(w.task.goal)+' <span class="pill">'+esc(w.task.state)+'</span></p>' : '';
    return '<div style="margin:.75rem 0"><strong>'+esc(w.repository||w.workspaceId)+'</strong> <span class="pill">ephemeral executor</span>'+
      '<div class="meta">'+esc(w.branch||'—')+' @ '+esc(w.head||'—')+' · slot '+w.slot+' · '+esc(w.state)+'</div>'+task+'</div>';
  }).join('');
  const tenantAct = document.getElementById('tenant-activity-list');
  const recent = data.recentActivity || [];
  tenantAct.innerHTML = recent.length ? recent.map(e=>'<li><code>'+esc(e.tool)+'</code> '+esc(e.status)+' · '+e.durationMs+'ms'+(e.workspaceId?' · '+esc(e.workspaceId.slice(0,12))+'…':'')+'</li>').join('') : '<li class="meta">No recorded tool calls yet.</li>';
}
function renderDetail(data){
  if(!data || !data.available){ return; }
  clock.textContent = 'Updated '+new Date().toLocaleTimeString();
  const act = document.getElementById('activity-list');
  const events = (data.activity||[]).slice(0,40);
  act.innerHTML = events.length ? events.map(e=>'<li><code>'+esc(e.tool)+'</code> '+esc(e.status)+' · '+e.durationMs+'ms · '+esc(e.at)+(e.source?' · '+esc(e.source):'')+'</li>').join('') : '<li class="meta">No workspace-scoped activity yet.</li>';
  const procs = document.getElementById('process-list');
  const list = data.processes||[];
  procs.innerHTML = list.length ? list.map(p=>'<div><code>'+esc(p.id)+'</code> '+esc(p.status)+' · '+esc(p.command||'')+'</div>').join('') : '<span class="meta">No managed processes.</span>';
  const log = document.getElementById('log-tail');
  if(data.logTail && data.logTail.data){ log.textContent = data.logTail.data; }
  else { log.textContent = data.logTail ? '(empty)' : '—'; }
}
function connectSse(){
  const qs = selected ? '?workspace_id='+encodeURIComponent(selected) : '';
  const es = new EventSource('/app/api/live/stream'+qs);
  es.addEventListener('snapshot', (ev)=>{ try{ renderList(JSON.parse(ev.data)); }catch(e){} });
  es.addEventListener('workspace', (ev)=>{ try{ renderDetail(JSON.parse(ev.data)); }catch(e){} });
  es.addEventListener('error', ()=>{ transport.textContent='SSE reconnecting…'; });
  es.onopen = ()=>{ transport.textContent='Live (SSE)'; };
  return es;
}
let es = connectSse();
wsSelect.addEventListener('change',()=>{
  selected = wsSelect.value;
  history.replaceState(null,'', selected ? '?workspace_id='+encodeURIComponent(selected) : '/app/live');
  es.close();
  es = connectSse();
});
</script>`
  });
}
