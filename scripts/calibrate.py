#!/usr/bin/env python3
"""Score past judged-agent turns with the stayhomedad judge to pick a threshold.

Reads ~/.local/share/opencode/opencode.db read-only, rebuilds the same turn
summary the plugin builds, calls the judge, prints one row per turn sorted by
P(yes). Usage: scripts/calibrate.py [--limit N] [--url URL --model M] [--threshold T]
Judge target per turn: the provider the turn ran on (opencode.json baseURL, then
providerUrls in ~/.config/opencode/stayhomedad.json), unless --url overrides.
"""
# ponytail: labels are eyeballed from the FINAL column; add a --label pass via
# the frontier only if live JSONL shows the threshold is unstable.
import argparse, json, math, os, re, sqlite3, sys, urllib.request

DB = os.path.expanduser("~/.local/share/opencode/opencode.db")
CFG_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "opencode")
CFG_PATH = os.path.join(CFG_DIR, "stayhomedad.json")
CFG = {"threshold": 0.45, "agents": ["local"], "judgeUrl": None, "judgeModel": None, "providerUrls": {},
       "judgeExtra": {"chat_template_kwargs": {"enable_thinking": False}},
       "judgeSystem": "Reply YES or NO.", "judgeQuestion": "Adequate? Answer YES or NO."}
try:
    CFG.update(json.load(open(CFG_PATH)))
except (OSError, ValueError):
    pass


def trunc(s, n):
    return s if len(s) <= n else s[:n] + "…"


def summarize(prompt, tools, final, cap=6000):
    def build(t):
        omitted = f", oldest {len(tools) - len(t)} omitted" if len(t) < len(tools) else ""
        return (f"TASK:\n{trunc(prompt, 1500)}\n\nTOOL CALLS ({len(tools)}{omitted}):\n"
                f"{chr(10).join(t) or '(none)'}\n\nFINAL REPORT:\n{trunc(final, 2500) or '(empty)'}")
    kept = tools
    text = build(kept)
    while len(text) > cap and kept:
        kept = kept[1:]
        text = build(kept)
    return trunc(text, cap)


def opencode_providers():
    """baseURLs of custom providers declared in opencode.json."""
    try:
        cfg = json.load(open(os.path.join(CFG_DIR, "opencode.json")))
        return {k: (v.get("options") or {}).get("baseURL") for k, v in (cfg.get("provider") or {}).items()}
    except (OSError, ValueError):
        return {}


PROVIDERS = opencode_providers()


def resolve_judge(provider_id, model_id):
    url = CFG["judgeUrl"] or PROVIDERS.get(provider_id) or CFG["providerUrls"].get(provider_id)
    model = CFG["judgeModel"] or (None if CFG["judgeUrl"] else model_id)
    return (url, model) if url else None


def p_from_text(text):
    m = re.search(r"\b(yes|no)\b", text or "", re.I)
    return None if not m else (1.0 if m.group(1).lower() == "yes" else 0.0)


