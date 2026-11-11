// REST API (Express 5). Resource-oriented endpoints:
//   GET /users/:id            -> one user
//   GET /users/:id/posts      -> posts written by the user
//   GET /posts/:id/comments   -> comments of a post
//   GET /posts?limit&offset   -> page of posts (large list scenario)
import express from 'express';
import { openDatabase } from '../db/database.js';
import { createRestHandlers } from './handlers.js';
import { createInstrumentation } from '../common/instrumentation.js';

process.env.NODE_ENV ??= 'production';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const repo = openDatabase();
const h = createRestHandlers(repo);
const instr = createInstrumentation();

const app = express();
// Same HTTP settings as the GraphQL server: no ETag hashing, no extra header.
app.set('etag', false);
app.disable('x-powered-by');
instr.mount(app, 'rest');

const send = (res, body) => (body === null ? res.status(404).json({ error: 'Not found' }) : res.json(body));

app.get('/users/:id', (req, res) => send(res, h.getUser(req.params.id)));
app.get('/users/:id/posts', (req, res) => send(res, h.getUserPosts(req.params.id)));
app.get('/posts/:id/comments', (req, res) => send(res, h.getPostComments(req.params.id)));
app.get('/posts', (req, res) => send(res, h.listPosts(req.query.limit, req.query.offset)));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`REST API ready on http://${HOST}:${PORT}  (data: ${JSON.stringify(repo.counts())})`);
});
server.keepAliveTimeout = 65_000; // identical keep-alive policy for both servers
