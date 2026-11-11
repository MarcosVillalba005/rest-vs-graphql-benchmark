// GraphQL schema and resolvers. Field names and types mirror the REST JSON
// exactly (ids are Int, not ID, so both APIs serialise `"id": 5` the same way).
import DataLoader from 'dataloader';

export const typeDefs = /* GraphQL */ `
  type User {
    id: Int!
    name: String!
    username: String!
    email: String!
    bio: String!
    createdAt: String!
    posts: [Post!]!
  }

  type Post {
    id: Int!
    userId: Int!
    title: String!
    body: String!
    createdAt: String!
    author: User
    comments: [Comment!]!
  }

  type Comment {
    id: Int!
    postId: Int!
    name: String!
    email: String!
    body: String!
    createdAt: String!
  }

  type Query {
    user(id: Int!): User
    posts(limit: Int = 100, offset: Int = 0): [Post!]!
  }
`;

export const MAX_LIMIT = 500;

// One set of loaders per request (standard DataLoader practice): batches the
// N+1 look-ups of a single query into one SQL statement per relationship.
export function createLoaders(repo) {
  return {
    userById: new DataLoader(async (ids) => repo.getUsersByIds(ids)),
    postsByUser: new DataLoader(async (ids) => repo.getPostsByUserIds(ids)),
    commentsByPost: new DataLoader(async (ids) => repo.getCommentsByPostIds(ids)),
  };
}

// Set DATALOADER=off to measure the naive N+1 behaviour (optional ablation).
export function createResolvers(repo, { useDataLoader = true } = {}) {
  return {
    Query: {
      user: (_parent, { id }) => repo.getUserById(id),
      posts: (_parent, { limit, offset }) =>
        repo.listPosts(Math.min(Math.max(limit, 1), MAX_LIMIT), Math.max(offset, 0)),
    },
    User: {
      posts: (user, _args, ctx) =>
        useDataLoader ? ctx.loaders.postsByUser.load(user.id) : repo.getPostsByUserId(user.id),
    },
    Post: {
      author: (post, _args, ctx) =>
        useDataLoader ? ctx.loaders.userById.load(post.userId) : repo.getUserById(post.userId),
      comments: (post, _args, ctx) =>
        useDataLoader ? ctx.loaders.commentsByPost.load(post.id) : repo.getCommentsByPostId(post.id),
    },
  };
}
