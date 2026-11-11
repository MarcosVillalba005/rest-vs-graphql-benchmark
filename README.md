# REST vs GraphQL under load: experiment code

This is the code for the Web Engineering and Services final project (UCLM). It contains two equivalent APIs over the same SQLite database: REST on Express 5, and GraphQL on Apollo Server 5 mounted on Express 5. It also contains the k6 load scripts, a runner that randomises the run order, and the statistical analysis.

| Folder | Content |
|---|---|
| `src/db` | Deterministic dataset generator (`seed.js`) and the data-access layer shared by both APIs |
| `src/rest` | REST API, port 3000 |
| `src/graphql` | GraphQL API, port 4000, with DataLoader batching |
| `src/common` | Server-side CPU/memory instrumentation, the same code for both APIs |
| `scripts` | `start-both.js` (starts both servers) and `verify-equivalence.js` (checks that both APIs return identical data) |
| `bench/k6/benchmark.js` | k6 script for one configuration (API × scenario × VUs) |
| `bench/run-experiment.js` | Runs the whole experiment: 2 APIs × 3 scenarios × 5 VU levels × 10 repetitions |
| `analysis/analyze.py` | Mann-Whitney U, Holm correction, A12 effect size, Spearman trend, figures and tables |
| `config/experiment.json` | All experimental parameters in one place |

## 0. What you need

- **Both laptops:** Node.js 22 LTS (22.13 or newer) or 24 LTS from <https://nodejs.org>. Check it with `node -v`.
- **Load-generator laptop:** k6. Run `winget install k6 --source winget`, then close and reopen the terminal and check it with `k6 version`.
- **Load-generator laptop:** Python 3.10 or newer for the analysis.
- **Network:** both laptops on the same network. An Ethernet cable to the same router is best. Wi-Fi works, but report it as a limitation. Do not use the university Wi-Fi: other users add noise and client isolation may block the connection.

## 1. Server laptop

```powershell
git clone <your-repo-url> rest-vs-graphql-benchmark   # or unzip the folder
cd rest-vs-graphql-benchmark
npm install
npm run seed        # creates data/benchmark.db (1,000 users, 10,000 posts, 50,000 comments)
npm test            # all tests must pass ("ok"); none may fail
npm run start:both  # REST on :3000 and GraphQL on :4000. Leave this window open.
```

Find the server's IP address with `ipconfig` (look for the IPv4 address, for example `192.168.1.20`). The first time Windows asks, allow Node.js on **private networks**. If it doesn't ask, open ports 3000 and 4000 from an administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName "bench-3000-4000" -Direction Inbound -Protocol TCP -LocalPort 3000,4000 -Action Allow -Profile Private
```

Remove that rule when you have finished.

## 2. Load-generator laptop

```powershell
cd rest-vs-graphql-benchmark
npm install
# 1) Both APIs must return identical data:
node scripts/verify-equivalence.js --rest http://192.168.1.20:3000 --graphql http://192.168.1.20:4000
# 2) Short pilot (about 6 minutes) to check that everything works:
node bench/run-experiment.js --rest-url http://192.168.1.20:3000 --graphql-url http://192.168.1.20:4000 --reps 1 --duration 5 --warmup 3 --cooldown 2 --tag pilot
# 3) Full experiment (300 runs, about 4 hours). It can be resumed: run the same command again if it stops.
node bench/run-experiment.js --rest-url http://192.168.1.20:3000 --graphql-url http://192.168.1.20:4000
```

Add `--dry-run` to any runner command to see the randomised plan without running anything.

## 3. Analysis

```powershell
python -m pip install -r analysis/requirements.txt
python analysis/analyze.py --results results/main
```

This writes everything to `results/main/analysis/`:

- **Figures for the report and slides:** `fig_latency_p50.png`, `fig_latency_p95.png`, `fig_throughput.png`, `fig_ratio.png` and `fig_cpu.png`.
- **Numbers for the tables:** `summary.md` and `tests.md`.
- **A first verdict on H1, H2 and H3:** `hypotheses.md`. Check it, but write the interpretation yourselves.

Also keep `results/main/environment.json`. It records the hardware, the Node.js and k6 versions and the design parameters, which you need for the Methodology section.

## 4. Rules for clean measurements

1. Both laptops plugged in, on the high-performance power plan, with sleep disabled.
2. Close browsers, OneDrive/Dropbox, Teams and antivirus scans. Pause Windows Update.
3. Use the server laptop only for the servers, and do not touch either laptop while the experiment is running.
4. Do not change code or configuration halfway through. If you must, delete `results/main` and start again.
5. Write down anything unusual (a run that failed, a Wi-Fi drop) and mention it in Limitations.

## 5. What exactly is measured

- **Operation latency (`op_duration`):** the time the client needs to obtain the scenario's complete document. This is measured with k6's own timings (queueing + connect + send + wait + receive). For REST S2 it is the sum of two parallel waves: wave 1 fetches the user and their posts; wave 2 fetches the comments of all 10 posts, with at most 6 connections per host, the same limit browsers use for HTTP/1.1. Client-side JSON parsing is excluded.
- **Throughput:** successful operations per second in the 30-second measured window.
- **Error rate:** failed operations divided by attempted operations. A non-200 status, an empty body or a GraphQL `errors` field counts as a failure.
- **Server resources:** CPU time as a percentage of one core, peak RSS memory and event-loop delay, read from `/__stats` before and after each run.
- **Ablation (optional):** start the GraphQL server with `DATALOADER=off` to see the cost of the N+1 problem. In PowerShell: `$env:DATALOADER="off"; npm run start:graphql`. Use `--apis graphql --tag no-dataloader` in the runner.

## 6. Public deployment (demo instance)

The two APIs can also be deployed to the Internet so that anyone can try them without installing anything. The repository includes a `render.yaml` blueprint for [Render](https://render.com):

1. Upload this folder to a public GitHub repository.
2. On Render, choose **New → Blueprint** and select the repository. Render creates two web services: `rest-vs-graphql-rest` and `rest-vs-graphql-graphql`.
3. Wait for both builds to finish. The build installs the dependencies and generates the SQLite database, so no external database is needed.
4. Try them:
   - `https://<rest-service>.onrender.com/users/5`
   - `https://<rest-service>.onrender.com/users/5/posts`
   - `https://<graphql-service>.onrender.com/graphql` (POST a query, for example with Postman or curl)
5. Check that both deployed APIs return identical data:
   `node scripts/verify-equivalence.js --rest https://<rest-service>.onrender.com --graphql https://<graphql-service>.onrender.com`

**Important: the public instance is for demonstration only, not for the measurements.** A free cloud instance adds Internet latency, shares CPU with other customers and may go to sleep when idle. The first request after a pause can take tens of seconds. The measurements in the dissertation are taken on the two-laptop LAN setup described above. You can mention the public URL in the dissertation as a "public demo instance" and keep it separate from the measurement environment.
