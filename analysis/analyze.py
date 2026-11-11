"""
Statistical analysis of the REST vs GraphQL load-testing experiment.

Usage (from the project root, after the runner has finished):
    pip install -r analysis/requirements.txt
    python analysis/analyze.py --results results/main

Outputs (in <results>/analysis/):
    runs.csv                one row per measured run (the experimental unit)
    summary.csv / .md       median and IQR across repetitions per configuration
    tests.csv / .md         Mann-Whitney U tests REST vs GraphQL, Holm-adjusted, A12 effect size
    h3_trend.csv            Spearman trend of the GraphQL/REST latency ratio vs. concurrency
    hypotheses.md           automatic, data-driven verdict for H1-H3 (to help write Results)
    fig_latency_p50.png, fig_latency_p95.png, fig_throughput.png, fig_ratio.png, fig_cpu.png

Statistical approach
    * Unit of analysis = one measured run (per-run median, p95, throughput). Requests inside a
      run are not independent, so runs, not requests, are compared (Georges et al., 2007).
    * Two-sided Mann-Whitney U test (non-parametric; latency distributions are skewed)
      with the Vargha-Delaney A12 effect size (Arcuri & Briand, 2014).
    * Holm correction for the 15 comparisons (3 scenarios x 5 concurrency levels) of each metric.
    * H3: Spearman rank correlation between concurrency and log(GraphQL/REST) latency ratio.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.ticker  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy import stats  # noqa: E402

API_ORDER = ["rest", "graphql"]
API_LABEL = {"rest": "REST", "graphql": "GraphQL"}
API_COLOR = {"rest": "#2a78d6", "graphql": "#eb6834"}
API_MARKER = {"rest": "o", "graphql": "s"}
SCEN_ORDER = ["simple", "nested", "list"]
SCEN_LABEL = {"simple": "S1 Simple query", "nested": "S2 Nested data", "list": "S3 Large list"}
SCEN_COLOR = {"simple": "#2a78d6", "nested": "#eb6834", "list": "#1baf7a"}
ALPHA = 0.05

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "Liberation Serif", "DejaVu Serif"],
    "font.size": 9,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.edgecolor": "#8a8984",
    "axes.labelcolor": "#2b2b2a",
    "xtick.color": "#52514e",
    "ytick.color": "#52514e",
    "axes.grid": True,
    "grid.color": "#e6e5e0",
    "grid.linewidth": 0.6,
    "legend.frameon": False,
    "savefig.dpi": 300,
})


# ----------------------------------------------------------------------------- loading
def load_runs(results: Path) -> pd.DataFrame:
    rows = []
    for f in sorted((results / "raw").glob("*.json")):
        if f.name.endswith(".k6.json"):
            continue
        r = json.loads(f.read_text(encoding="utf-8"))
        m = r["k6"]["metrics"]
        dur = float(r.get("durationSeconds", 30))
        op = m.get("op_duration", {}).get("values", {})
        ok = m.get("ops_ok", {}).get("values", {}).get("count", 0)
        err = m.get("op_errors", {}).get("values", {})
        received = m.get("data_received", {}).get("values", {}).get("count", 0)
        reqs = m.get("http_reqs", {}).get("values", {}).get("count", 0)
        attempted = err.get("passes", 0) + err.get("fails", 0)
        srv = r.get("server", {})
        rows.append({
            "run_id": r["runId"], "api": r["api"], "scenario": r["scenario"], "vus": int(r["vus"]),
            "rep": int(r["rep"]), "order_in_block": r.get("orderInBlock"),
            "p50_ms": op.get("med"), "p90_ms": op.get("p(90)"), "p95_ms": op.get("p(95)"),
            "p99_ms": op.get("p(99)"), "mean_ms": op.get("avg"), "max_ms": op.get("max"),
            "throughput_ops": ok / dur,
            "error_rate": err.get("rate", 0.0),
            "kb_per_op": (received / attempted / 1024) if attempted else np.nan,
            "http_reqs_per_op": (reqs / attempted) if attempted else np.nan,
            "server_cpu_pct": srv.get("cpuPercent"),
            "server_cpu_ms_per_op": (srv.get("cpuUserMs", 0) + srv.get("cpuSystemMs", 0)) / ok if ok else np.nan,
            "server_rss_peak_mb": srv.get("rssPeakMB"),
            "event_loop_p99_ms": srv.get("eventLoopDelayP99Ms"),
        })
    if not rows:
        raise SystemExit(f"No run files found in {results / 'raw'}")
    df = pd.DataFrame(rows)
    df["api"] = pd.Categorical(df["api"], API_ORDER, ordered=True)
    df["scenario"] = pd.Categorical(df["scenario"], SCEN_ORDER, ordered=True)
    return df.sort_values(["scenario", "vus", "api", "rep"]).reset_index(drop=True)


# ----------------------------------------------------------------------------- statistics
def a12(x: np.ndarray, y: np.ndarray) -> float:
    """Vargha-Delaney A12: probability that a value from x is larger than one from y (ties count 1/2)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    gt = (x[:, None] > y[None, :]).sum()
    eq = (x[:, None] == y[None, :]).sum()
    return (gt + 0.5 * eq) / (len(x) * len(y))


