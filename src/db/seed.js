// Generates the synthetic, fully reproducible dataset shared by both APIs.
// Same seed => byte-identical database on any machine (no external libraries).
//
// Usage: npm run seed            (uses config/experiment.json)
//        node src/db/seed.js --out data/other.db
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH } from './database.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.resolve(here, '../../config/experiment.json'), 'utf8'));
const { seed, users: N_USERS, postsPerUser, commentsPerPost } = config.dataset;

const outArg = process.argv.indexOf('--out');
const dbPath = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : DEFAULT_DB_PATH;

// Mulberry32: small, fast, deterministic PRNG.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const FIRST = ['Ana', 'Luis', 'Marta', 'Pablo', 'Lucia', 'Javier', 'Elena', 'Diego', 'Sara', 'Hugo',
  'Paula', 'Carlos', 'Irene', 'Mario', 'Laura', 'Adrian', 'Nerea', 'Ivan', 'Claudia', 'Raul'];
const LAST = ['Garcia', 'Martinez', 'Lopez', 'Sanchez', 'Perez', 'Gomez', 'Martin', 'Jimenez', 'Ruiz',
  'Hernandez', 'Diaz', 'Moreno', 'Alvarez', 'Romero', 'Navarro', 'Torres', 'Dominguez', 'Vazquez'];
const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut ' +
  'labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ' +
  'aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat ' +
  'nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit ' +
  'anim id est laborum web service api query latency throughput server client network cache schema').split(' ');

const sentence = (n) => {
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
};
const date = () => new Date(Date.UTC(2023, 0, 1) + Math.floor(rand() * 3 * 365 * 86400e3)).toISOString();

mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = DELETE;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL,
    email TEXT NOT NULL, bio TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id),
    name TEXT NOT NULL, email TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
`);

const insUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
const insPost = db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?, ?)');
const insComment = db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?)');

db.exec('BEGIN');
let postId = 0;
let commentId = 0;
for (let u = 1; u <= N_USERS; u++) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const username = `${first}.${last}${u}`.toLowerCase();
  insUser.run(u, `${first} ${last}`, username, `${username}@example.org`, sentence(20), date());
  for (let p = 0; p < postsPerUser; p++) {
    postId++;
    insPost.run(postId, u, sentence(6).slice(0, -1), sentence(40), date());
    for (let c = 0; c < commentsPerPost; c++) {
      commentId++;
      const cn = `${pick(FIRST)} ${pick(LAST)}`;
      insComment.run(commentId, postId, cn, `${cn.replace(' ', '.').toLowerCase()}@example.org`, sentence(18), date());
    }
  }
}
db.exec('COMMIT');
// Indexes on the foreign keys used by both APIs.
db.exec(`
  CREATE INDEX idx_posts_user ON posts(user_id);
  CREATE INDEX idx_comments_post ON comments(post_id);
  ANALYZE;
`);
db.close();

console.log(`Seeded ${dbPath}: ${N_USERS} users, ${postId} posts, ${commentId} comments (seed=${seed}).`);
