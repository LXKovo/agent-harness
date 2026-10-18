import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createCheckpointStore(filePath) {
  const path = resolve(filePath);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const latestIds = new Map();
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      task TEXT NOT NULL,
      project_id TEXT,
      allow_shell INTEGER NOT NULL,
      sandbox INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      phase TEXT NOT NULL,
      turns_used INTEGER NOT NULL,
      pending_call_id TEXT,
      messages_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id, id);
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
      project_id TEXT NOT NULL,
      task TEXT NOT NULL,
      answer TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS memory_episodes_project ON memory_episodes(project_id, id DESC);
  `);
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'project_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT');
  }
  // 沙箱标记是后加的：旧库里的会话一律视为「没有沙箱」
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((column) => column.name === 'sandbox')) {
    db.exec('ALTER TABLE sessions ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0');
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function append(sessionId, state) {
    return db.prepare(`INSERT INTO checkpoints
      (session_id, phase, turns_used, pending_call_id, messages_json)
      VALUES (?, ?, ?, ?, ?)`).run(
      sessionId, state.phase, state.turnsUsed, state.pendingCallId ?? null,
      JSON.stringify(state.messages),
    ).lastInsertRowid;
  }

  return {
    path,
    create({ id, workspace, task, allowShell, sandbox = false, projectId = null, state }) {
      const checkpointId = transaction(() => {
        db.prepare(`INSERT INTO sessions (id, workspace, task, project_id, allow_shell, sandbox, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(
          id, workspace, task, projectId, Number(allowShell), Number(sandbox));
        return append(id, state);
      });
      latestIds.set(id, checkpointId);
    },
    load(id) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) throw new Error(`会话不存在: ${id}`);
      const snapshot = db.prepare(`SELECT id, phase, turns_used, pending_call_id, messages_json
        FROM checkpoints WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(id);
      if (!snapshot) throw new Error(`会话缺少 checkpoint: ${id}`);
      latestIds.set(id, snapshot.id);
      return {
        id: session.id, workspace: session.workspace, task: session.task,
        projectId: session.project_id,
        allowShell: Boolean(session.allow_shell), sandbox: Boolean(session.sandbox), status: session.status,
        answer: session.answer,
        state: {
          phase: snapshot.phase, turnsUsed: snapshot.turns_used,
          pendingCallId: snapshot.pending_call_id,
          messages: JSON.parse(snapshot.messages_json),
        },
      };
    },
    save(id, state, status = 'active', answer = null, episode = null) {
      const checkpointId = transaction(() => {
        const current = db.prepare(`SELECT id FROM checkpoints
          WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(id);
        if (current?.id !== latestIds.get(id)) {
          throw new Error(`会话已由其他进程修改: ${id}`);
        }
        const updated = db.prepare(`UPDATE sessions SET status = ?, answer = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, answer, id);
        if (updated.changes !== 1) throw new Error(`会话不存在: ${id}`);
        const nextId = append(id, state);
        if (episode) {
          if (status !== 'completed') throw new Error('只能为已完成的会话保存情景记忆');
          const session = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(id);
          if (!session.project_id) throw new Error('会话没有项目 ID，不能保存情景记忆');
          db.prepare(`INSERT INTO memory_episodes
            (session_id, project_id, task, answer, tools_json) VALUES (?, ?, ?, ?, ?)`).run(
            id, session.project_id, episode.task, episode.answer, JSON.stringify(episode.toolNames),
          );
        }
        return nextId;
      });
      latestIds.set(id, checkpointId);
    },
    recentEpisodes(projectId, limit = 200) {
      return db.prepare(`SELECT id, session_id, task, answer, tools_json, created_at
        FROM memory_episodes WHERE project_id = ? ORDER BY id DESC LIMIT ?`)
        .all(projectId, limit).map((row) => ({
          id: row.id, sessionId: row.session_id, task: row.task, answer: row.answer,
          toolNames: JSON.parse(row.tools_json), createdAt: row.created_at,
        }));
    },
    close() { db.close(); },
  };
}
