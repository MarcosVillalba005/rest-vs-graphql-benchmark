// REST resource handlers, kept free of Express so they can be unit-tested.
// Each function returns the JSON body (or null for 404).
export const MAX_LIMIT = 500;

export function createRestHandlers(repo) {
  return {
    getUser: (id) => repo.getUserById(id),
    getUserPosts: (id) => (repo.getUserById(id) ? repo.getPostsByUserId(id) : null),
    getPostComments: (id) => repo.getCommentsByPostId(id),
    listPosts: (limit = 100, offset = 0) =>
      repo.listPosts(Math.min(Math.max(Number(limit) || 0, 1), MAX_LIMIT), Math.max(Number(offset) || 0, 0)),
  };
}
