import { describe, expect, it, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolContext } from "../src/tools";
import type { GitHubRequest, Identity } from "../src/contracts";
import type { Env } from "../src/env";
import { lintCommittedFiles } from "../src/repository-intelligence";

function ok(json: any, status = 200) {
  return {
    status,
    json,
    text: JSON.stringify(json),
    headers: new Headers()
  };
}

function createInMemoryForgeEnvironment() {
  const repoStore = new Map<string, {
    defaultBranch: string;
    files: Map<string, string>;
    branches: Map<string, Map<string, string>>;
    pulls: any[];
  }>();

  // Seed with one existing repo
  const initialFiles = new Map<string, string>();
  initialFiles.set("README.md", "# Demo Project\n\nProduction application.");
  initialFiles.set("src/index.ts", "import { config } from './config';\nexport function run() { return config.port; }");
  initialFiles.set("src/config.ts", "export const config = { port: 8080 };");

  repoStore.set("timc0y/demo-app", {
    defaultBranch: "main",
    files: initialFiles,
    branches: new Map(),
    pulls: [
      {
        number: 1,
        head: { ref: "forge" },
        base: { ref: "main" },
        draft: true,
        title: "Initial draft change",
        updated_at: "2026-09-18T12:00:00Z"
      }
    ]
  });

  const fakeGh: GitHubRequest = async (path, init) => {
    const method = init?.method ?? "GET";
    const cleanPath = path.split("?")[0] ?? "";

    // List installed repos
    if (method === "GET" && cleanPath === "/installation/repositories") {
      const repos = Array.from(repoStore.keys()).map((fullName) => {
        const [owner, name] = fullName.split("/");
        return {
          name: name ?? "",
          owner: { login: owner ?? "" },
          full_name: fullName,
          default_branch: "main",
          pushed_at: "2026-09-18T12:00:00Z"
        };
      });
      return ok({ total_count: repos.length, repositories: repos });
    }

    // Get repo metadata
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(cleanPath);
    if (method === "GET" && repoMatch && repoMatch[1] && repoMatch[2]) {
      const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
      const repo = repoStore.get(fullName);
      if (!repo) return ok({ message: "Not Found" }, 404);
      return ok({
        name: repoMatch[2],
        owner: { login: repoMatch[1] },
        full_name: fullName,
        default_branch: repo.defaultBranch
      });
    }

    // Git references
    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(cleanPath);
    if (method === "GET" && refMatch && refMatch[1] && refMatch[2] && refMatch[3]) {
      const fullName = `${refMatch[1]}/${refMatch[2]}`;
      const branchName = refMatch[3];
      const repo = repoStore.get(fullName);
      if (!repo) return ok(null, 404);
      if (branchName === repo.defaultBranch || branchName === "forge" || repo.branches.has(branchName)) {
        return ok({ object: { sha: `sha-${branchName}-12345` } });
      }
      return ok(null, 404);
    }

    // Git trees
    const treeMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/(.+)$/.exec(cleanPath);
    if (method === "GET" && treeMatch && treeMatch[1] && treeMatch[2] && treeMatch[3]) {
      const fullName = `${treeMatch[1]}/${treeMatch[2]}`;
      const ref = treeMatch[3];
      const repo = repoStore.get(fullName);
      if (!repo) return ok(null, 404);
      const fileMap = ref === repo.defaultBranch ? repo.files : (repo.branches.get(ref) ?? repo.files);
      const treeEntries = Array.from(fileMap.keys()).map((filePath) => ({
        path: filePath,
        type: "blob"
      }));
      return ok({ truncated: false, tree: treeEntries });
    }

    // Contents API
    const contentMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(cleanPath);
    if (method === "GET" && contentMatch && contentMatch[1] && contentMatch[2] && contentMatch[3]) {
      const fullName = `${contentMatch[1]}/${contentMatch[2]}`;
      const filePath = decodeURIComponent(contentMatch[3]);
      const repo = repoStore.get(fullName);
      if (!repo) return ok(null, 404);
      const content = repo.files.get(filePath);
      if (content === undefined) return ok(null, 404);
      return ok({
        type: "file",
        encoding: "base64",
        content: btoa(content),
        size: content.length
      });
    }

    // Pull requests
    const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(cleanPath);
    if (method === "GET" && pullsMatch && pullsMatch[1] && pullsMatch[2]) {
      const fullName = `${pullsMatch[1]}/${pullsMatch[2]}`;
      const repo = repoStore.get(fullName);
      return ok(repo?.pulls ?? []);
    }
    if (method === "POST" && pullsMatch && pullsMatch[1] && pullsMatch[2]) {
      const fullName = `${pullsMatch[1]}/${pullsMatch[2]}`;
      const repo = repoStore.get(fullName);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      const pr = {
        number: (repo?.pulls.length ?? 0) + 1,
        head: { ref: body.head },
        base: { ref: body.base },
        draft: true,
        title: body.title,
        updated_at: "2026-09-18T12:00:00Z"
      };
      repo?.pulls.push(pr);
      return ok(pr, 201);
    }

    // Compare
    const compareMatch = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)\.\.\.(.+)$/.exec(cleanPath);
    if (method === "GET" && compareMatch) {
      return ok({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        files: [
          {
            status: "modified",
            filename: "src/config.ts",
            additions: 3,
            deletions: 1,
            patch: "@@ -1 +1,3 @@\n-export const config = { port: 8080 };\n+export const config = { port: 9090, debug: true };"
          }
        ]
      });
    }

    // Commit creation (blobs, trees, commits, refs)
    if (method === "POST" && cleanPath.includes("/git/blobs")) {
      return ok({ sha: "newblob" + Math.random().toString(36).slice(2, 8) }, 201);
    }
    if (method === "POST" && cleanPath.includes("/git/trees")) {
      return ok({ sha: "newtree" + Math.random().toString(36).slice(2, 8) }, 201);
    }
    if (method === "POST" && cleanPath.includes("/git/commits")) {
      return ok({ sha: "newcommit" + Math.random().toString(36).slice(2, 8) }, 201);
    }
    const commitMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/(.+)$/.exec(cleanPath);
    if (method === "GET" && commitMatch) {
      return ok({ sha: commitMatch[3], tree: { sha: "tree-" + commitMatch[3] } });
    }
    if (method === "PATCH" && cleanPath.includes("/git/refs/heads/")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return ok({ object: { sha: body?.sha ?? "commit-sha" } });
    }
    if (method === "POST" && cleanPath.includes("/git/refs")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      return ok({ object: { sha: body?.sha ?? "commit-sha" } }, 201);
    }

    // Default fallback
    return ok({});
  };

  const mockEnv = {
    METADATA: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              async run() { return { meta: { changes: 1 } }; },
              async first() {
                if (sql.includes("SELECT") && sql.includes("approvals")) {
                  return {
                    id: args[0],
                    act: "merge",
                    repo: "timc0y/demo-app",
                    change_branch: "forge",
                    head_sha: "head123",
                    base_branch: "main",
                    state: "pending",
                    token_hash: "hash",
                    user_id: "user_tim",
                    expires_at: "2026-09-19T00:00:00Z"
                  };
                }
                return null;
              }
            };
          }
        };
      }
    } as any,
    FORGE_PUBLIC_ORIGIN: "https://timcoy.uk/forge",
    FORGE_SIGNING_KEY: "test-signing-key-must-be-very-secure-32-bytes-minimum",
    SESSION_SECRET: "test-session-secret-must-be-secure-32-bytes-minimum",
    TYPESAFE_API_KEY: "cfut_test_key",
    TYPESAFE_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/test/ai/run"
  } as unknown as Env;

  const identity: Identity = {
    userId: "user_tim",
    githubLogin: "timc0y",
    installationId: "inst_12345"
  };

  const toolContext: ToolContext = {
    env: mockEnv,
    gh: fakeGh,
    ghUser: fakeGh,
    identity,
    track: () => {}
  };

  const server = new McpServer({ name: "forge", version: "1.0.0" });
  registerTools(server, toolContext);

  return { server, repoStore, fakeGh, toolContext };
}

