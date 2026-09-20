import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolContext } from "../src/tools";
import type { GitHubRequest, Identity } from "../src/contracts";
import type { Env } from "../src/env";

function createMockToolContext(customRoutes: Record<string, any> = {}, envOverrides: Partial<Env> = {}): {
  ctx: ToolContext;
  server: McpServer;
  calls: string[];
} {
  const calls: string[] = [];
  const routes: Record<string, any> = {
    "GET /installation/repositories": {
      status: 200,
      json: {
        total_count: 2,
        repositories: [
          {
            name: "test-repo",
            owner: { login: "testuser" },
            description: "A test repository",
            private: false,
            pushed_at: "2026-09-18T12:00:00Z",
            default_branch: "main"
          },
          {
            name: "another-repo",
            owner: { login: "testuser" },
            description: "Second repository",
            private: true,
            pushed_at: "2026-09-17T12:00:00Z",
            default_branch: "main"
          }
        ]
      }
    },
    "GET /repos/testuser/test-repo": {
      status: 200,
      json: { default_branch: "main" }
    },
    "GET /repos/testuser/test-repo/git/ref/heads/main": {
      status: 200,
      json: { object: { sha: "headcommit12345678" } }
    },
    "GET /repos/testuser/test-repo/git/ref/heads/forge": {
      status: 200,
      json: { object: { sha: "changecommit123456" } }
    },
    "GET /repos/testuser/test-repo/git/commits/headcommit12345678": {
      status: 200,
      json: { tree: { sha: "basetreesha1234567" } }
    },
    "GET /repos/testuser/test-repo/git/commits/changecommit123456": {
      status: 200,
      json: { tree: { sha: "changetreesha9999" } }
    },
    "GET /repos/testuser/test-repo/git/trees/main": {
      status: 200,
      json: {
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", size: 1024 },
          { path: "src/index.ts", type: "blob", size: 4096 },
          { path: "src/utils.ts", type: "blob", size: 2048 }
        ]
      }
    },
    "GET /repos/testuser/test-repo/pulls": {
      status: 200,
      json: [
          {
            head: { ref: "forge" },
            base: { ref: "main" },
            number: 42,
            title: "Improve authentication flow",
            draft: true,
            updated_at: "2026-09-18T10:00:00Z"
          }
      ]
    },
    "GET /repos/testuser/test-repo/contents/README.md": {
      status: 200,
      json: {
        type: "file",
        encoding: "base64",
        content: btoa("# Test Repo\n\nWelcome to test repo."),
        size: 32
      }
    },
    "GET /repos/testuser/test-repo/contents/src/helper.ts": {
      status: 404,
      json: null
    },
    "GET /repos/testuser/test-repo/compare/main...forge": {
      status: 200,
      json: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        files: [
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 5,
            deletions: 1,
            patch: "@@ -1,3 +1,7 @@\n+export const version = \"1.0.0\";"
          }
        ]
      }
    },
    "POST /repos/testuser/test-repo/git/blobs": {
      status: 201,
      json: { sha: "blobsha12345" }
    },
    "POST /repos/testuser/test-repo/git/trees": {
      status: 201,
      json: { sha: "newtreesha67890" }
    },
    "POST /repos/testuser/test-repo/git/commits": {
      status: 201,
      json: { sha: "newcommitsha99999" }
    },
    "PATCH /repos/testuser/test-repo/git/refs/heads/main": {
      status: 200,
      json: { object: { sha: "newcommitsha99999" } }
    },
    "PATCH /repos/testuser/test-repo/git/refs/heads/forge": {
      status: 200,
      json: { object: { sha: "newcommitsha99999" } }
    },
    ...customRoutes
  };

  const gh: GitHubRequest = async (path, init) => {
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push(key);
    const route = routes[key] ?? routes[path.split("?")[0] ?? ""];
    if (!route) {
      return { status: 404, json: null, text: "", headers: new Headers() };
    }
    // A route may be a function when a test needs the response to change
    // between calls — a refusal that a retry then succeeds past.
    const hit = typeof route === "function" ? route() : route;
    return {
      status: hit.status,
      json: hit.json ?? null,
      text: hit.text ?? JSON.stringify(hit.json ?? null),
      headers: new Headers()
    };
  };

  const identity: Identity = {
    userId: "user-test-uuid",
    githubLogin: "testuser",
    installationId: "12345"
  };

  const env = {
    FORGE_ENVIRONMENT: "test",
    FORGE_PUBLIC_ORIGIN: "https://example.com/forge",
    FORGE_SIGNING_KEY: "test-signing-key-that-is-at-least-32-bytes",
    CLOUDFLARE_ACCOUNT_ID: "cf-acc-123",
    CLOUDFLARE_API_TOKEN: "cf-token-123",
    METADATA: {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
              async first() {
                return null;
              }
            };
          }
        };
      }
    },
    ...envOverrides
  } as unknown as Env;

  const server = new McpServer({ name: "Forge", version: "1.0.0" });
  const ctx: ToolContext = {
    env,
    identity,
    track: () => {},
    gh,
    ghUser: gh
  };

  registerTools(server, ctx);
  return { ctx, server, calls };
}

