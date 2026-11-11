// Starts the REST (port 3000) and GraphQL (port 4000) servers as two separate
// Node.js processes, so each API has its own event loop and its own CPU/memory
// figures. Run this on the SERVER laptop. Stop with Ctrl+C.
import { spawn } from 'node:child_process';

const procs = [
  ['REST', 'src/rest/server.js'],
  ['GraphQL', 'src/graphql/server.js'],
].map(([name, file]) => {
  const p = spawn(process.execPath, ['--no-warnings', file], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
  p.on('exit', (code) => {
    console.log(`${name} server exited with code ${code}`);
    process.exitCode = code ?? 1;
  });
  return p;
});

const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
