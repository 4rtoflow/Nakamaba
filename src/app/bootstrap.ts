import type { Deps } from './deps.ts';
import { writeStaticPages } from './publish.ts';
import { createUser } from './users.ts';

/** 管理画面にまだ入れない最初の Admin を作り、公開側のトップと 404 を置く */
export async function bootstrapAdmin(
  deps: Pick<Deps, 'users' | 'pages' | 'secrets' | 'siteFiles' | 'now'>,
  name: string,
): Promise<{ password: string }> {
  const { password } = await createUser(deps, name, 'admin');
  await writeStaticPages(deps);
  return { password };
}