def complete(url, body):
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions", json.dumps(body).encode(),
                                 {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def judge(url, model, summary):
    base = {"temperature": 0, **({"model": model} if model else {}), **CFG["judgeExtra"],
            "messages": [{"role": "system", "content": CFG["judgeSystem"]},
                         {"role": "user", "content": summary + "\n\n" + CFG["judgeQuestion"]}]}
    c = complete(url, {**base, "max_tokens": 1, "logprobs": True, "top_logprobs": 5})["choices"][0]
    top = ((c.get("logprobs") or {}).get("content") or [{}])[0].get("top_logprobs")
    if top:
        yes = sum(math.exp(t["logprob"]) for t in top if t["token"].strip().lower() == "yes")
        no = sum(math.exp(t["logprob"]) for t in top if t["token"].strip().lower() == "no")
        if yes + no:
            return yes / (yes + no)
    p = p_from_text((c.get("message") or {}).get("content"))
    if p is not None:
        return p
    m = complete(url, {**base, "max_tokens": 48})["choices"][0].get("message") or {}
    p = p_from_text(m.get("content"))
    return p if p is not None else p_from_text(m.get("reasoning_content"))


def turns(limit):
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = db.execute("""
        select m.session_id, m.id, m.time_created, json_extract(m.data,'$.role'),
               json_extract(m.data,'$.agent'), json_extract(m.data,'$.error') is not null,
               json_extract(m.data,'$.model.providerID'), json_extract(m.data,'$.model.modelID')
        from message m where m.session_id in (
          select distinct session_id from message
          where json_extract(data,'$.role')='user' and json_extract(data,'$.agent') in (%s))
        order by m.session_id, m.time_created""" % ",".join("?" * len(CFG["agents"])), CFG["agents"]).fetchall()
    parts = {}
    for mid, data in db.execute("select message_id, data from part"):
        parts.setdefault(mid, []).append(json.loads(data))
    out, cur = [], None
    for sid, mid, ts, role, agent, err, prov, mdl in rows:
        ps = parts.get(mid, [])
        text = "\n".join(p["text"] for p in ps if p.get("type") == "text" and not p.get("synthetic")).strip()
        if role == "user":
            if cur and cur["asst"]:
                out.append(cur)
            # compaction / auto-continue messages have no user text: not a gated turn
            cur = ({"sid": sid, "uid": mid, "prompt": text, "tools": [], "final": "", "asst": 0, "err": False,
                    "prov": prov, "mdl": mdl} if text and agent in CFG["agents"] else None)
            continue
        if not cur:
            continue
        cur["asst"] += 1
        cur["err"] |= bool(err)
        for p in ps:
            if p.get("type") != "tool":
                continue
            st = p.get("state") or {}
            cur["err"] |= st.get("status") == "error"
            args = trunc(json.dumps(st.get("input") or {}), 120)
            o = trunc(" ".join(str(st.get("output") or st.get("error") or "").split()), 200)
            cur["tools"].append(f"{p.get('tool')}({args}) → {st.get('status', '?')}: {o}")
        if text:
            cur["final"] = text
    if cur and cur["asst"]:
        out.append(cur)
    return out[-limit:] if limit else out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--url", default=None, help="override judge endpoint for every turn")
    ap.add_argument("--model", default=None)
    ap.add_argument("--threshold", type=float, default=CFG["threshold"])
    a = ap.parse_args()
    scored = []
    for t in turns(a.limit):
        target = (a.url, a.model) if a.url else resolve_judge(t["prov"], t["mdl"])
        if not target:
            print(f"skip {t['uid']}: no judge url for provider {t['prov']}", file=sys.stderr)
            continue
        try:
            p = judge(*target, summarize(t["prompt"], t["tools"], t["final"]))
        except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
            print(f"\nskip {t['uid']}: {target[0]} ({t['prov']}) unreachable or bad reply: {e}", file=sys.stderr)
            continue
        scored.append((p, t))
        print(".", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    scored.sort(key=lambda x: (x[0] is None, x[0] or 0))
    print(f"{'pYes':>5} {'gate':>4} {'err':>3} {'tools':>5}  TASK → FINAL")
    for p, t in scored:
        gate = "ESC" if p is not None and p < a.threshold else "ok"
        ps = " n/a" if p is None else f"{p:.2f}"
        print(f"{ps:>5} {gate:>4} {'y' if t['err'] else '-':>3} {len(t['tools']):>5}  "
              f"{trunc(' '.join(t['prompt'].split()), 50)} → {trunc(' '.join(t['final'].split()), 70)}")
    ps = [p for p, _ in scored if p is not None]
    if ps:
        esc = sum(p < a.threshold for p in ps)
        print(f"\n{len(ps)} turns scored, {esc} below {a.threshold} ({esc / len(ps):.0%}); "
              f"median {sorted(ps)[len(ps) // 2]:.2f}")


if __name__ == "__main__":
    main()