describe("In-Depth Forge End-to-End Suite", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("1. Full read-edit-merge-inspect lifecycle across tools", async () => {
    const { server } = createInMemoryForgeEnvironment();
    const readTool = (server as any)._registeredTools["forge_read"];
    const editTool = (server as any)._registeredTools["forge_edit"];
    const mergeTool = (server as any)._registeredTools["forge_merge"];

    // 1a. List repositories
    const listRes = await readTool.handler({});
    expect(listRes.isError).toBeFalsy();
    expect(listRes.structuredContent.repos[0].repo).toBe("timc0y/demo-app");

    // 1b. Inspect demo repo tree
    const treeRes = await readTool.handler({ repo: "demo-app" });
    expect(treeRes.isError).toBeFalsy();
    expect(treeRes.structuredContent.tree).toContain("README.md");
    expect(treeRes.structuredContent.tree).toContain("src/index.ts");

    // 1c. Read file contents with line range
    const fileRes = await readTool.handler({ repo: "demo-app", paths: ["README.md:1-2"] });
    expect(fileRes.isError).toBeFalsy();
    expect(fileRes.structuredContent.files[0].text).toContain("Demo Project");

    // 1d. Propose a change via forge_edit
    const editRes = await editTool.handler({
      repo: "demo-app",
      change: "Update server port to 9090",
      message: "feat(config): update port to 9090",
      files: [
        {
          path: "src/config.ts",
          content: "export const config = { port: 9090, debug: true };"
        }
      ]
    });
    expect(editRes.isError).toBeFalsy();
    expect(editRes.structuredContent.change).toBe("forge");

    // 1e. Request approval via forge_merge
    const mergeRes = await mergeTool.handler({
      repo: "demo-app",
      change: "forge"
    });
    expect(mergeRes.isError).toBeFalsy();
    expect(mergeRes.structuredContent.approval.url).toContain("https://timcoy.uk/forge/approvals/");
    expect(mergeRes.content[0].text).toContain("Merging \"Initial draft change\" into main brings 1 commit: 1 file");
  });

  it("3. Committed-file lint detects dangling imports", async () => {
    const lintWarnings = await lintCommittedFiles(
      [{ path: "src/main.ts", content: "import { auth } from './auth/index';" }],
      ["src/main.ts", "package.json"]
    );
    expect(lintWarnings).toHaveLength(1);
    expect(lintWarnings[0]).toContain("imports \"./auth/index\"");
  });

  it("4. Visual diagnosis (judgeSeePacket) correctly handles landmarks and error walls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answers: {
          isError: { type: "noul", noul: 0.99 },
          exists: { type: "noul", noul: 0.05 },
          suspect: { type: "choice", choice: "L1" },
          pageType: { type: "choice", choice: "error" }
        }
      })
    }) as unknown as typeof fetch;

    const { judgeSeePacket } = await import("../src/jev");
    const pointer = await judgeSeePacket(
      { TYPESAFE_API_KEY: "key" } as unknown as Env,
      "https://example.com/500",
      "500 Internal Server Error",
      ["heading: 500 Internal Server Error", "text: Something went wrong"]
    );

    expect(pointer?.isErrorPage).toBe(true);
    expect(pointer?.next).toBe("stop");
    expect(pointer?.pageType).toBe("error");
  });
  it("5. forge_discard creates approval URL with clear loss impact", async () => {
    const { server } = createInMemoryForgeEnvironment();
    const discardTool = (server as any)._registeredTools["forge_discard"];
    expect(discardTool).toBeDefined();

    const res = await discardTool.handler({
      repo: "demo-app",
      change: "forge"
    });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.approval.url).toContain("https://timcoy.uk/forge/approvals/");
    expect(res.content[0].text).toContain("Discarding \"forge\" drops 1 file");
  });

  it("6. Boundaries: forge_edit rejects payloads violating strict file count bounds", async () => {
    const { server } = createInMemoryForgeEnvironment();
    const editTool = (server as any)._registeredTools["forge_edit"];

    const tooManyFiles = Array.from({ length: 11 }, (_, i) => ({
      path: `file-${i}.ts`,
      content: "export const x = 1;"
    }));

    const res = await editTool.handler({
      repo: "demo-app",
      message: "bulk update",
      files: tooManyFiles
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("at most 10 can be written per call");
  });
});
