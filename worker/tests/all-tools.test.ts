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
          { path: "README.md", type: "blob" },
          { path: "src/index.ts", type: "blob" },
          { path: "src/utils.ts", type: "blob" }
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
    const hit = routes[key] ?? routes[path.split("?")[0] ?? ""];
    if (!hit) {
      return { status: 404, json: null, text: "", headers: new Headers() };
    }
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
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
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
    expect(treeRes.structuredContent.changes).toEqual(["forge"]);

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
    expect(res.content[0].text).toContain("Merging \"forge\" into main brings 1 commit: 1 file");
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
    expect(res.content[0].text).toContain("Discarding \"forge\" drops 1 file, +5/-1. 1 commit would stop being reachable.");
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
      }, {
        ARTIFACTS: {
          async put() {},
          async get() { return null; },
          async delete() {}
        } as any
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