describe("End-to-End Test for all 5 Forge tools", () => {
  it("publishes exactly the five-tool surface", () => {
    const { server } = createMockToolContext();
    expect(Object.keys((server as any)._registeredTools).sort()).toEqual([
      "forge_discard",
      "forge_edit",
      "forge_merge",
      "forge_read",
      "forge_see"
    ]);
  });
  it("executes forge_read across repos, tree, files, and changes", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];
    expect(readTool).toBeDefined();

    // 1. Level 0: List repos
    const listRes = await readTool.handler({});
    expect(listRes.isError).toBeFalsy();
    expect(listRes.content[0].text).toContain("2 repositories");
    expect(listRes.structuredContent.repos).toHaveLength(2);

    // 2. Level 1: Tree of a repo
    const treeRes = await readTool.handler({ repo: "test-repo" });
    expect(treeRes.isError).toBeFalsy();
    expect(treeRes.content[0].text).toContain("testuser/test-repo at main: 3 files");
    expect(treeRes.structuredContent.tree).toContain("src/index.ts");
    expect(treeRes.structuredContent.changes).toEqual(["Improve authentication flow"]);

    // 3. Level 2: Read specific files
    const filesRes = await readTool.handler({ repo: "test-repo", paths: ["README.md"] });
    expect(filesRes.isError).toBeFalsy();
    expect(filesRes.structuredContent.files[0].path).toBe("README.md");
    expect(filesRes.structuredContent.files[0].text).toContain("# Test Repo");

    // 4. Level 3: Read change / diff
    const changeRes = await readTool.handler({ repo: "test-repo", change: "forge" });
    expect(changeRes.isError).toBeFalsy();
    expect(changeRes.content[0].text).toContain("is ahead against main");
    expect(changeRes.structuredContent.diff.files[0].path).toBe("src/index.ts");
  });

  it("keeps existing-repository reads independent of the user OAuth credential", async () => {
    const { server, ctx } = createMockToolContext();
    ctx.ghUser = async () => {
      throw new Error("stale user OAuth must never affect repository reads");
    };
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", paths: ["README.md"] });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.files[0].text).toContain("# Test Repo");
  });

  it("publishes the current direct-write and inline-capture tool contract", () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];
    const seeTool = (server as any)._registeredTools["forge_see"];

    expect(editTool.description).toContain("directly by omitting change");
    expect(editTool.description).toContain("one fixed branch");
    expect(seeTool.description).toContain("images come back with this call");
    expect(seeTool.description).toContain("nothing to fetch afterwards");
  });

  it("does not report zero exact matches when GitHub code search is unavailable", async () => {
    const { server } = createMockToolContext({
      "GET /search/code": {
        status: 429,
        json: { message: "rate limited" }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];
    const res = await readTool.handler({ repo: "test-repo", query: "find:needle" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("No absence conclusion was made");
    expect(res.content[0].text).toContain("was not completed");
    expect(res.structuredContent.tree).toEqual([]);
  });

  it("investigates repository hygiene with GitHub evidence and Jev", async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        questions?: Record<string, unknown>;
      };
      const questions = body.questions ?? {};
      if ("bestMatch" in questions) {
        return {
          ok: true,
          json: async () => ({
            answers: {
              bestMatch: {
                type: "choice",
                choice: "src/legacy-auth.astro",
                confidence: 0.96,
                distribution: { "src/legacy-auth.astro": 0.96 }
              },
              exists: { type: "noul", noul: 0.98 }
            }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          answers: {
            hygieneKind_0: { type: "choice", choice: "legacy/superseded", confidence: 0.94 },
            hygieneInvestigate_0: { type: "noul", noul: 0.97 },
            hygieneBehavior_0: { type: "noul", noul: 0.16 }
          }
        })
      };
    }) as unknown as typeof fetch;

    try {
      const { server } = createMockToolContext(
        {
          "GET /repos/testuser/test-repo/git/trees/main": {
            status: 200,
            json: {
              truncated: false,
              tree: [
                { path: "src/legacy-auth.astro", type: "blob", size: 1800 },
                { path: "sections/retired-cart.liquid", type: "blob", size: 1200 },
                { path: "src/current.ts", type: "blob", size: 900 }
              ]
            }
          },
          "GET /search/code": {
            status: 200,
            json: {
              total_count: 1,
              items: [
                {
                  name: "legacy-auth.astro",
                  path: "src/legacy-auth.astro",
                  repository: { full_name: "testuser/test-repo" },
                  text_matches: [
                    {
                      fragment:
                        "export function legacyAuthenticationAdapter() { return currentAuth(); } // legacy"
                    }
                  ]
                }
              ]
            }
          },
          "GET /repos/testuser/test-repo/contents/src/legacy-auth.astro": {
            status: 200,
            json: {
              type: "file",
              encoding: "base64",
              content: btoa(
                "// Legacy adapter retained during auth migration\nexport function legacyAuthenticationAdapter() { return currentAuth(); }"
              ),
              size: 116
            }
          },
          "GET /repos/testuser/test-repo/commits": {
            status: 200,
            json: [
              {
                sha: "abc123456789",
                commit: {
                  message: "replace legacy authentication",
                  author: { name: "Dev", date: "2026-08-01T10:00:00Z" },
                  committer: { name: "Dev", date: "2026-08-01T10:00:00Z" }
                },
                author: { login: "dev" },
                html_url: "https://github.com/testuser/test-repo/commit/abc123456789"
              }
            ]
          }
        },
        {
          TYPESAFE_API_KEY: "key",
          TYPESAFE_BASE_URL: "https://typesafe.test/systemone"
        }
      );
      const readTool = (server as any)._registeredTools["forge_read"];
      const res = await readTool.handler({ repo: "test-repo", query: "hygiene" });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Jev surfaced 1");
      expect(res.structuredContent.tree[0]).toContain("LEGACY? src/legacy-auth.astro");
      expect(res.structuredContent.tree[0]).toContain("legacyAuthenticationAdapter");
      expect(res.structuredContent.limits.join(" ")).toContain("not proof");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("reports numbered migration history, duplicate prefixes, gaps, and committed checkers", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/git/trees/main": {
        status: 200,
        json: {
          truncated: false,
          tree: [
            { path: "apps/site/migrations/0001_init.sql", type: "blob", size: 10 },
            { path: "apps/site/migrations/0002_users.sql", type: "blob", size: 10 },
            { path: "apps/site/migrations/0002_legacy.sql", type: "blob", size: 10 },
            { path: "apps/site/migrations/0004_orders.sql", type: "blob", size: 10 },
            { path: "scripts/verification/verify-d1-migration-history.mjs", type: "blob", size: 10 }
          ]
        }
      },
      "GET /repos/testuser/test-repo/contents/scripts/verification/verify-d1-migration-history.mjs": {
        status: 200,
        json: {
          type: "file",
          encoding: "base64",
          content: btoa(
            "const LEGACY_DUPLICATE_FILES = new Set(['0002_users.sql', '0002_legacy.sql']);"
          ),
          size: 88
        }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];
    const res = await readTool.handler({ repo: "test-repo", query: "migration safety" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("4 numbered SQL migration files");
    expect(res.content[0].text).toContain("2 structural irregularities");
    expect(res.structuredContent.tree).toContain(
      "DUPLICATE? apps/site/migrations/ · prefix 0002 · apps/site/migrations/0002_legacy.sql, apps/site/migrations/0002_users.sql"
    );
    expect(res.structuredContent.tree).toContain("MISSING? apps/site/migrations/ · 0003");
    expect(res.structuredContent.tree).toContain("CHECKER scripts/verification/verify-d1-migration-history.mjs");
    expect(res.structuredContent.tree).toContain(
      "EXCEPTION? apps/site/migrations/ · prefix 0002 · scripts/verification/verify-d1-migration-history.mjs explicitly names 0002_legacy.sql, 0002_users.sql"
    );
    expect(res.content[0].text).toContain("1 recognized duplicate exception");
    expect(res.content[0].text).toContain("1 unresolved");
    expect(res.structuredContent.files[0].path).toBe(
      "scripts/verification/verify-d1-migration-history.mjs"
    );
  });

  it("executes forge_edit direct commit to default branch", async () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];
    expect(editTool).toBeDefined();

    const res = await editTool.handler({
      repo: "test-repo",
      message: "Update README",
      files: [
        {
          path: "README.md",
          content: "# Updated README\n\nNew content here."
        }
      ]
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Committed 1 file to main in testuser/test-repo");
    expect(res.structuredContent.commit.sha).toBe("newcommitsha99999");
  });

  it("reports history as unknown, not zero, when GitHub will not list commits", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/commits": { status: 500, json: { message: "boom" } }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "history" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("unknown, not zero");
  });

  it("reports churn as unknown, not zero, when history is unreadable", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/commits": { status: 500, json: { message: "boom" } }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "churn" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("unknown, not zero");
  });

  it("reports languages as unknown, not zero, when GitHub will not list them", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/languages": { status: 403, json: { message: "forbidden" } }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "languages" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("unknown, not zero");
  });

  it("reports branch policy as unknown, not empty, when the lookup is refused", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/rules/branches/main": { status: 403, json: { message: "forbidden" } }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "policy" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("unknown rather than empty");
  });

  it("uses a repository that a concurrent first write created first", async () => {
    let exists = false;
    const { server, calls } = createMockToolContext({
      // The repository is absent when the write resolves it, then present the
      // moment the create is refused — the concurrent-writer race.
      "GET /repos/testuser/brand-new": () =>
        exists ? { status: 200, json: { default_branch: "main" } } : { status: 404, json: null },
      "POST /user/repos": () => {
        exists = true;
        return { status: 422, json: { message: "name already exists on this account" } };
      },
      "GET /repos/testuser/brand-new/git/ref/heads/main": { status: 200, json: { object: { sha: "basecommit000001" } } },
      "GET /repos/testuser/brand-new/contents/README.md": { status: 404, json: null },
      "POST /repos/testuser/brand-new/git/blobs": { status: 201, json: { sha: "blobsha00001" } },
      "GET /repos/testuser/brand-new/git/commits/basecommit000001": { status: 200, json: { tree: { sha: "basetree00001" } } },
      "POST /repos/testuser/brand-new/git/trees": { status: 201, json: { sha: "newtree00001" } },
      "POST /repos/testuser/brand-new/git/commits": { status: 201, json: { sha: "newcommit0001" } },
      "PATCH /repos/testuser/brand-new/git/refs/heads/main": { status: 200, json: { object: { sha: "newcommit0001" } } },
      "GET /repos/testuser/brand-new/git/trees/newcommit0001": {
        status: 200,
        json: { truncated: false, tree: [{ path: "README.md", type: "blob", size: 10 }] }
      },
      "GET /repos/testuser/brand-new/pulls": { status: 200, json: [] }
    });
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "testuser/brand-new",
      message: "docs: first write",
      files: [{ path: "README.md", content: "# Brand new\n" }]
    });

    expect(res.isError).toBeFalsy();
    expect(calls).toContain("POST /user/repos");
    expect(res.content[0].text).toContain("testuser/brand-new");
    expect(res.content[0].text).not.toContain("already exists");
  });

  it("preserves cached legacy intent as review work instead of direct-committing", async () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      intent: "Legacy cached client edit",
      files: [{ path: "src/helper.ts", content: "export const legacyBridge = true;" }]
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("on the Forge change");
    expect(res.structuredContent.change).toBe("forge");
    expect(res.structuredContent.limits.join(" ")).toContain("deprecated intent input");
    expect(res.structuredContent.limits.join(" ")).toContain("Refresh the Forge connection");
  });

  it("refuses conflicting current and cached review intents", async () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      change: "Current review intent",
      intent: "Different cached intent",
      message: "test: ambiguous metadata",
      files: [{ path: "src/helper.ts", content: "export const ambiguous = true;" }]
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("both change and deprecated intent");
  });

  it("refuses a direct edit with neither a message nor a legacy review intent", async () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      files: [{ path: "src/helper.ts", content: "export const missingMessage = true;" }]
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Give this edit a commit message");
  });

  it("reviews dependency graph changes after a dependency commit is durable", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/contents/package.json": {
        status: 200,
        json: { type: 'file', encoding: 'base64', content: btoa('{"name":"demo"}'), size: 15 }
      },
      "GET /repos/testuser/test-repo/git/trees/newcommitsha99999": {
        status: 200,
        json: { truncated: false, tree: [{ path: 'package.json', type: 'blob', size: 50 }] }
      },
      "GET /repos/testuser/test-repo/contents/package.json@newcommitsha99999": { status: 404 },
      "GET /repos/testuser/test-repo/git/commits/newcommitsha99999": {
        status: 200,
        json: { tree: { sha: 'newtreesha67890' }, parents: [{ sha: 'parentcommit123' }] }
      },
      "GET /repos/testuser/test-repo/dependency-graph/compare/parentcommit123...newcommitsha99999": {
        status: 200,
        json: [
          {
            change_type: 'added', manifest: 'package.json', ecosystem: 'npm', name: 'unsafe-dep', version: '1.0.0',
            package_url: 'pkg:npm/unsafe-dep@1.0.0', license: 'MIT', scope: 'runtime', source_repository_url: null,
            vulnerabilities: [{ severity: 'high', advisory_ghsa_id: 'GHSA-demo-demo-demo', advisory_summary: 'Demo advisory', advisory_url: 'https://github.com/advisories/GHSA-demo-demo-demo' }]
          }
        ]
      }
    });
    const editTool = (server as any)._registeredTools['forge_edit'];

    const res = await editTool.handler({
      repo: 'test-repo',
      message: 'chore: update dependency manifest',
      files: [{ path: 'package.json', content: '{"name":"demo","dependencies":{"unsafe-dep":"1.0.0"}}' }]
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.limits.some((line: string) => line.includes('Post-commit dependency notice: high GHSA-demo-demo-demo'))).toBe(true);
  });

  it("removes an inert legacy forge/* ref so the fixed forge branch can be created", async () => {
    let createAttempts = 0;
    const { server, calls } = createMockToolContext({
      "GET /repos/testuser/test-repo/git/ref/heads/forge": { status: 404, json: null },
      "GET /repos/testuser/test-repo/git/matching-refs/heads/forge": {
        status: 200,
        json: [{ ref: "refs/heads/forge/duplicate-fragment-smoke", object: { sha: "oldlegacysha0001", type: "commit" } }]
      },
      "GET /repos/testuser/test-repo/compare/headcommit12345678...forge/duplicate-fragment-smoke": {
        status: 200,
        json: { ahead_by: 0, behind_by: 5 }
      },
      "DELETE /repos/testuser/test-repo/git/refs/heads/forge/duplicate-fragment-smoke": { status: 204, json: null },
      // GitHub refuses the fixed name while the legacy ref exists, and accepts
      // it once the cleanup removed it.
      "POST /repos/testuser/test-repo/git/refs": () =>
        (++createAttempts === 1
          ? { status: 422, json: { message: "Reference update failed" } }
          : { status: 201, json: { object: { sha: "headcommit12345678" } } })
    });
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      change: "Add new feature",
      message: "feat: new helper",
      files: [{ path: "src/helper.ts", content: "export const help = true;" }]
    });

    expect(res.isError).toBeFalsy();
    expect(calls).toContain("DELETE /repos/testuser/test-repo/git/refs/heads/forge/duplicate-fragment-smoke");
    expect(res.structuredContent.change).toBe("forge");
    expect(res.structuredContent.limits.join(" ")).toContain("Removed the older unused Forge branch");
  });

  it("refuses when a legacy forge/* branch holds commits not on the default branch", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/git/ref/heads/forge": { status: 404, json: null },
      "GET /repos/testuser/test-repo/git/matching-refs/heads/forge": {
        status: 200,
        json: [{ ref: "refs/heads/forge/duplicate-fragment-smoke", object: { sha: "oldlegacysha0001", type: "commit" } }]
      },
      "GET /repos/testuser/test-repo/compare/headcommit12345678...forge/duplicate-fragment-smoke": {
        status: 200,
        json: { ahead_by: 2, behind_by: 5 }
      },
      "POST /repos/testuser/test-repo/git/refs": { status: 422, json: { message: "Reference update failed" } }
    });
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      change: "Add new feature",
      message: "feat: new helper",
      files: [{ path: "src/helper.ts", content: "export const help = true;" }]
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("older Forge branch forge/duplicate-fragment-smoke");
    expect(res.content[0].text).toContain("a git ref cannot be both a branch and a directory");
  });

  it("executes forge_edit proposing work to the Forge change branch", async () => {
    const { server } = createMockToolContext();
    const editTool = (server as any)._registeredTools["forge_edit"];

    const res = await editTool.handler({
      repo: "test-repo",
      change: "Add new feature",
      message: "feat: new helper",
      files: [
        {
          path: "src/helper.ts",
          content: "export const help = true;"
        }
      ]
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("on the Forge change in testuser/test-repo");
    expect(res.structuredContent.change).toBe("forge");
  });

  it("executes forge_merge returning approval URL with frozen comparison evidence", async () => {
    const { server } = createMockToolContext();
    const mergeTool = (server as any)._registeredTools["forge_merge"];
    expect(mergeTool).toBeDefined();

    const res = await mergeTool.handler({
      repo: "test-repo",
      change: "forge"
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Merging \"Improve authentication flow\" into main brings 1 commit: 1 file");
    expect(res.content[0].text).toContain("https://example.com/forge/approvals/");
    expect(res.structuredContent.approval.url).toContain("https://example.com/forge/approvals/");
  });

  it("executes forge_discard returning approval URL stating loss impact", async () => {
    const { server } = createMockToolContext();
    const discardTool = (server as any)._registeredTools["forge_discard"];
    expect(discardTool).toBeDefined();

    const res = await discardTool.handler({
      repo: "test-repo",
      change: "forge"
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Discarding \"Improve authentication flow\" drops 1 file, +5/-1. 1 commit would stop being reachable.");
    expect(res.content[0].text).toContain("https://example.com/forge/approvals/");
    expect(res.structuredContent.approval.url).toContain("https://example.com/forge/approvals/");
  });

  it("executes forge_see capturing public URL screenshot with quotas and limits", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/browser-rendering/snapshot")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            meta: { title: "Public Example Page" },
            result: {
              screenshot: btoa("fake-png-binary-data"),
              accessibilityTree: { role: "RootWebArea", name: "Public Example Page" }
            }
          })
        };
      }
      return { ok: false, status: 404, text: async () => "" };
    }) as unknown as typeof fetch;

    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/another-repo": {
          status: 200,
          json: { default_branch: "main" }
        },
        "GET /repos/testuser/another-repo/git/trees/main": {
          status: 200,
          json: { truncated: false, tree: [{ path: "README.md", type: "blob" }] }
        },
        "GET /repos/testuser/another-repo/pulls": {
          status: 200,
          json: []
        }
      });
      const seeTool = (server as any)._registeredTools["forge_see"];
      expect(seeTool).toBeDefined();

      const res = await seeTool.handler({
        url: "https://example.org",
        viewports: ["phone", "desktop"]
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Public Example Page");
      expect(res.structuredContent.page.url).toBe("https://example.org/");
      expect(res.structuredContent.page.shown).toEqual(["phone", "desktop"]);
      const imageBlocks = res.content.filter((c: any) => c.type === "image");
      expect(imageBlocks.length).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executes semantic path triage through Jev in forge_read", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/ai/run")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              result: {
                answers: {
                  bestMatch: {
                    type: "choice",
                    choice: "src/index.ts",
                    probabilities: {
                      "src/index.ts": 0.95,
                      "src/utils.ts": 0.05
                    }
                  }
                }
              }
            }
          })
        };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/another-repo": {
          status: 200,
          json: { default_branch: "main" }
        },
        "GET /repos/testuser/another-repo/git/trees/main": {
          status: 200,
          json: { truncated: false, tree: [{ path: "README.md", type: "blob" }] }
        },
        "GET /repos/testuser/another-repo/pulls": {
          status: 200,
          json: []
        }
      }, {
        TYPESAFE_API_KEY: "cfut_mock_token_123",
        TYPESAFE_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/test/ai/run"
      });
      const readTool = (server as any)._registeredTools["forge_read"];

      const res = await readTool.handler({
        repo: "test-repo",
        query: "entry point"
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("semantically ranked by Jev");
      expect(res.structuredContent.tree[0]).toBe("src/index.ts");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads bounded repository history without a checkout", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/commits": {
        status: 200,
        json: [
          {
            sha: "abcdef1234567890",
            html_url: "https://github.com/testuser/test-repo/commit/abcdef1",
            author: { login: "alice" },
            commit: {
              message: "fix: tighten token rotation\n\nmore detail",
              author: { name: "Alice", date: "2026-09-19T10:00:00Z" },
              committer: { name: "Alice", date: "2026-09-19T10:00:00Z" },
              verification: { verified: true }
            }
          }
        ]
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "history src/auth.ts" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("recent commit for src/auth.ts");
    expect(res.structuredContent.tree[0]).toContain("abcdef1 · 2026-09-19 · alice · verified · fix: tighten token rotation");
  });

  it("aggregates bounded recent churn from committed GitHub history", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/commits": {
        status: 200,
        json: [
          { sha: 'aaa111', commit: { message: 'one', author: { date: '2026-09-19T00:00:00Z' } } },
          { sha: 'bbb222', commit: { message: 'two', author: { date: '2026-09-18T00:00:00Z' } } }
        ]
      },
      "GET /repos/testuser/test-repo/commits/aaa111": {
        status: 200,
        json: { files: [{ filename: 'src/hot.ts', additions: 5, deletions: 1 }, { filename: 'src/once.ts', additions: 1, deletions: 0 }] }
      },
      "GET /repos/testuser/test-repo/commits/bbb222": {
        status: 200,
        json: { files: [{ filename: 'src/hot.ts', additions: 3, deletions: 2 }] }
      }
    });
    const readTool = (server as any)._registeredTools['forge_read'];
    const res = await readTool.handler({ repo: 'test-repo', query: 'churn' });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.tree[0]).toBe('HOT src/hot.ts · 2/2 commits · +8/-3');
  });

  it("reads GitHub language byte distribution", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/languages": {
        status: 200,
        json: { TypeScript: 9000, CSS: 1000 }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "languages" });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.tree).toContain("LANG TypeScript · 8.8 KiB · 90.0%");
    expect(res.structuredContent.tree).toContain("LANG CSS · 1000 B · 10.0%");
  });

  it("reports repository size statistics from the Git tree", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "stats" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("3 files");
    expect(res.structuredContent.tree[0]).toContain("TOTAL · 3 files · 0 dirs · 7.0 KiB");
    expect(res.structuredContent.tree.some((line: string) => line.includes("FOLDER src/ · 2 files"))).toBe(true);
  });

  it("scopes repository statistics to a folder", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "stats src" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("under src: 2 files");
    expect(res.structuredContent.tree[0]).toContain("TOTAL · 2 files · 0 dirs · 6.0 KiB");
  });

  it("interprets declared quality gates from committed configuration", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          result: {
            answers: {
              gate_tests: { type: 'choice', choice: '.github/workflows/ci.yml', confidence: 0.94 },
              gate_types: { type: 'choice', choice: 'package.json', confidence: 0.91 },
              gate_lint_format: { type: 'choice', choice: 'none', confidence: 0.8 },
              gate_security: { type: 'choice', choice: 'none', confidence: 0.8 },
              gate_build: { type: 'choice', choice: 'none', confidence: 0.8 },
              gate_deploy: { type: 'choice', choice: 'none', confidence: 0.8 },
              gate_dependencies: { type: 'choice', choice: 'none', confidence: 0.8 }
            }
          }
        }
      })
    }) as unknown as typeof fetch;
    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/test-repo/git/trees/main": {
          status: 200,
          json: {
            truncated: false,
            tree: [
              { path: '.github/workflows/ci.yml', type: 'blob', size: 100 },
              { path: 'package.json', type: 'blob', size: 100 },
              { path: 'src/index.ts', type: 'blob', size: 100 }
            ]
          }
        },
        "GET /repos/testuser/test-repo/contents/.github/workflows/ci.yml": {
          status: 200,
          json: { type: 'file', encoding: 'base64', content: btoa('jobs:\n  prove:\n    steps:\n      - run: pnpm test'), size: 50 }
        },
        "GET /repos/testuser/test-repo/contents/package.json": {
          status: 200,
          json: { type: 'file', encoding: 'base64', content: btoa('{"scripts":{"check":"tsc --noEmit && vitest run"}}'), size: 55 }
        }
      }, {
        TYPESAFE_API_KEY: 'cfut_mock_token_123',
        TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/test/ai/run'
      });
      const readTool = (server as any)._registeredTools['forge_read'];
      const res = await readTool.handler({ repo: 'test-repo', query: 'quality' });

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.tree.some((line: string) => line.includes('SCRIPT package.json · check'))).toBe(true);
      expect(res.structuredContent.tree).toContain('LIKELY GATE tests · .github/workflows/ci.yml · 94%');
      expect(res.structuredContent.tree).toContain('LIKELY GATE types · package.json · 91%');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps repository areas and likely entry points from committed paths", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "map" });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.tree.some((line: string) => line.includes("AREA source · 2 files"))).toBe(true);
    expect(res.structuredContent.tree).toContain("ENTRY? src/index.ts");
  });

  it("finds exact committed code inside one repository", async () => {
    const { server } = createMockToolContext({
      "GET /search/code": {
        status: 200,
        json: {
          total_count: 1,
          items: [
            {
              name: "index.ts",
              path: "src/index.ts",
              html_url: "https://github.com/testuser/test-repo/blob/main/src/index.ts",
              repository: { full_name: "testuser/test-repo", description: "A test repository" },
              text_matches: [{ fragment: "export const version = \"1.0.0\";" }]
            }
          ]
        }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "find:version" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Found 1 committed code result");
    expect(res.structuredContent.tree).toEqual(["src/index.ts"]);
    expect(res.structuredContent.files[0].text).toContain("version");
  });

  it("searches committed code semantically inside one repository", async () => {
    const { server } = createMockToolContext({
      "GET /search/code": {
        status: 200,
        json: {
          total_count: 1,
          items: [
            {
              name: "index.ts",
              path: "src/index.ts",
              html_url: "https://github.com/testuser/test-repo/blob/main/src/index.ts",
              repository: { full_name: "testuser/test-repo", description: "A test repository" },
              text_matches: [{ fragment: "export async function refreshAccessToken() {}" }]
            }
          ]
        }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "code:refresh access token" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("committed-code result");
    expect(res.structuredContent.tree).toEqual(["src/index.ts"]);
  });

  it("falls back from unhelpful filenames to committed-code search", async () => {
    const { server } = createMockToolContext({
      "GET /search/code": {
        status: 200,
        json: {
          total_count: 1,
          items: [
            {
              name: "utils.ts",
              path: "src/utils.ts",
              html_url: "https://github.com/testuser/test-repo/blob/main/src/utils.ts",
              repository: { full_name: "testuser/test-repo", description: "A test repository" },
              text_matches: [{ fragment: "export function rotateCredential() {}" }]
            }
          ]
        }
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "rotateCredential" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("committed-code fallback after no filename match");
    expect(res.structuredContent.tree).toEqual(["src/utils.ts"]);
    expect(res.structuredContent.files[0].text).toContain("rotateCredential");
  });

  it("reads dependency changes and vulnerabilities from GitHub's dependency graph", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/dependency-graph/compare/main...forge": {
        status: 200,
        json: [
          {
            change_type: "added",
            manifest: "package.json",
            ecosystem: "npm",
            name: "example-package",
            version: "2.0.0",
            package_url: "pkg:npm/example-package@2.0.0",
            license: "MIT",
            scope: "runtime",
            source_repository_url: "https://github.com/example/package",
            vulnerabilities: [
              {
                severity: "high",
                advisory_ghsa_id: "GHSA-xxxx-yyyy-zzzz",
                advisory_summary: "Example vulnerability",
                advisory_url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz"
              }
            ]
          }
        ]
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", change: "forge", query: "dependencies" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("1 added, 0 removed; 1 vulnerability finding");
    expect(res.structuredContent.files[0].text).toContain("high GHSA-xxxx-yyyy-zzzz");
  });

  it("routes a natural repository question to branch-policy evidence", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          result: {
            answers: {
              evidenceMode: {
                type: 'choice', choice: 'policy', confidence: 0.93,
                probabilities: { policy: 0.93, quality: 0.04 }
              },
              shouldRoute: { type: 'noul', noul: 0.97 }
            }
          }
        }
      })
    }) as unknown as typeof fetch;
    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/test-repo/rules/branches/main": {
          status: 200,
          json: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI' }] } }]
        }
      }, {
        TYPESAFE_API_KEY: 'cfut_mock_token_123',
        TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/test/ai/run'
      });
      const readTool = (server as any)._registeredTools['forge_read'];
      const res = await readTool.handler({ repo: 'test-repo', query: 'what checks and rules protect merges here?' });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('required checks: CI');
      expect(res.structuredContent.limits.some((line: string) => line.includes('routed this natural-language question to policy evidence'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads active branch policy and required status-check names", async () => {
    const { server } = createMockToolContext({
      "GET /repos/testuser/test-repo/rules/branches/main": {
        status: 200,
        json: [
          {
            type: "required_status_checks",
            ruleset_source_type: "Repository",
            ruleset_source: "testuser/test-repo",
            parameters: {
              required_status_checks: [{ context: "CI / check" }, { context: "Security" }],
              strict_required_status_checks_policy: true
            }
          },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              require_code_owner_review: true,
              required_review_thread_resolution: true
            }
          }
        ]
      }
    });
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", query: "policy" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("required checks: CI / check, Security");
    expect(res.structuredContent.tree[0]).toContain("required_status_checks");
  });

  it("builds a read-only review packet before merge approval", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          result: {
            answers: {
              primaryArea: { type: 'choice', choice: 'authentication/security', confidence: 0.95 },
              matchesIntent: { type: 'noul', noul: 0.9 },
              breakingChange: { type: 'noul', noul: 0.1 },
              securitySensitive: { type: 'noul', noul: 0.95 },
              persistentDataChange: { type: 'noul', noul: 0.1 },
              userVisible: { type: 'noul', noul: 0.5 },
              testsRelevant: { type: 'noul', noul: 0.9 },
              docsRelevant: { type: 'noul', noul: 0.2 },
              multipleConcerns: { type: 'noul', noul: 0.1 },
              hasOutlier: { type: 'noul', noul: 0.1 }
            }
          }
        }
      })
    }) as unknown as typeof fetch;
    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/test-repo/rules/branches/main": {
          status: 200,
          json: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]
        },
        "GET /repos/testuser/test-repo/pulls/42": {
          status: 200,
          json: { mergeable: true, draft: true }
        },
        "GET /repos/testuser/test-repo/pulls/42/reviews": {
          status: 200,
          json: [{ state: 'APPROVED', user: { login: 'reviewer' } }]
        }
      }, {
        TYPESAFE_API_KEY: 'cfut_mock_token_123',
        TYPESAFE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/test/ai/run'
      });
      const readTool = (server as any)._registeredTools['forge_read'];
      const res = await readTool.handler({ repo: 'test-repo', change: 'forge', query: 'review' });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('Authentication/security');
      expect(res.structuredContent.tree).toContain('POLICY approvals · 1 required');
      expect(res.structuredContent.tree.some((line: string) => line.includes('REVIEWS approvals 1'))).toBe(true);
      expect(res.structuredContent.limits.some((line: string) => line.includes('security-sensitive'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports change hotspots without semantic guessing", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];

    const res = await readTool.handler({ repo: "test-repo", change: "forge", query: "stats" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("hotspots src/ 1 file +5/-1");
    expect(res.structuredContent.diff.files[0].path).toBe("src/index.ts");
  });

  it("enriches semantic change ranking with bounded diff patches", async () => {
    const originalFetch = globalThis.fetch;
    let sawPatchSnippet = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/ai/run")) {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.includes("patchSnippet") && body.includes("refreshAccessToken")) sawPatchSnippet = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              result: {
                answers: {
                  relevantFiles: {
                    type: "choice",
                    choice: "src/auth.ts",
                    probabilities: { "src/auth.ts": 0.95, "src/ui.ts": 0.05 }
                  }
                }
              }
            }
          })
        };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      const { server, calls } = createMockToolContext({
        "GET /repos/testuser/test-repo/compare/main...forge": {
          status: 200,
          json: {
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            files: [
              {
                filename: "src/ui.ts",
                status: "modified",
                additions: 2,
                deletions: 1,
                patch: "@@ -1 +1 @@\\n-export const label = 'old';\\n+export const label = 'new';"
              },
              {
                filename: "src/auth.ts",
                status: "modified",
                additions: 4,
                deletions: 2,
                patch: "@@ -1 +1 @@\\n-export const token = old;\\n+export async function refreshAccessToken() {}"
              }
            ]
          }
        }
      }, {
        TYPESAFE_API_KEY: "cfut_mock_token_123",
        TYPESAFE_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/test/ai/run"
      });
      const readTool = (server as any)._registeredTools["forge_read"];

      const res = await readTool.handler({ repo: "test-repo", change: "forge", query: "token refresh" });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('diff-ranked for "token refresh"');
      expect(res.structuredContent.diff.files[0].path).toBe("src/auth.ts");
      expect(calls.filter((call) => call.includes("/compare/")).length).toBe(2);
      expect(sawPatchSnippet).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("executes targeted file excerpt through Jev in forge_read", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/ai/run")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              result: {
                answers: {
                  found: { type: "noul", noul: 0.9 },
                  line_window: {
                    type: "choice",
                    choice: "1-10",
                    confidence: 0.95
                  }
                }
              }
            }
          })
        };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/another-repo": {
          status: 200,
          json: { default_branch: "main" }
        },
        "GET /repos/testuser/another-repo/git/trees/main": {
          status: 200,
          json: { truncated: false, tree: [{ path: "README.md", type: "blob" }] }
        },
        "GET /repos/testuser/another-repo/pulls": {
          status: 200,
          json: []
        }
      }, {
        TYPESAFE_API_KEY: "cfut_mock_token_123",
        TYPESAFE_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/test/ai/run"
      });
      const readTool = (server as any)._registeredTools["forge_read"];

      const res = await readTool.handler({
        repo: "test-repo",
        paths: ["README.md"],
        query: "welcome message"
      });

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.limits[0]).toContain("Targeted excerpt for 'welcome message'");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  it("resolves repo with spaces via normalized alphanumeric matching (e.g. easy roads -> EasyRoads)", async () => {
    const { server } = createMockToolContext();
    const readTool = (server as any)._registeredTools["forge_read"];

    // Input has space: "test repo" should resolve to "testuser/test-repo"
    const treeRes = await readTool.handler({ repo: "test repo" });
    expect(treeRes.isError).toBeFalsy();
    expect(treeRes.content[0].text).toContain("testuser/test-repo at main");

    // Input with owner and space: "testuser/test repo" should also resolve
    const treeRes2 = await readTool.handler({ repo: "testuser/test repo" });
    expect(treeRes2.isError).toBeFalsy();
    expect(treeRes2.content[0].text).toContain("testuser/test-repo at main");
  });

  it("resolves repo via Jev semantic matching when natural phrasing is used", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/ai/run")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: {
              result: {
                answers: {
                  matchedRepo: {
                    type: "choice",
                    choice: "testuser/another-repo",
                    confidence: 0.92
                  },
                  confidence: {
                    type: "noul",
                    noul: 0.92
                  }
                }
              }
            }
          })
        };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      const { server } = createMockToolContext({
        "GET /repos/testuser/another-repo": {
          status: 200,
          json: { default_branch: "main" }
        },
        "GET /repos/testuser/another-repo/git/trees/main": {
          status: 200,
          json: { truncated: false, tree: [{ path: "README.md", type: "blob" }] }
        },
        "GET /repos/testuser/another-repo/pulls": {
          status: 200,
          json: []
        }
      }, {
        TYPESAFE_API_KEY: "cfut_mock_token_123",
        TYPESAFE_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/test/ai/run"
      });
      const readTool = (server as any)._registeredTools["forge_read"];

      const res = await readTool.handler({
        repo: "the private secondary repo"
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("testuser/another-repo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});
