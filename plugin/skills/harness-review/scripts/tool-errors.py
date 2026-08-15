#!/usr/bin/env python3
"""Lane C, from the transcripts rather than from the store.

The store only holds errors the generator happened to write down, which makes the agent the
judge in its own case. The transcripts hold every failed tool call as the runtime recorded it.

Reads whichever runtimes are present on this machine and prints one table per runtime:
signature, hits, sessions, days, span. Never prints transcript content — the Claude Code
transcripts alone are hundreds of megabytes and must not reach a context window.

    python3 tool-errors.py                  # all runtimes found, all history
    python3 tool-errors.py --since 2026-07-01
    python3 tool-errors.py --raw 25         # distinct error heads, for building signatures
    python3 tool-errors.py --selfcheck      # parsers still work

Signatures live in ~/.claude-mem/state/harness-review-signatures.md, one per line as
`pattern | name` (lowercase substring match). The seed below is used when that file is absent.
Widening the list changes the instrument: version the file and say which version a count is
taken under.
"""
import argparse, glob, json, os, re, sqlite3, sys, tempfile
from collections import defaultdict
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
GUESSED = [0]  # records whose timestamp fell back to file mtime — every one lands on the same day
SIGNATURE_FILE = os.path.join(HOME, '.claude-mem', 'state', 'harness-review-signatures.md')
# Ordered: first match wins. Wordings differ per runtime for the same failure, so several
# patterns map to one name — that is the point of the name.
# Deliberately absent: bare "Exit code 1". A failing build or test is the work being wrong,
# not the harness obstructing it, and it would swamp every other signature.
SEED = [
    ('not permitted', 'sandbox / permission denied'),
    ('permission denied', 'sandbox / permission denied'),
    ('permission for this action was denied', 'permission prompt denied'),
    ('permission for this tool use was denied', 'permission prompt denied'),
    ('rejected permission', 'permission prompt denied'),
    ("doesn't want to proceed", 'permission prompt denied'),
    ('execution aborted', 'aborted mid-call'),
    ('command not found', 'missing tool'),
    ('no such tool available', 'called a tool that was not loaded'),
    ('cannot spawn other teammates', 'attempted a structurally impossible action'),
    ('cannot spawn background agents', 'attempted a structurally impossible action'),
    ('etimedout', 'network timeout'),
    ('could not resolve host', 'network blocked'),
    ('rate limit', 'provider rate limit'),
    ('unknown revision', 'dependency fetch'),
    ('string to replace not found', 'edit missed its target'),
    ('could not find oldstring', 'edit missed its target'),
    ('has not been read yet', 'edit before read'),
    ('must read file', 'edit before read'),
    ('file does not exist', 'path guessed wrong'),
    ('file not found', 'path guessed wrong'),
    ('is required when', 'malformed tool input'),
]


def load_signatures():
    if not os.path.exists(SIGNATURE_FILE):
        return SEED, 'seed (no signature file)'
    sigs, version = [], 'unversioned'
    for line in open(SIGNATURE_FILE, encoding='utf-8'):
        m = re.match(r'\*{0,2}Version:?\*{0,2}\s*(\S+)', line.strip(), re.I)
        if m:
            version = m.group(1).rstrip('*')
        if line.strip().startswith(('- ', '* ')) and '|' in line:
            pat, _, name = line.strip()[2:].partition('|')
            pat, name = pat.strip().strip('`').lower(), name.strip()
            # An empty pattern is a substring of everything and would swallow the whole table
            # under whatever name happened to sit next to it. Refuse it loudly.
            if not pat or not name:
                print(f'  signature file: skipping malformed entry {line.strip()!r}', file=sys.stderr)
                continue
            sigs.append((pat, name))
    return (sigs or SEED), (version if sigs else 'seed (file had no entries)')


# --- readers: each yields (session, epoch_ms, text) for one failed/erroring tool call ---

def read_claude(root=None, since=0):
    root = root or os.path.join(HOME, '.claude', 'projects')
    for path in glob.iglob(os.path.join(root, '**', '*.jsonl'), recursive=True):
        # A file last written before the floor cannot hold a record after it. Skips most of
        # the corpus on an incremental run; costs one stat per file otherwise.
        if since and os.path.getmtime(path) * 1000 < since:
            continue
        session = os.path.splitext(os.path.basename(path))[0]
        for line in open(path, errors='ignore'):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            content = (d.get('message') or {}).get('content')
            if not isinstance(content, list):
                continue
            ts = iso_ms(d.get('timestamp'))
            if ts is None:
                ts, GUESSED[0] = int(os.path.getmtime(path) * 1000), GUESSED[0] + 1
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error'):
                    yield session, ts, flatten(b.get('content'))


