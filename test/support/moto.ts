import { execFileSync } from 'node:child_process';

const IMAGE = 'motoserver/moto:5.2.5';

export interface MotoServer {
  endpoint: string;
  stop(): void;
}

async function waitUntilReady(endpoint: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/moto-api/`);
      if (response.ok) return;
    } catch {
      // 起動を待つ
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('moto が起動しませんでした');
}

/** AWS の模擬サーバーを Docker で起動する。MOTO_ENDPOINT があれば、それを使う。 */
export async function startMoto(): Promise<MotoServer> {
  const given = process.env.MOTO_ENDPOINT;
  if (given) return { endpoint: given, stop: () => {} };

  const container = execFileSync(
    'docker',
    ['run', '-d', '--rm', '-p', '127.0.0.1::5000', '--label', 'nakamaba-test=1', IMAGE],
    { encoding: 'utf8' },
  ).trim();
  const port = execFileSync('docker', ['port', container, '5000/tcp'], { encoding: 'utf8' })
    .trim()
    .split(':')
    .at(-1);
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = () => {
    try {
      execFileSync('docker', ['stop', '-t', '1', container], { stdio: 'ignore' });
    } catch {
      // 既に止まっている
    }
  };
  try {
    await waitUntilReady(endpoint);
  } catch (error) {
    stop();
    throw error;
  }
  return { endpoint, stop };
}
