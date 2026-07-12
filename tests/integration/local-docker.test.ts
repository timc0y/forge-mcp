import { describe, it } from 'vitest';
import { LocalDockerSandboxProvider, localDockerAvailable } from '@forge/sandbox-local-docker';
import { exerciseSandboxProvider } from '../contract/sandbox-provider';

const available = await localDockerAvailable();
describe.skipIf(!available)('LocalDockerSandboxProvider contract', () => {
  it('supports the provider contract', async () => {
    await exerciseSandboxProvider(new LocalDockerSandboxProvider());
  }, 180_000);
});
