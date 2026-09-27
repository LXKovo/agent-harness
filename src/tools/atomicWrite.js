import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 在目标同目录写临时文件后替换，避免覆盖中途留下半份内容。 */
export async function replaceFileAtomically(target, content, mode = 0o666) {
  const temp = join(dirname(target), `.agent-harness-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temp, 'wx', mode);
    created = true;
    try {
      await file.writeFile(content, { encoding: 'utf8' });
    } finally {
      await file.close();
    }
    await rename(temp, target);
  } finally {
    if (created) await rm(temp, { force: true });
  }
}
