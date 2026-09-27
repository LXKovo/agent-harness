import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function writeEvalReport({ runs, model, startedAt, reportDir = 'eval-results' }) {
  const finishedAt = new Date();
  const results = runs.flatMap((run) => run.results);
  const passedCount = results.filter((result) => result.passed).length;
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model,
    repeatCount: runs.length,
    summary: {
      passed: passedCount === results.length,
      passedCount,
      totalCount: results.length,
      successRate: results.length ? passedCount / results.length : 0,
    },
    runs,
  };
  const directory = resolve(reportDir);
  await mkdir(directory, { recursive: true });
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { path, report };
}