def read_codex(root=None, since=0):
    """Codex marks no error flag on tool output, so every tool output is scanned for the
    signatures. A hit therefore means 'this output contained the string', not 'the call
    failed' — report codex counts as an upper bound, never alongside a failure rate."""
    root = root or os.path.join(HOME, '.codex', 'sessions')
    for path in glob.iglob(os.path.join(root, '**', 'rollout-*.jsonl'), recursive=True):
        if since and os.path.getmtime(path) * 1000 < since:
            continue
        session = os.path.splitext(os.path.basename(path))[0]
        for line in open(path, errors='ignore'):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            p = d.get('payload') or d
            if p.get('type') in ('custom_tool_call_output', 'function_call_output'):
                ts = iso_ms(d.get('timestamp'))
                if ts is None:
                    ts, GUESSED[0] = int(os.path.getmtime(path) * 1000), GUESSED[0] + 1
                yield session, ts, flatten(p.get('output'))


def read_opencode(db=None, since=0):
    db = db or os.path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')
    if not os.path.exists(db):
        return
    # mode=ro, NOT immutable=1 — OpenCode writes to this database while it runs, and immutable
    # tells sqlite to ignore the WAL, which silently hides the most recent sessions.
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        rows = con.execute(
            "SELECT session_id, time_created, data FROM part "
            "WHERE json_extract(data,'$.type')='tool' "
            "AND json_extract(data,'$.state.status')='error'").fetchall()
    except sqlite3.Error as e:
        print(f'  opencode: could not read {db}: {e}', file=sys.stderr)
        return
    finally:
        con.close()
    for session, ts, data in rows:
        try:
            d = json.loads(data)
        except ValueError:
            continue
        state = d.get('state') or {}
        yield session, as_ms(ts), f"{d.get('tool','?')}: {flatten(state.get('error') or state.get('output'))}"


READERS = [
    ('claude code', read_claude, os.path.join(HOME, '.claude', 'projects'), 'failed tool calls'),
    ('codex', read_codex, os.path.join(HOME, '.codex', 'sessions'),
     'tool outputs scanned (no error flag in this format — hits are an upper bound)'),
    ('opencode', read_opencode, os.path.join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
     'failed tool calls'),
]


def flatten(v):
    if v is None:
        return ''
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ' '.join(flatten(x) for x in v)
    if isinstance(v, dict):
        return v.get('text') or v.get('message') or json.dumps(v, ensure_ascii=False)
    return str(v)


def iso_ms(s):
    if not isinstance(s, str):
        return None
    try:
        return int(datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000)
    except ValueError:
        return None


def parse_since(s):
    """The skill's cursor holds a full ISO timestamp, the flag documents a date. Take either."""
    s = s.strip()
    return iso_ms(s if 'T' in s else s + 'T00:00:00+00:00')


def as_ms(ts):
    ts = int(ts or 0)
    return ts if ts > 10 ** 12 else ts * 1000


