import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const output = process.argv[2] ?? 'forge-analysis.json';
const sourceSha = process.env.FORGE_ANALYSIS_SOURCE_SHA;
const runId = Number(process.env.FORGE_ANALYSIS_RUN_ID);
const runAttempt = Number(process.env.FORGE_ANALYSIS_RUN_ATTEMPT);
const workflowPath = process.env.FORGE_ANALYSIS_WORKFLOW_PATH;
const configurationHash = process.env.FORGE_ANALYSIS_CONFIGURATION_HASH;
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha) || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(runAttempt) || runAttempt < 1 || !workflowPath || !configurationHash) {
  throw new Error('Forge analysis provenance environment is incomplete.');
}

const configPath = path.resolve('tsconfig.json');
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, process.cwd(), undefined, configPath);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = ts.getPreEmitDiagnostics(program);
const findings = diagnostics.flatMap((diagnostic) => {
  if (!diagnostic.file || diagnostic.start === undefined) return [];
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const relative = path.relative(process.cwd(), diagnostic.file.fileName).replaceAll(path.sep, '/');
  if (!relative || relative.startsWith('../')) return [];
  return [{
    kind: 'diagnostic',
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, 1500),
    location: { path: relative, line: position.line + 1 },
    tool: 'typescript'
  }];
});

const result = {
  schemaVersion: 1,
  sourceSha,
  runId,
  runAttempt,
  workflowPath,
  configurationHash,
  coverage: 'complete',
  tools: [{ name: 'typescript', version: ts.version }],
  findings,
  relationships: [],
  limitations: ['TypeScript diagnostics only. This artifact does not claim runtime, test, unused-code or cross-language coverage.']
};
fs.writeFileSync(output, JSON.stringify(result));
