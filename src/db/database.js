// Shared database access layer used by BOTH the REST and the GraphQL API.
// Using exactly the same SQL for both APIs keeps the comparison fair: any
// difference measured comes from the API layer, not from the data layer.
//
// node:sqlite ships with Node.js >= 22.13 (no native compilation needed on Windows).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(here, '../../data/benchmark.db');

const USER_COLS = 'id, name, username, email, bio, created_at AS createdAt';
const POST_COLS = 'id, user_id AS userId, title, body, created_at AS createdAt';
const COMMENT_COLS = 'id, post_id AS postId, name, email, body, created_at AS createdAt';

export function openDatabase(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at ${dbPath}. Run "npm run seed" first.`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return createRepository(db);
}

// Plain-object copy: node:sqlite returns null-prototype objects; we normalise
// them so both APIs serialise identical JSON.
const plain = (row) => (row ? { ...row } : null);

export function createRepository(db) {
  const stmt = {
    userById: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`),
    postsByUser: db.prepare(`SELECT ${POST_COLS} FROM posts WHERE user_id = ? ORDER BY id`),
    commentsByPost: db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE post_id = ? ORDER BY id`),
    listPosts: db.prepare(`SELECT ${POST_COLS} FROM posts ORDER BY id LIMIT ? OFFSET ?`),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countPosts: db.prepare('SELECT COUNT(*) AS n FROM posts'),
  };

  // Prepared statements for batched "IN (?, ?, ...)" queries, cached by size.
  const batchCache = new Map();
  const batchStmt = (kind, size) => {
    const key = `${kind}:${size}`;
    if (!batchCache.has(key)) {
      const marks = new Array(size).fill('?').join(',');
      const sql = {
        users: `SELECT ${USER_COLS} FROM users WHERE id IN (${marks})`,
        postsByUser: `SELECT ${POST_COLS} FROM posts WHERE user_id IN (${marks}) ORDER BY id`,
        commentsByPost: `SELECT ${COMMENT_COLS} FROM comments WHERE post_id IN (${marks}) ORDER BY id`,
      }[kind];
      batchCache.set(key, db.prepare(sql));
    }
    return batchCache.get(key);
  };

  const groupBy = (rows, keys, field) => {
    const map = new Map(keys.map((k) => [Number(k), []]));
    for (const r of rows) map.get(r[field])?.push(plain(r));
    return keys.map((k) => map.get(Number(k)) ?? []);
  };

  return {
    getUserById: (id) => plain(stmt.userById.get(Number(id))),
    getPostsByUserId: (userId) => stmt.postsByUser.all(Number(userId)).map(plain),
    getCommentsByPostId: (postId) => stmt.commentsByPost.all(Number(postId)).map(plain),
    listPosts: (limit, offset) => stmt.listPosts.all(Number(limit), Number(offset)).map(plain),

    // Batched variants (used by DataLoader in the GraphQL server).
    getUsersByIds: (ids) => {
      const rows = batchStmt('users', ids.length).all(...ids.map(Number));
      const byId = new Map(rows.map((r) => [r.id, plain(r)]));
      return ids.map((id) => byId.get(Number(id)) ?? null);
    },
    getPostsByUserIds: (ids) =>
      groupBy(batchStmt('postsByUser', ids.length).all(...ids.map(Number)), ids, 'userId'),
    getCommentsByPostIds: (ids) =>
      groupBy(batchStmt('commentsByPost', ids.length).all(...ids.map(Number)), ids, 'postId'),

    counts: () => ({ users: stmt.countUsers.get().n, posts: stmt.countPosts.get().n }),
    close: () => db.close(),
  };
}
