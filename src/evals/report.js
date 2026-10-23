import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function writeEvalReport({ runs, model, startedAt, reportDir = 'eval-results' }) {
  const finishedAt = new Date();
  const results = runs.flatMap((run) => run.results);
  const passedCount = results.filter((result) => result.passed).length;
  // 跨重复轮次汇总压缩证据：这里统计的是「文件-轮次」，不是去重后的文件数。
  // 重读率回答的是「被省略的读取里有多大比例又去读了」，比单次绝对值更能说明压缩是否伤害任务。
  const omittedFiles = results.reduce((total, result) => total + (result.compression?.omittedFiles ?? 0), 0);
  const rereadFiles = results.reduce((total, result) => total + (result.compression?.rereadFiles ?? 0), 0);
  const report = {
    schemaVersion: 2,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    model,
    repeatCount: runs.length,
    summary: {
      passed: passedCount === results.length,
      passedCount,
      totalCount: results.length,
      successRate: results.length ? passedCount / results.length : 0,
      compression: {
        runsWithCompaction: results.filter((result) => (result.compression?.compactionCount ?? 0) > 0).length,
        omittedFiles,
        rereadFiles,
        rereadRate: omittedFiles ? rereadFiles / omittedFiles : null,
        omittedToolResults: results.reduce(
          (total, result) => total + (result.compression?.omittedToolResults ?? 0), 0,
        ),
        contextLimitRuns: results.filter((result) => result.status === 'context_limit').length,
      },
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
