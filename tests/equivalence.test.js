// Unit tests: run with "npm test" (no servers needed).
// They build a small temporary database and check that the REST handlers and the
// GraphQL resolvers return identical documents for the three scenarios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/database.js';
import { createRestHandlers } from '../src/rest/handlers.js';
import { createResolvers, createLoaders, typeDefs } from '../src/graphql/schema.js';
import { QUERIES } from '../scripts/queries.js';

let dir, repo, rest;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bench-test-'));
  const dbPath = path.join(dir, 'test.db');
  execFileSync(process.execPath, ['--no-warnings', 'src/db/seed.js', '--out', dbPath]);
  repo = openDatabase(dbPath);
  rest = createRestHandlers(repo);
});
after(() => { repo?.close(); rmSync(dir, { recursive: true, force: true }); });

// Resolve the nested document through the GraphQL resolvers (with or without DataLoader).
async function viaResolvers(id, useDataLoader) {
  const r = createResolvers(repo, { useDataLoader });
  const ctx = { loaders: createLoaders(repo) };
  const user = r.Query.user(null, { id });
  const posts = await r.User.posts(user, {}, ctx);
  const withComments = await Promise.all(
    posts.map(async (p) => ({ ...p, comments: await r.Post.comments(p, {}, ctx) })),
  );
  return { ...user, posts: withComments };
}
function viaRest(id) {
  const user = rest.getUser(id);
  const posts = rest.getUserPosts(id);
  return { ...user, posts: posts.map((p) => ({ ...p, comments: rest.getPostComments(p.id) })) };
}

test('dataset is deterministic and has the configured size', () => {
  const c = repo.counts();
  assert.equal(c.users, 1000);
  assert.equal(c.posts, 10000);
  assert.equal(rest.getUserPosts(1).length, 10);
  assert.equal(rest.getPostComments(1).length, 5);
});

test('simple: user document identical', () => {
  const r = createResolvers(repo);
  for (const id of [1, 500, 1000]) assert.deepEqual(r.Query.user(null, { id }), rest.getUser(id));
});

test('nested: REST composition == GraphQL resolvers (with and without DataLoader)', async () => {
  for (const id of [1, 42, 999]) {
    const expected = viaRest(id);
    assert.equal(expected.posts.length, 10);
    assert.deepEqual(await viaResolvers(id, true), expected);
    assert.deepEqual(await viaResolvers(id, false), expected);
  }
});

test('DataLoader batches the comments of all posts into one call', async () => {
  let calls = 0;
  const counting = { ...repo, getCommentsByPostIds: (ids) => { calls++; return repo.getCommentsByPostIds(ids); } };
  const r = createResolvers(counting, { useDataLoader: true });
  const ctx = { loaders: createLoaders(counting) };
  const posts = await r.User.posts(r.Query.user(null, { id: 7 }), {}, ctx);
  await Promise.all(posts.map((p) => r.Post.comments(p, {}, ctx)));
  assert.equal(calls, 1);
});

test('list: same page of posts', () => {
  const r = createResolvers(repo);
  assert.deepEqual(r.Query.posts(null, { limit: 100, offset: 4321 }), rest.listPosts(100, 4321));
  assert.equal(rest.listPosts(100, 0).length, 100);
});

test('unknown user -> null / 404', () => {
  assert.equal(rest.getUser(99999), null);
  assert.equal(rest.getUserPosts(99999), null);
});

// Full GraphQL execution through Apollo (runs once dependencies are installed).
test('Apollo executes the benchmark queries and matches REST', async (t) => {
  let ApolloServer;
  try {
    ({ ApolloServer } = await import('@apollo/server'));
  } catch {
    t.skip('@apollo/server not installed (run npm install)');
    return;
  }
  const server = new ApolloServer({ typeDefs, resolvers: createResolvers(repo) });
  const exec = async (query, variables) => {
    const res = await server.executeOperation({ query, variables }, { contextValue: { loaders: createLoaders(repo) } });
    assert.equal(res.body.kind, 'single');
    assert.equal(res.body.singleResult.errors, undefined);
    return JSON.parse(JSON.stringify(res.body.singleResult.data));
  };
  assert.deepEqual((await exec(QUERIES.simple, { id: 3 })).user, rest.getUser(3));
  assert.deepEqual((await exec(QUERIES.nested, { id: 3 })).user, viaRest(3));
  assert.deepEqual((await exec(QUERIES.list, { limit: 100, offset: 10 })).posts, rest.listPosts(100, 10));
  await server.stop();
});