def a12_magnitude(a: float) -> str:
    d = abs(a - 0.5)  # thresholds from Vargha & Delaney (2000)
    return "negligible" if d < 0.06 else "small" if d < 0.14 else "medium" if d < 0.21 else "large"


def holm(pvalues: list[float]) -> list[float]:
    p = np.asarray(pvalues, float)
    order = np.argsort(p)
    adj = np.empty_like(p)
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, (len(p) - rank) * p[i])
        adj[i] = min(running, 1.0)
    return adj.tolist()


def iqr(s: pd.Series) -> float:
    return float(s.quantile(0.75) - s.quantile(0.25))


def summarise(df: pd.DataFrame) -> pd.DataFrame:
    metrics = ["p50_ms", "p95_ms", "p99_ms", "throughput_ops", "error_rate", "kb_per_op",
               "http_reqs_per_op", "server_cpu_pct", "server_cpu_ms_per_op", "server_rss_peak_mb"]
    g = df.groupby(["scenario", "vus", "api"], observed=True)
    out = g[metrics].median().add_suffix("_median")
    out = out.join(g[["p50_ms", "p95_ms", "throughput_ops"]].agg(iqr).add_suffix("_iqr"))
    out["n_runs"] = g.size()
    return out.reset_index()


def compare(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for metric in ["p50_ms", "p95_ms", "throughput_ops"]:
        block = []
        for (scen, vus), sub in df.groupby(["scenario", "vus"], observed=True):
            rest = sub.loc[sub.api == "rest", metric].dropna().to_numpy()
            gql = sub.loc[sub.api == "graphql", metric].dropna().to_numpy()
            if len(rest) < 2 or len(gql) < 2:
                continue
            res = stats.mannwhitneyu(gql, rest, alternative="two-sided")
            a = a12(gql, rest)
            block.append({
                "metric": metric, "scenario": scen, "vus": vus, "n_rest": len(rest), "n_graphql": len(gql),
                "median_rest": float(np.median(rest)), "median_graphql": float(np.median(gql)),
                "ratio_graphql_over_rest": float(np.median(gql) / np.median(rest)) if np.median(rest) else np.nan,
                "U": float(res.statistic), "p_value": float(res.pvalue),
                "A12_graphql_gt_rest": a, "effect_magnitude": a12_magnitude(a),
            })
        for row, p_adj in zip(block, holm([b["p_value"] for b in block])):
            row["p_holm"] = p_adj
            row["significant"] = p_adj < ALPHA
            lower_is_better = metric != "throughput_ops"
            if not row["significant"]:
                row["winner"] = "no significant difference"
            else:
                gql_better = (row["median_graphql"] < row["median_rest"]) == lower_is_better
                row["winner"] = "GraphQL" if gql_better else "REST"
            rows.append(row)
    return pd.DataFrame(rows)


def h3_trend(df: pd.DataFrame, metric: str = "p50_ms") -> pd.DataFrame:
    """Spearman correlation between concurrency and log(GraphQL/REST) ratio, pairing runs by repetition."""
    rows = []
    for scen, sub in df.groupby("scenario", observed=True):
        piv = sub.pivot_table(index=["vus", "rep"], columns="api", values=metric, observed=True).dropna()
        if piv.empty or not {"rest", "graphql"} <= set(piv.columns):
            continue
        log_ratio = np.log(piv["graphql"] / piv["rest"])
        vus = piv.index.get_level_values("vus")
        rho, p = stats.spearmanr(vus, log_ratio.abs())
        rho_signed, p_signed = stats.spearmanr(vus, log_ratio)
        rows.append({
            "scenario": scen, "metric": metric, "n_pairs": len(piv),
            "spearman_rho_abs_log_ratio": rho, "p_abs": p,
            "spearman_rho_signed_log_ratio": rho_signed, "p_signed": p_signed,
            "median_ratio_lowest_vus": float(np.exp(log_ratio[vus == vus.min()].median())),
            "median_ratio_highest_vus": float(np.exp(log_ratio[vus == vus.max()].median())),
        })
    return pd.DataFrame(rows)


# ----------------------------------------------------------------------------- figures
def _panel_plot(df, metric, ylabel, fname, out: Path, log_y=False):
    fig, axes = plt.subplots(1, 3, figsize=(7.0, 2.5), sharey=False)
    for ax, scen in zip(axes, SCEN_ORDER):
        sub = df[df.scenario == scen]
        for api in API_ORDER:
            g = sub[sub.api == api].groupby("vus")[metric]
            if g.ngroups == 0:
                continue
            med, q1, q3 = g.median(), g.quantile(0.25), g.quantile(0.75)
            ax.errorbar(med.index, med.values, yerr=[med - q1, q3 - med], color=API_COLOR[api],
                        marker=API_MARKER[api], markersize=4, linewidth=1.6, capsize=2, label=API_LABEL[api])
        ax.set_xscale("log")
        if log_y:
            ax.set_yscale("log")
            ax.yaxis.set_major_locator(matplotlib.ticker.LogLocator(subs=(1.0, 2.0, 5.0)))
            ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f"{v:g}"))
        vus = sorted(sub.vus.unique())
        ax.set_xticks(vus, [str(v) for v in vus])
        ax.minorticks_off()
        ax.set_title(SCEN_LABEL[scen], fontsize=9)
        ax.set_xlabel("Concurrent virtual users")
    axes[0].set_ylabel(ylabel)
    axes[0].legend(loc="upper left")
    fig.tight_layout()
    fig.savefig(out / fname)
    plt.close(fig)


