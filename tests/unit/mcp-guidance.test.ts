import { describe, expect, it } from 'vitest';
import { forgeTools } from '@forge/mcp-core';
import {
  FORGE_MCP_INSTRUCTIONS,
  FORGE_PROMPT_HINTS,
  dashboardFirstPrompts,
  type ForgePromptName
} from '../../apps/forge-edge-gateway/src/mcp-guidance';

const PROMPT_NAMES = Object.keys(FORGE_PROMPT_HINTS) as ForgePromptName[];

function namedTools(text: string): string[] {
  return text.match(/forge_[a-z_]+/gu) ?? [];
}

describe('mcp project-workflow guidance', () => {
  it('ships every project prompt ChatGPT needs for plan / UI / bug / resume', () => {
    expect(PROMPT_NAMES.sort()).toEqual(
      [
        'fix-bug',
        'figma-parity',
        'iterate-ui',
        'plan-work',
        'prepare-draft-pr',
        'resume-task',
        'review-live-url',
        'start-task',
        'website-qa'
      ].sort()
    );
  });

  it('keeps server instructions and prompt recipes on live tools only', () => {
    const live = new Set(forgeTools.map((tool) => tool.name));
    const samples = [
      FORGE_MCP_INSTRUCTIONS,
      ...PROMPT_NAMES.map((name) =>
        FORGE_PROMPT_HINTS[name]({
          url: 'https://example.com',
          notes: 'pricing',
          repository: 'owner/repo',
          task: 'ship cart',
          goal: 'ship cart',
          change: 'hero layout',
          bug: 'cart count wrong',
          task_id: 'task_example',
          workspace_id: 'ws_example'
        })
      )
    ];
    const offences: string[] = [];
    for (const sample of samples) {
      for (const named of namedTools(sample)) {
        if (!live.has(named)) offences.push(named);
      }
    }
    expect(offences).toEqual([]);
  });

  it('steers plan work away from the executor and UI work toward screenshots', () => {
    const plan = FORGE_PROMPT_HINTS['plan-work']({ repository: 'owner/repo', goal: 'add billing' });
    expect(plan).toMatch(/forge_task_create/);
    expect(plan).toMatch(/do not allocate an executor/i);

    const ui = FORGE_PROMPT_HINTS['iterate-ui']({ repository: 'owner/repo', change: 'tighten hero' });
    expect(ui).toMatch(/forge_preview/);
    expect(ui).toMatch(/forge_edit/);

    const bug = FORGE_PROMPT_HINTS['fix-bug']({ repository: 'owner/repo', bug: '404 on /cart' });
    expect(bug).toMatch(/forge_edit/);
    expect(bug).toMatch(/forge_merge/);

    const resume = FORGE_PROMPT_HINTS['resume-task']({ task_id: 'task_1' });
    expect(resume).toMatch(/forge_task_get/);
    expect(resume).toMatch(/do not forge_workspace_create a duplicate/i);

    const websiteQa = FORGE_PROMPT_HINTS['website-qa']({ url: 'https://example.com' });
    expect(websiteQa).toMatch(/standalone website-qa skill/i);
    expect(websiteQa).toMatch(/forge_review/);
    expect(websiteQa).toMatch(/reduced forge-evidence mode/i);
    expect(websiteQa).toMatch(/never imply the full website-qa runner executed/i);

    const figmaParity = FORGE_PROMPT_HINTS['figma-parity']({ url: 'https://example.com' });
    expect(figmaParity).toMatch(/standalone figma-parity skill/i);
    expect(figmaParity).toMatch(/rendered live half/i);
    expect(figmaParity).toMatch(/captureProvider to forge/i);
    expect(figmaParity).toMatch(/Never imply Forge accessed Figma/i);
  });

  it('gives the dashboard four copy-paste project prompts', () => {
    const prompts = dashboardFirstPrompts('timc0y');
    expect(prompts).toHaveLength(4);
    expect(prompts.join('\n')).toMatch(/Plan the next change/);
    expect(prompts.join('\n')).toMatch(/landing UI/);
    expect(prompts.join('\n')).toMatch(/bug/);
    expect(prompts.join('\n')).toMatch(/timc0y\.com/);
  });
});
