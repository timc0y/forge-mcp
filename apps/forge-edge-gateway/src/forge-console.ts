import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const FORGE_CONSOLE_URI = 'ui://forge/workspace-console';

// The console is a single self-contained widget rendered inside the ChatGPT /
// Claude tool-result surface. It receives whatever `structuredContent` the last
// Forge tool returned and shape-detects it — review evidence, a git diff, git
// status, a workspace, or a repository list — rendering each with a purpose-built
// layout instead of a flat key/value dump. Everything is inline (no network) so
// it renders instantly in the sandboxed iframe.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{
  color-scheme:light dark;
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --ink:#16161a;--muted:#6b6b76;--faint:#9a9aa4;
  --line:#e6e6ea;--line-soft:#f0f0f3;
  --surface:#fff;--panel:#fafafb;--soft:#f3f3f6;
  --accent:#5b4cf0;--accent-ink:#fff;--accent-soft:#efedfe;
  --ok:#0f9d58;--ok-bg:#e7f6ee;
  --warn:#b7791f;--warn-bg:#fbf1de;
  --bad:#d64545;--bad-bg:#fbe9e9;
  --add:#0f9d58;--add-bg:#eafaf0;--del:#d64545;--del-bg:#fdecec;
  --radius:14px;--radius-sm:9px;
  --shadow:0 1px 2px rgba(16,16,26,.04),0 4px 16px -8px rgba(16,16,26,.12);
}
@media(prefers-color-scheme:dark){:root{
  --ink:#f4f4f6;--muted:#a2a2ad;--faint:#71717a;
  --line:#2c2c33;--line-soft:#232329;
  --surface:#141417;--panel:#1a1a1f;--soft:#24242b;
  --accent:#8b7dff;--accent-ink:#0e0e12;--accent-soft:#221f33;
  --ok:#41c98a;--ok-bg:#12271d;
  --warn:#e0b055;--warn-bg:#2a2312;
  --bad:#f08585;--bad-bg:#2c1616;
  --add:#41c98a;--add-bg:#12251b;--del:#f08585;--del-bg:#2a1616;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.55);
}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--surface);color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
main{max-width:840px;margin:0 auto;padding:16px 18px 22px}
button{font:inherit;cursor:pointer}
strong{font-weight:650}