def ratio_plot(df, out: Path):
    fig, ax = plt.subplots(figsize=(4.2, 2.6))
    for scen in SCEN_ORDER:
        sub = df[df.scenario == scen]
        med = sub.groupby(["vus", "api"], observed=True)["p50_ms"].median().unstack()
        if not {"rest", "graphql"} <= set(med.columns):
            continue
        ratio = med["graphql"] / med["rest"]
        ax.plot(ratio.index, ratio.values, marker="o", markersize=4, linewidth=1.6,
                color=SCEN_COLOR[scen], label=SCEN_LABEL[scen])
        ax.annotate(SCEN_LABEL[scen].split(" ")[0], (ratio.index[-1], ratio.values[-1]),
                    xytext=(4, 0), textcoords="offset points", fontsize=8, color="#2b2b2a", va="center")
    ax.axhline(1.0, color="#8a8984", linewidth=1, linestyle="--")
    ax.text(1, 1.0, " parity", fontsize=7, color="#52514e", va="bottom")
    ax.set_xscale("log")
    vus = sorted(df.vus.unique())
    ax.set_xticks(vus, [str(v) for v in vus])
    ax.minorticks_off()
    ax.set_xlabel("Concurrent virtual users")
    ax.set_ylabel("Median latency ratio\nGraphQL / REST")
    ax.legend(fontsize=7, loc="best")
    fig.tight_layout()
    fig.savefig(out / "fig_ratio.png")
    plt.close(fig)


# ----------------------------------------------------------------------------- reporting
def fmt_p(p: float) -> str:
    return "< 0.001" if p < 0.001 else f"{p:.3f}"


