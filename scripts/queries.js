// GraphQL operations used in the experiment. They request exactly the fields
// returned by the equivalent REST endpoints (no over-/under-fetching advantage),
// so the comparison isolates protocol and round-trip effects.
// The k6 script (bench/k6/benchmark.js) contains an identical copy.
const USER = 'id name username email bio createdAt';
const POST = 'id userId title body createdAt';
const COMMENT = 'id postId name email body createdAt';

export const QUERIES = {
  simple: `query Simple($id: Int!) { user(id: $id) { ${USER} } }`,
  nested: `query Nested($id: Int!) { user(id: $id) { ${USER} posts { ${POST} comments { ${COMMENT} } } } }`,
  list: `query List($limit: Int!, $offset: Int!) { posts(limit: $limit, offset: $offset) { ${POST} } }`,
};

// What a REST client must do to obtain the same nested document:
// wave 1: user + user's posts (in parallel); wave 2: comments of every post (in parallel).
export async function restNested(getJson, base, id) {
  const [user, posts] = await Promise.all([getJson(`${base}/users/${id}`), getJson(`${base}/users/${id}/posts`)]);
  const comments = await Promise.all(posts.map((p) => getJson(`${base}/posts/${p.id}/comments`)));
  return { ...user, posts: posts.map((p, i) => ({ ...p, comments: comments[i] })) };
}