/* Header */
.top{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.mark{display:flex;align-items:center;gap:9px;font-weight:750;letter-spacing:-.02em;font-size:16px}
.mark .glyph{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#a78bfa);display:grid;place-items:center;color:#fff;font-size:15px;box-shadow:0 2px 8px -2px var(--accent)}
.pill{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--faint)}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.ok .dot{background:var(--ok)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.warn .dot{background:var(--warn)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.bad .dot{background:var(--bad)}
.pill.busy{background:var(--accent-soft);color:var(--accent)}.pill.busy .dot{background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}

/* Blocks */
#content{margin-top:16px;display:flex;flex-direction:column;gap:16px}
.lead{font-size:14.5px;line-height:1.55;color:var(--ink);max-width:70ch;margin:0}
.lead.muted{color:var(--muted)}
.empty{padding:26px 22px;text-align:center;border:1px dashed var(--line);border-radius:var(--radius);color:var(--muted);background:var(--panel)}
.empty .big{font-size:16px;color:var(--ink);font-weight:650;margin-bottom:6px}
.empty .qs{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:16px}

.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:baseline;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:5px 11px;font-size:12px;color:var(--muted)}
.chip b{color:var(--ink);font-weight:600}
.chip.copy{cursor:pointer;transition:background .12s,border-color .12s}
.chip.copy:hover{border-color:var(--accent);background:var(--accent-soft)}
.chip.copy .ic{font-size:11px;opacity:.5;align-self:center}
.chip.copied{color:var(--ok);border-color:var(--ok)}

.sect{margin:0}
.sect>h2{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin:0 0 9px;font-weight:650;display:flex;align-items:center;gap:8px}
.sect>h2 .count{background:var(--soft);color:var(--muted);border-radius:999px;padding:1px 8px;font-size:11px;letter-spacing:0;text-transform:none}

/* Scorecard */
.score{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-sm);padding:13px 14px;box-shadow:var(--shadow)}
.stat .n{font-size:24px;font-weight:750;letter-spacing:-.02em;line-height:1.1}
.stat .l{font-size:11.5px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.03em}
.stat.ok .n{color:var(--ok)}.stat.warn .n{color:var(--warn)}.stat.bad .n{color:var(--bad)}.stat.accent .n{color:var(--accent)}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 13px;display:flex;flex-direction:column;gap:6px;min-width:0}
.card.act{cursor:pointer;transition:border-color .12s,transform .08s}
.card.act:hover{border-color:var(--accent)}.card.act:active{transform:translateY(1px)}
.card .row1{display:flex;align-items:center;gap:8px;justify-content:space-between}
.card .title{font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .sub{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .metaline{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}

.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.mono{font-family:var(--mono);font-weight:500}

.note{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:var(--radius-sm);font-size:13px;line-height:1.5}
.note.warn{background:var(--warn-bg);color:var(--warn)}
.note.bad{background:var(--bad-bg);color:var(--bad)}
.note.ok{background:var(--ok-bg);color:var(--ok)}
.note .ic{flex:0 0 auto;font-size:14px;line-height:1.4}
.note ul{margin:4px 0 0;padding-left:16px}.note li{margin:2px 0}

/* Filter */
.filter{width:100%;font:inherit;font-size:13px;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--panel);color:var(--ink);margin-bottom:10px}
.filter:focus{outline:none;border-color:var(--accent)}
.filter::placeholder{color:var(--faint)}

/* Diff viewer */
.diff{border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden;font-family:var(--mono);font-size:12.5px;background:var(--panel)}
.diff+.diff{margin-top:10px}
.diff .file{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--soft);border-bottom:1px solid var(--line);font-weight:600;color:var(--ink)}
.diff .file .ficon{opacity:.6}
.diff .file .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.diff .file .counts{margin-left:auto;display:flex;gap:8px;font-size:11px;font-weight:600}
.diff .file .counts .a{color:var(--add)}.diff .file .counts .d{color:var(--del)}
.diff pre{margin:0;overflow-x:auto;padding:6px 0}
.diff .ln{display:block;padding:0 12px 0 30px;white-space:pre;line-height:1.55;position:relative}
.diff .ln::before{content:attr(data-g);position:absolute;left:8px;width:14px;text-align:center;opacity:.55}
.diff .ln.add{background:var(--add-bg);color:var(--add)}
.diff .ln.del{background:var(--del-bg);color:var(--del)}
.diff .ln.hunk{color:var(--accent);opacity:.85;padding-left:12px}.diff .ln.hunk::before{content:""}
.diff .more{padding:7px 12px;font-size:11px;color:var(--faint);font-family:var(--font);border-top:1px solid var(--line);background:var(--soft)}

/* Skeleton (working state) */
.sk{display:flex;flex-direction:column;gap:12px}
.sk .bar{height:14px;border-radius:6px;background:linear-gradient(90deg,var(--soft) 25%,var(--line-soft) 37%,var(--soft) 63%);background-size:400% 100%;animation:shimmer 1.3s ease infinite}
.sk .bar.w1{width:60%}.sk .bar.w2{width:85%;height:44px}.sk .bar.w3{width:40%}
@keyframes shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}

/* Actions */
.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:2px}
.actions button{border:1px solid transparent;border-radius:var(--radius-sm);padding:9px 14px;font-weight:600;font-size:13px;background:var(--accent);color:var(--accent-ink);transition:transform .08s ease,filter .12s ease}
.actions button.secondary{background:var(--panel);color:var(--ink);border-color:var(--line)}
.actions button:hover{filter:brightness(1.05)}.actions button.secondary:hover{border-color:var(--accent)}
.actions button:active{transform:translateY(1px)}

