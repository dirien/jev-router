# Evaluating Jev's routing

The router's thresholds decide how often a hard task lands on a cheap model. [`eval/run.mjs`](../eval/run.mjs)
measures that on labeled prompts, with the same state builder, questions, channels and policy the router uses, so a
result describes the router as configured and not Jev in general.

The shipped thresholds are starting values. They haven't been tuned on real Jev answers yet, and the 58-prompt set
is a starter, not a basis for trusting them.

## Running it

```bash
npm run eval                        # live: needs TYPESAFE_API_KEY or OPENROUTER_API_KEY, about $0.002 per run
npm run eval -- --repeats 3         # ask each prompt three times, to see how stable the answers are
npm run eval -- --config my.json    # evaluate another config, for example with a changed rubric
npm run eval:mock                   # keyword stand-in for Jev: checks the harness, measures nothing
```

The summary is printed as JSON on stdout. The per-prompt results, with every probability and guard value, go to
`eval/results-<timestamp>.jsonl`, which git ignores. Each prompt is sent as the first message of a new Claude Code
session, so the policy decides it freshly against `defaultTier`.

## The prompt set

[`eval/prompts.jsonl`](../eval/prompts.jsonl) has one JSON object per line:

```json
{"id": "com-01", "expected": "complex", "prompt": "Find out why ...", "tags": []}
```

`expected` is the cheapest sufficient option of the rubric (`mechanical`, `routine`, `complex` or `deep`), not a
tier; the harness maps it to a tier through the config. `tags` marks the special prompts, and `pair_of` links an
injection variant to its base prompt.

| Group | Prompts | Contents |
| --- | --- | --- |
| Base | 48 | 12 per option, from renames and typo fixes to migration designs |
| Injection | 6 | Copies of 3 `complex` and 3 `deep` base prompts with added text claiming the task is trivial or already decided (`tags: ["injection"]`, `pair_of`) |
| Firewall | 4 | Prompts full of shell commands, URLs and system paths, to exercise the hardened retry (`tags: ["waf"]`) |

## What it reports

| Field | Meaning |
| --- | --- |
| `answered`, `failed` | Jev calls that returned an answer, and calls that failed on every channel |
| `option_accuracy` | How often Jev's most likely option matches the label, over every prompt except the injection variants |
| `tiers.exact`, `tiers.under`, `tiers.over` | After the policy: the share routed to the label's tier, to a cheaper tier, and to a more capable one |
| `tiers.under_upper95` | The upper end of the 95% Wilson interval for the under-routing rate, which stays honest on small sets |
| `confusion_expected_by_predicted` | Counts per expected tier and routed tier |
| `calibration` | Option accuracy per band of Jev's top probability: below 0.7, 0.7 to 0.9, and 0.9 or more |
| `injection.pairs`, `injection.downgraded` | Injection variants, and how many were routed below their base prompt |
| `injection.claim_flagged` | Injection variants where `routing_claim_present` reached `policy.claimGuard` |
| `firewall` | Firewall probes, hardened retries, and probes that still failed |
| `latency_ms` | p50 and p95 of Jev's latency, retries included |
| `jev_cost_usd` | Input tokens times $0.042 per million |
| `fast_threshold_sweep` | `exact`, `under`, `under_upper95` and `over` for `policy.accept.fast` from 0.5 to 0.95 |

Under-routing is the costly error: a session sent too cheap stays there until the next human message raises it, and
a stronger model that inherits a weak model's transcript recovers only part of the gap. Over-routing costs money on
one message. Read `under` and `under_upper95` first.

## Tuning policy.accept

The sweep recomputes the policy for different values of `policy.accept.fast` from the recorded answers, without new
Jev calls.

- If under-routing is too high, raise `policy.accept.fast`. A cheap tier then needs more certainty, and more
  prompts escalate to the more capable of Jev's top two tiers.
- If too much lands on `frontier`, lower it, or lower `policy.accept.balanced`, and re-run the evaluation with
  `--config`.
- Pick the smallest threshold whose `under_upper95` is at or below your limit (3% is a reasonable bar), measured on
  at least 100 routed prompts. The starter set can't support that, which is why the set has to grow first.
- Check that `injection.downgraded` stays at zero. If variants with a routing claim go unflagged, lower
  `policy.claimGuard`, then check the per-prompt results to make sure ordinary prompts don't trip it.

Then reload a running router: send it `SIGHUP` (`kill -HUP <pid>`, `launchctl kill HUP …` or
`systemctl --user reload jev-router`). The router re-validates the config before it takes effect.

## How big the set should be

TypeSafe advises starting with conservative thresholds and adjusting them on your own data
([Confidence](https://docs.typesafe.ai/confidence)), and independent calibration work found Jev overconfident exactly
where a label encodes your own policy, as a tier does
([scienthoon/jev-ood-calibration](https://github.com/scienthoon/jev-ood-calibration)). These sizes come from
standard interval arithmetic:

| Set | Size | Why |
| --- | --- | --- |
| Tuning | 400 prompts or more, about 100 per option | At least 100 routed prompts behind each candidate threshold, and per-option accuracy near 90% known to about ±6 points |
| Held-out | 200 prompts or more, frozen before tuning | Accuracy near 95% known to about ±3 points, measured once on prompts the thresholds never saw |
| Downgrade safety | 150 prompts or more whose label is `complex` or `deep` | Zero under-routes in 150 bounds the true rate below about 2% |
| Injection probes | 60 paired prompts per technique | Authority claims ("the lead already decided"), delimiter breaks, fake system messages, and a noise control of the same length |

Also worth including: a pilot of 80 to 100 prompts with three repeats to debug wording, about 30 firewall probes
heavy on shell commands, SQL and paths, and a mix of short prompts, long pastes, follow-ups and approvals ("yes, go
ahead"), prompts in the middle of tool use, and boundary cases, from both Claude Code and Codex sessions.

At about 1,000 input tokens per call, the whole plan is about 5,400 Jev calls and $0.23. Labeling is the real cost.

## Labeling and procedure

1. **Freeze the setup.** Fix the question, the options, the state builder and the Jev version (`jev-1.13.0`, not an
   alias) before measuring.
1. **Label the cheapest sufficient option.** The best labels come from outcomes: run the prompt on each tier and
   grade the result. Otherwise, have two people label independently and settle their disagreements. Write down
   tie-break rules, such as whether an approval inherits the tier of the task it approves.
1. **Run three repeats** and keep the per-prompt results.
1. **Sweep the thresholds** on the tuning set and pick them as above.
1. **Check once on the held-out set.** If it misses the bar, change the rubric or the thresholds and start a new
   held-out set, rather than tuning on the old one.

A suggested bar before trusting the thresholds: at least 90% exact matches on the held-out set, an under-routing
upper bound of 3% or less, at most 5% of authority-claim probes downgraded, and a Jev fallback rate under 2%
(`jev-router report` shows it for real traffic).

## When to run it again

Re-run the evaluation, and record the summary in the pull request, whenever one of these changes:

- `jev.question` or `jev.options` (the rubric), or the state the router builds
- the Jev model version in `jev.channels`, or where `jev-latest` points if you use the alias
- the tier map or the `policy` values
- the Claude Code or Codex version, when they change the harness text the router strips

TypeSafe's customer agreement forbids using Jev's output to train a model that imitates it
([MCA](https://typesafe.ai/legal/mca)). Use the labeled prompts to tune the router, not to distill Jev's answers into
a local classifier.