def day(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d')


def tally(records, sigs):
    agg = defaultdict(lambda: {'hits': 0, 'sessions': set(), 'days': set()})
    for session, ts, text in records:
        low = text.lower()
        for pat, name in sigs:
            if pat in low:
                a = agg[name]
                a['hits'] += 1
                a['sessions'].add(session)
                a['days'].add(day(ts))
                break
    return agg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', help='YYYY-MM-DD')
    ap.add_argument('--raw', type=int, metavar='N', help='print N most common error heads instead')
    ap.add_argument('--selfcheck', action='store_true')
    args = ap.parse_args()
    if args.selfcheck:
        return selfcheck()

    sigs, version = load_signatures()
    floor = parse_since(args.since) if args.since else 0
    if args.since and floor is None:
        sys.exit(f'--since: could not parse {args.since!r}; use YYYY-MM-DD or an ISO timestamp')
    print(f'signatures: {len(sigs)} patterns, version {version}'
          f"{'' if not args.since else ', since ' + args.since}\n")

    found_any = False
    for label, reader, probe, unit in READERS:
        if not os.path.exists(probe):
            continue
        found_any = True
        records = [r for r in reader(since=floor) if r[1] >= floor]
        print(f'== {label} ==  {len(records)} {unit}')
        if args.raw:
            heads = defaultdict(int)
            for _, _, text in records:
                heads[' '.join(text.split())[:70]] += 1
            for head, n in sorted(heads.items(), key=lambda kv: -kv[1])[:args.raw]:
                print(f'  {n:>4}  {head}')
            print()
            continue
        agg = tally(records, sigs)
        if not agg:
            print('  no signature matched — run with --raw to see what this runtime produces')
        for name, a in sorted(agg.items(), key=lambda kv: -kv[1]['hits']):
            days = sorted(a['days'])
            print(f"  {a['hits']:>5} hits  {len(a['sessions']):>4} sessions  {len(days):>4} days  "
                  f'{days[0]} → {days[-1]}  {name}')
        unmatched = len(records) - sum(a['hits'] for a in agg.values())
        if 'upper bound' in unit:
            print('  (no unmatched count for this runtime: without an error flag the remainder '
                  'is every successful call, not a missed signature)')
        else:
            print(f'  {unmatched} failed calls matched no signature '
                  f'— the list is a seed, not a vocabulary')
        if records:
            days = sorted({day(r[1]) for r in records})
            print(f'  data horizon: {days[0]} → {days[-1]}, {len(days)} days with data')
        print()
    if GUESSED[0]:
        print(f'WARNING: {GUESSED[0]} records carried no timestamp and were dated from the file '
              'mtime, which puts every one of them on the same day. Spans and day counts '
              'involving them are wrong, not approximate.')
    if not found_any:
        print('No runtime transcripts found at the expected paths.\n'
              'Report this as "the lane found no transcripts", never as "no errors".')


def selfcheck():
    """Smallest thing that fails if a parser breaks: feed each reader one synthetic error."""
    with tempfile.TemporaryDirectory() as tmp:
        cdir = os.path.join(tmp, 'claude', 'p')
        os.makedirs(cdir)
        with open(os.path.join(cdir, 'sess-1.jsonl'), 'w') as f:
            f.write(json.dumps({'timestamp': '2026-08-01T10:00:00Z', 'message': {'content': [
                {'type': 'tool_result', 'is_error': True, 'content': 'Operation not permitted'}]}}) + '\n')
        got = list(read_claude(os.path.join(tmp, 'claude')))
        assert len(got) == 1 and 'not permitted' in got[0][2], got

        xdir = os.path.join(tmp, 'codex', '2026', '08', '01')
        os.makedirs(xdir)
        with open(os.path.join(xdir, 'rollout-x.jsonl'), 'w') as f:
            f.write(json.dumps({'timestamp': '2026-08-01T10:00:00Z', 'payload': {
                'type': 'custom_tool_call_output',
                'output': [{'type': 'input_text', 'text': 'Exit code 1 command not found'}]}}) + '\n')
        got = list(read_codex(os.path.join(tmp, 'codex')))
        assert len(got) == 1 and 'command not found' in got[0][2], got

        db = os.path.join(tmp, 'opencode.db')
        con = sqlite3.connect(db)
        con.execute('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, '
                    'time_created INTEGER, time_updated INTEGER, data TEXT)')
        con.execute('INSERT INTO part VALUES (?,?,?,?,?,?)', ('1', 'm', 's-9', 1785000000000, 0,
                    json.dumps({'type': 'tool', 'tool': 'bash',
                                'state': {'status': 'error', 'error': 'permission denied'}})))
        con.commit()
        con.close()
        got = list(read_opencode(db))
        assert len(got) == 1 and 'permission denied' in got[0][2], got

        agg = tally([('s', 1785000000000, 'Operation not permitted')], SEED)
        assert agg['sandbox / permission denied']['hits'] == 1, dict(agg)

        global SIGNATURE_FILE
        sigfile = os.path.join(tmp, 'sig.md')
        open(sigfile, 'w').write('**Version: v9**\n\n- Some Pattern | a name\n- other | b name\n')
        SIGNATURE_FILE, keep = sigfile, SIGNATURE_FILE
        try:
            sigs, version = load_signatures()
            assert version == 'v9' and ('some pattern', 'a name') in sigs, (version, sigs)
            SIGNATURE_FILE = os.path.join(tmp, 'absent.md')
            sigs, version = load_signatures()
            assert sigs is SEED and 'seed' in version, version
            bad = os.path.join(tmp, 'bad.md')
            open(bad, 'w').write('- | nameless\n-  | \n- real | a name\n')
            SIGNATURE_FILE = bad
            sigs, _ = load_signatures()
            assert sigs == [('real', 'a name')], sigs
        finally:
            SIGNATURE_FILE = keep
    print('selfcheck ok: claude, codex, opencode readers, the tally and the signature loader')


if __name__ == '__main__':
    main()