@media(prefers-reduced-motion:no-preference){#content{animation:appear .2s ease-out}@keyframes appear{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}}
@media(prefers-reduced-motion:reduce){.sk .bar,.pill.busy .dot{animation:none}}
</style></head><body><main>
<div class="top">
  <div class="mark"><span class="glyph">⚒</span><span>Forge</span></div>
  <div class="pill" id="status"><span class="dot"></span><span id="status-text">Ready</span></div>
</div>
<div id="content">
  <div class="empty"><div class="big">Ready to build</div>Pick a repository, review a live URL, or ask to build and test a change. Forge picks the cheapest capable runtime automatically.
    <div class="qs">
      <button class="actions" data-message="List the repositories connected to Forge.">Browse repositories</button>
      <button class="actions" data-message="Review a deployed URL with Parallax and capture phone and desktop screenshots.">Review a live URL</button>
    </div>
  </div>
</div>
</main><script>
(function(){
var content=document.getElementById('content');
var pill=document.getElementById('status');
var statusText=document.getElementById('status-text');

function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function has(a){return Array.isArray(a)&&a.length>0;}

function setStatus(text,tone){
  statusText.textContent=text||'Ready';
  pill.className='pill'+(tone?(' '+tone):'');
}
function toneForState(s){
  s=String(s||'').toLowerCase();
  if(/fail|error|denied|blocked/.test(s))return 'bad';
  if(/pending|provision|working|running|initial|queue/.test(s))return 'busy';
  if(/ready|complete|passed|active|clean|done|ok/.test(s))return 'ok';
  return '';
}

function chip(label,value){return '<span class="chip">'+esc(label)+' <b>'+esc(value)+'</b></span>';}
function copyChip(label,value){
  return '<span class="chip copy" data-copy="'+esc(value)+'" title="Copy">'+esc(label)+' <b>'+esc(shortId(value))+'</b> <span class="ic">⧉</span></span>';
}
function section(title,body,count){
  return '<section class="sect"><h2>'+esc(title)+(count!=null?'<span class="count">'+esc(count)+'</span>':'')+'</h2>'+body+'</section>';
}
function stat(n,label,tone){return '<div class="stat'+(tone?' '+tone:'')+'"><div class="n">'+esc(n)+'</div><div class="l">'+esc(label)+'</div></div>';}
function actionBtn(text,message,secondary){
  return '<button'+(secondary?' class="secondary"':'')+' data-message="'+esc(message)+'">'+esc(text)+'</button>';
}

/* ---- shape renderers ---- */

function renderRepositories(v){
  var repos=v.repositories;
  setStatus(repos.length+' repositories','ok');
  var cards=repos.map(function(r){
    var name=(r.owner?r.owner+'/':'')+(r.name||r.full_name||'repository');
    var vis=r.visibility||'';var branch=r.default_branch||r.branch||'';
    return '<div class="card act" data-message="Open the '+esc(name)+' repository and show its structure and key files." data-key="'+esc(name.toLowerCase())+'">'+
      '<div class="row1"><span class="title">'+esc(name)+'</span>'+
      (vis?'<span class="badge">'+esc(vis)+'</span>':'')+'</div>'+
      (branch?'<span class="sub">default · '+esc(branch)+'</span>':'')+'</div>';
  }).join('');
  var filter=repos.length>8?'<input class="filter" id="repo-filter" placeholder="Filter repositories…" autocomplete="off">':'';
  return '<p class="lead muted">Repositories connected to Forge. Select one to build, edit and prepare a draft PR.</p>'+
    section('Repositories',filter+'<div class="grid" id="repo-grid">'+cards+'</div>',repos.length);
}

function renderEvidence(v){
  var ev=v.evidence||[];
  var mode=v.executionMode||v.execution_mode;
  var state=v.state||(v.complete?'complete':'')||mode;

  var totalFindings=0,cleanCount=0;
  ev.forEach(function(c){var f=findingCount(c);totalFindings+=f;if(f===0)cleanCount++;});
  var summary=v.structureSummary;
  if(summary&&summary.totalFindings)totalFindings=Math.max(totalFindings,summary.totalFindings);

  setStatus(labelState(state)||'Review',totalFindings>0?'warn':toneForState(state||'complete'));

  var out='';
  var lead=v.nextStep||v.next_step||v.message;
  if(lead)out+='<p class="lead">'+esc(lead)+'</p>';

  // Scorecard
  out+=section('Overview',
    '<div class="score">'+
    stat(ev.length,'Screenshots','accent')+
    stat(cleanCount,'Clean views','ok')+
    stat(totalFindings,totalFindings===1?'Finding':'Findings',totalFindings>0?'warn':'ok')+
    (v.containerUsed===false?stat('0','Containers used','ok'):'')+
    '</div>');

  // Meta chips
  var chips=[];
  var repo=repoLabel(v.repository);
  if(repo)chips.push(chip('Repository',repo));
  if(mode)chips.push(chip('Mode',String(mode).replace(/_/g,' ')));
  var wid=v.workspaceId||v.workspace_id;
  if(wid)chips.push(copyChip('Workspace',wid));
  if(chips.length)out+='<div class="chips">'+chips.join('')+'</div>';

  if(summary&&(summary.totalFindings||summary.affectedCells)){
    out+='<div class="note warn"><span class="ic">⚠</span><div><strong>Structure health</strong> — '+
      esc(summary.totalFindings||0)+' heading defect'+(summary.totalFindings===1?'':'s')+
      ' across '+esc(summary.affectedCells||0)+' evidence cell'+(summary.affectedCells===1?'':'s')+
      '. Resolve or explicitly accept these before passing the review.</div></div>';
  }

  var cells=ev.map(function(c,i){
    var route=(c.route&&(c.route.path||c.route.selection))||c.path||('view '+(i+1));
    var vp=c.observedViewport||c.viewport;
    var vpLabel=vp&&vp.width?vp.width+'×'+vp.height:(c.viewport&&c.viewport.id)||'';
    var st=c.state||(c.route&&c.route.state)||'';
    var findings=findingCount(c);
    var badge=findings>0
      ? '<span class="badge warn">'+findings+' finding'+(findings===1?'':'s')+'</span>'
      : '<span class="badge ok">clean</span>';
    return '<div class="card"><div class="row1"><span class="title">'+esc(route)+'</span>'+badge+'</div>'+
      '<div class="metaline">'+
      (vpLabel?'<span class="badge mono">'+esc(vpLabel)+'</span>':'')+
      (st?'<span class="badge">'+esc(st)+'</span>':'')+
      '</div></div>';
  }).join('');
  if(has(ev))out+=section('Parallax evidence','<div class="grid">'+cells+'</div>',ev.length);

  if(has(v.limitations)){
    out+='<div class="note bad"><span class="ic">◈</span><div><strong>Limitations</strong><ul>'+
      v.limitations.map(function(l){return '<li>'+esc(l)+'</li>';}).join('')+'</ul></div></div>';
  }

  out+=actions([
    'Review these screenshots with Parallax. Report the most consequential issues first.',
    'Show me the current Git diff and test status before making any external change.'
  ]);
  return out;
}

function renderDiff(v){
  var raw=v.stdout||v.raw||v.diff||'';
  if(!raw.trim())return renderStatus(v);
  var files=parseDiff(raw);
  var totalA=0,totalD=0;
  files.forEach(function(f){totalA+=f.add;totalD+=f.del;});
  setStatus(files.length+' file'+(files.length===1?'':'s')+' changed',files.length?'warn':'ok');

  var out=section('Overview',
    '<div class="score">'+
    stat(files.length,files.length===1?'File':'Files','accent')+
    stat('+'+totalA,'Added','ok')+
    stat('-'+totalD,'Removed','bad')+
    '</div>');

  var blocks=files.map(function(f){
    var shown=f.lines.slice(0,40);
    var rest=f.lines.length-shown.length;
    var body=shown.map(function(ln){
      var hunk=ln.indexOf('@@')===0;
      var cls=ln[0]==='+'?'add':ln[0]==='-'?'del':hunk?'hunk':'';
      var g=cls==='add'?'+':cls==='del'?'-':'';
      // Unified-diff data lines carry a 1-char prefix (+/-/space); the gutter
      // shows the marker, so strip it from the body to avoid a doubled glyph.
      var textRaw=hunk?ln:(cls==='add'||cls==='del'||ln[0]===' ')?ln.slice(1):ln;
      return '<span class="ln'+(cls?' '+cls:'')+'" data-g="'+g+'">'+esc(textRaw||' ')+'</span>';
    }).join('');
    return '<div class="diff"><div class="file"><span class="ficon">'+fileIcon(f.path)+'</span><span class="path">'+esc(f.path)+'</span>'+
      '<span class="counts"><span class="a">+'+f.add+'</span><span class="d">-'+f.del+'</span></span></div>'+
      '<pre>'+body+'</pre>'+
      (rest>0?'<div class="more">+'+rest+' more lines — ask to see the full diff for this file</div>':'')+
      '</div>';
  }).join('');
  out+=section('Working changes',blocks,files.length);
  out+=actions([
    'Run the tests and lint for these changes and report the result.',
    'Prepare a draft PR for these changes once tests pass.'
  ]);
  return out;
}

function renderStatus(v){
  var clean=v.clean===true;
  setStatus(clean?'Working tree clean':'Changes present',clean?'ok':'warn');
  var out='';
  if(clean){
    out+='<div class="note ok"><span class="ic">✓</span><div><strong>Working tree clean</strong> — no uncommitted changes in the workspace.</div></div>';
  }else{
    out+='<p class="lead">The workspace has uncommitted changes.</p>';
    if(v.raw&&v.raw.trim()){
      out+=section('git status','<div class="diff"><pre>'+v.raw.trim().split('\\n').slice(0,30).map(function(l){
        return '<span class="ln">'+esc(l)+'</span>';}).join('')+'</pre></div>');
    }
  }
  out+=actions(clean?['Show me the repository structure.']:['Show me the full diff of these changes.']);
  return out;
}

function renderWorkspace(v){
  var state=v.state||'ready';
  setStatus(labelState(state),toneForState(state));
  var chips=[];
  var repo=repoLabel(v.repository);
  if(repo)chips.push(chip('Repository',repo));
  var wid=v.workspace_id||v.workspaceId;
  if(wid)chips.push(copyChip('Workspace',wid));
  if(v.state)chips.push(chip('State',labelState(v.state)));
  var out='<p class="lead">'+esc(v.nextStep||v.message||'Workspace is ready for the next instruction.')+'</p>'+
    '<div class="chips">'+chips.join('')+'</div>';
  out+=actions([
    'Show me the repository structure and key files.',
    'Show me the current Git status.'
  ]);
  return out;
}

function renderGeneric(v){
  var msg=v.nextStep||v.next_step||v.message||v.summary;
  if(v.state)setStatus(labelState(v.state),toneForState(v.state));
  var chips=[];
  ['repository','workspace_id','workspaceId','state','mode','branch'].forEach(function(k){
    if(v[k]!=null){
      if(/id/i.test(k)){chips.push(copyChip(prettyKey(k),v[k]));return;}
      var val=k==='repository'?repoLabel(v[k]):v[k];
      if(val)chips.push(chip(prettyKey(k),val));
    }
  });
  var out='';
  if(msg)out+='<p class="lead">'+esc(msg)+'</p>';
  else out+='<div class="empty"><div class="big">Received a result</div>Forge returned data without a standard view. The full payload is attached to the tool result.</div>';
  if(chips.length)out+='<div class="chips">'+chips.join('')+'</div>';
  return out;
}

/* ---- helpers ---- */
function repoLabel(r){
  if(!r)return '';
  if(typeof r==='string')return r;
  if(r.owner&&r.name)return r.owner+'/'+r.name;
  return r.name||r.full_name||'';
}
function shortId(id){id=String(id||'');return id.length>18?id.slice(0,16)+'…':id;}
function labelState(s){s=String(s||'');return s?s.charAt(0).toUpperCase()+s.slice(1).replace(/_/g,' '):'';}
function prettyKey(k){return k.replace(/_/g,' ').replace(/id/i,'ID').replace(/^\\w/,function(c){return c.toUpperCase();});}
function findingCount(c){
  var s=c&&c.accessibility&&c.accessibility.structure;
  if(s&&typeof s.findingCount==='number')return s.findingCount;
  return 0;
}
function fileIcon(path){
  var ext=(String(path).split('.').pop()||'').toLowerCase();
  if(/tsx?|jsx?|mjs|cjs/.test(ext))return '{ }';
  if(/css|scss|less/.test(ext))return '▤';
  if(/json|ya?ml|toml/.test(ext))return '⚙';
  if(/md|txt/.test(ext))return '¶';
  if(/png|jpe?g|svg|gif|webp/.test(ext))return '▦';
  if(/html?/.test(ext))return '◇';
  return '›';
}
function actions(msgs){
  if(!has(msgs))return '';
  return '<div class="actions">'+msgs.map(function(m,i){return actionBtn(i===0?labelFor(m):shortLabel(m),m,i>0);}).join('')+'</div>';
}
function labelFor(m){
  if(/parallax/i.test(m))return 'Review with Parallax';
  if(/test/i.test(m))return 'Run tests';
  if(/draft pr/i.test(m))return 'Prepare draft PR';
  if(/structure/i.test(m))return 'Explore repository';
  return 'Continue';
}
function shortLabel(m){
  if(/diff/i.test(m))return 'Inspect changes';
  if(/status/i.test(m))return 'Git status';
  if(/structure/i.test(m))return 'Explore files';
  if(/draft pr/i.test(m))return 'Prepare draft PR';
  return 'More';
}
function parseDiff(raw){
  var files=[],cur=null;var lines=raw.split('\\n');
  for(var i=0;i<lines.length;i++){
    var ln=lines[i];
    if(ln.indexOf('diff --git')===0){
      var m=ln.match(/ b\\/(.+)$/);
      cur={path:m?m[1]:ln.replace('diff --git ',''),add:0,del:0,lines:[]};
      files.push(cur);continue;
    }
    if(!cur)continue;
    if(ln.indexOf('index ')===0||ln.indexOf('--- ')===0||ln.indexOf('+++ ')===0||ln.indexOf('new file')===0||ln.indexOf('deleted file')===0||ln.indexOf('similarity ')===0||ln.indexOf('rename ')===0)continue;
    if(ln[0]==='+')cur.add++;else if(ln[0]==='-')cur.del++;
    cur.lines.push(ln);
  }
  return files;
}

/* ---- dispatch ---- */
function render(value){
  if(!value||typeof value!=='object'){setStatus('Ready');return;}
  var html;
  if(has(value.repositories))html=renderRepositories(value);
  else if(has(value.evidence)||value.executionMode||value.execution_mode||value.structureSummary)html=renderEvidence(value);
  else if(typeof value.stdout==='string'&&/diff --git|^@@/m.test(value.stdout)||typeof value.diff==='string'&&value.diff.trim())html=renderDiff(value);
  else if('clean'in value)html=renderStatus(value);
  else if((value.workspace_id||value.workspaceId)&&value.state)html=renderWorkspace(value);
  else html=renderGeneric(value);
  content.innerHTML=html;
}

function showWorking(){
  setStatus('Working…','busy');
  content.innerHTML='<div class="sk"><div class="bar w1"></div><div class="bar w2"></div><div class="bar w2"></div><div class="bar w3"></div></div>';
}

/* ---- events ---- */
window.addEventListener('message',function(event){
  var m=event.data;if(!m)return;
  if(m.method==='ui/notifications/tool-result')render(m.params&&(m.params.structuredContent||m.params.content));
  if(m.method==='ui/notifications/tool-input')showWorking();
});
document.addEventListener('input',function(e){
  if(e.target&&e.target.id==='repo-filter'){
    var q=e.target.value.toLowerCase();
    var cards=document.querySelectorAll('#repo-grid .card');
    for(var i=0;i<cards.length;i++){
      var k=cards[i].getAttribute('data-key')||'';
      cards[i].style.display=k.indexOf(q)>=0?'':'none';
    }
  }
});
document.addEventListener('click',function(e){
  var t=e.target;
  var copyEl=t;while(copyEl&&copyEl!==document&&!(copyEl.dataset&&copyEl.dataset.copy))copyEl=copyEl.parentNode;
  if(copyEl&&copyEl.dataset&&copyEl.dataset.copy){
    var val=copyEl.dataset.copy;
    try{navigator.clipboard&&navigator.clipboard.writeText(val);}catch(_){}
    copyEl.classList.add('copied');
    var ic=copyEl.querySelector('.ic');if(ic)ic.textContent='✓';
    setTimeout(function(){copyEl.classList.remove('copied');if(ic)ic.textContent='⧉';},1200);
    return;
  }
  var mt=t;while(mt&&mt!==document&&!(mt.dataset&&mt.dataset.message))mt=mt.parentNode;
  var message=mt&&mt.dataset&&mt.dataset.message;
  if(message)parent.postMessage({jsonrpc:'2.0',id:crypto.randomUUID(),method:'ui/message',params:{role:'user',content:[{type:'text',text:message}]}},'*');
});
parent.postMessage({jsonrpc:'2.0',id:'forge-init',method:'ui/initialize',params:{appInfo:{name:'Forge Console',version:'0.3.0'},appCapabilities:{},protocolVersion:'2026-01-26'}},'*');
})();
</script></body></html>`;

export function registerForgeConsole(server: McpServer): void {
  registerAppResource(server, 'Forge Console', FORGE_CONSOLE_URI, {
    description: 'Workspace, screenshot evidence, changes and approval state for Forge tasks.',
    _meta: { ui: { prefersBorder: true } }
  }, async () => ({
    contents: [{ uri: FORGE_CONSOLE_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: true } } }]
  }));
}
