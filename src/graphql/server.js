// GraphQL API (Apollo Server 5 mounted on Express 5, single endpoint POST /graphql).
// Mounting Apollo on Express (instead of its standalone server) means both APIs
// share the same HTTP stack, so the comparison isolates REST vs GraphQL.
import express from 'express';
import http from 'node:http';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { openDatabase } from '../db/database.js';
import { typeDefs, createResolvers, createLoaders } from './schema.js';
import { createInstrumentation } from '../common/instrumentation.js';

process.env.NODE_ENV ??= 'production';
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const useDataLoader = (process.env.DATALOADER ?? 'on').toLowerCase() !== 'off';

const repo = openDatabase();
const instr = createInstrumentation();

const app = express();
app.set('etag', false);
app.disable('x-powered-by');
instr.mount(app, 'graphql');

const httpServer = http.createServer(app);
const apollo = new ApolloServer({
  typeDefs,
  resolvers: createResolvers(repo, { useDataLoader }),
  introspection: true,
  includeStacktraceInErrorResponses: false,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
});
await apollo.start();

app.use(
  '/graphql',
  express.json({ limit: '100kb' }),
  expressMiddleware(apollo, {
    context: async () => ({ loaders: createLoaders(repo) }),
  }),
);

httpServer.keepAliveTimeout = 65_000; // identical keep-alive policy for both servers
httpServer.listen(PORT, HOST, () => {
  console.log(
    `GraphQL API ready on http://${HOST}:${PORT}/graphql  ` +
      `(DataLoader: ${useDataLoader ? 'on' : 'off'}, data: ${JSON.stringify(repo.counts())})`,
  );
});