def hypotheses_text(tests: pd.DataFrame, trend: pd.DataFrame) -> str:
    lines = ["# Data-driven verdicts (generated by analyze.py)", "",
             "Copy the numbers into the Results section; interpret them in the Discussion.", ""]
    lat = tests[tests.metric == "p50_ms"]

    def verdict(scen, expected):
        sub = lat[lat.scenario == scen]
        k = int((sub.winner == expected).sum())
        other = "GraphQL" if expected == "REST" else "REST"
        k_other = int((sub.winner == other).sum())
        ratios = ", ".join(f"{int(v)} VUs: {r:.2f}" for v, r in zip(sub.vus, sub.ratio_graphql_over_rest))
        return k, k_other, len(sub), ratios

    k, ko, n, ratios = verdict("simple", "REST")
    lines += [f"## H1 (simple query: REST faster)",
              f"REST significantly faster (Holm p < {ALPHA}) in {k}/{n} concurrency levels; GraphQL faster in {ko}/{n}.",
              f"Median latency ratio GraphQL/REST per level -> {ratios}.",
              f"Verdict: {'SUPPORTED' if k == n else 'PARTIALLY SUPPORTED' if k > 0 else 'NOT SUPPORTED'}.", ""]
    k, ko, n, ratios = verdict("nested", "GraphQL")
    lines += [f"## H2 (nested data: GraphQL faster in total time)",
              f"GraphQL significantly faster in {k}/{n} levels; REST faster in {ko}/{n}.",
              f"Median latency ratio GraphQL/REST per level -> {ratios}.",
              f"Verdict: {'SUPPORTED' if k == n else 'PARTIALLY SUPPORTED' if k > 0 else 'NOT SUPPORTED'}.", ""]
    lines += ["## H3 (differences grow with concurrency)"]
    support = 0
    for _, r in trend.iterrows():
        grows = r.spearman_rho_abs_log_ratio > 0 and r.p_abs < ALPHA
        support += grows
        lines.append(f"- {SCEN_LABEL[r.scenario]}: Spearman rho(VUs, |log ratio|) = {r.spearman_rho_abs_log_ratio:.2f} "
                     f"(p = {fmt_p(r.p_abs)}, n = {r.n_pairs}); ratio {r.median_ratio_lowest_vus:.2f} at the lowest "
                     f"vs {r.median_ratio_highest_vus:.2f} at the highest load -> {'grows' if grows else 'no significant growth'}.")
    lines += [f"Verdict: {'SUPPORTED' if support == len(trend) else 'PARTIALLY SUPPORTED' if support else 'NOT SUPPORTED'} "
              f"({support}/{len(trend)} scenarios).", ""]
    thr = tests[tests.metric == "throughput_ops"]
    lines += ["## Throughput", f"REST higher in {int((thr.winner == 'REST').sum())}/{len(thr)} configurations, "
              f"GraphQL higher in {int((thr.winner == 'GraphQL').sum())}/{len(thr)}."]
    return "\n".join(lines) + "\n"


def to_markdown(df: pd.DataFrame, floatfmt=".2f") -> str:
    cols = list(df.columns)
    def cell(v):
        if isinstance(v, (float, np.floating)):
            return "" if math.isnan(v) else format(v, floatfmt)
        return str(v)
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(cell(v) for v in row) + " |" for row in df.itertuples(index=False)]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results/main", help="folder that contains raw/ (default results/main)")
    args = ap.parse_args()
    results = Path(args.results)
    out = results / "analysis"
    out.mkdir(parents=True, exist_ok=True)

    df = load_runs(results)
    df.to_csv(out / "runs.csv", index=False)
    print(f"Loaded {len(df)} runs: " + ", ".join(f"{k}={v}" for k, v in df.groupby('api', observed=True).size().items()))
    if (df.error_rate > 0.01).any():
        print("WARNING: some runs have > 1 % errors; report them and check the server/network.")

    summary = summarise(df)
    summary.to_csv(out / "summary.csv", index=False)
    table = summary[["scenario", "vus", "api", "p50_ms_median", "p95_ms_median", "p99_ms_median",
                     "throughput_ops_median", "error_rate_median", "kb_per_op_median", "server_cpu_pct_median"]]
    (out / "summary.md").write_text(to_markdown(table), encoding="utf-8")

    n_reps = int(df.groupby(["scenario", "vus", "api"], observed=True).size().min())
    trend = h3_trend(df)
    trend.to_csv(out / "h3_trend.csv", index=False)
    if n_reps < 2:
        print(f"Only {n_reps} repetition per configuration (pilot run): statistical tests skipped. "
              "Figures and summary tables are still produced; run the full experiment for tests.")
        (out / "hypotheses.md").write_text(
            "# Pilot run\n\nStatistical tests need at least 2 repetitions per configuration "
            "(the full experiment uses 10). Use these files only to check that the pipeline works.\n",
            encoding="utf-8")
    else:
        tests = compare(df)
        tests.to_csv(out / "tests.csv", index=False)
        short = tests[["metric", "scenario", "vus", "median_rest", "median_graphql", "ratio_graphql_over_rest",
                       "p_holm", "A12_graphql_gt_rest", "effect_magnitude", "winner"]]
        (out / "tests.md").write_text(to_markdown(short, ".3f"), encoding="utf-8")
        (out / "hypotheses.md").write_text(hypotheses_text(tests, trend), encoding="utf-8")

    _panel_plot(df, "p50_ms", "Median latency (ms)", "fig_latency_p50.png", out, log_y=True)
    _panel_plot(df, "p95_ms", "p95 latency (ms)", "fig_latency_p95.png", out, log_y=True)
    _panel_plot(df, "throughput_ops", "Throughput (operations/s)", "fig_throughput.png", out)
    _panel_plot(df, "server_cpu_pct", "Server CPU (% of one core)", "fig_cpu.png", out)
    ratio_plot(df, out)
    print(f"Analysis written to {out}")
    print((out / "hypotheses.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
