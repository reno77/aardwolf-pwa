"""Populate gaardian_maps.db's `labels` table from the Gaardian web maps.

The DB ships with `labels` empty across all 269 areas, and those labels are the only place
the puzzle hints live. The room graph tells you an exit is `give vegetable Sarah`; the
label tells you to *kill a farmer, wear conadrain clothes, be visible, then give*. Without
them The Empire of Talsa reads as an unsolvable fetch chain -- which is exactly the wrong
conclusion I drew from the DB alone.

The web page carries them as JavaScript:

    labels[7] = new MapLabel(4, 11, 2, "Kill a farmer ...", "blue", 21);

which lines up 1:1 with the table's (xpos, ypos, width, text, color, type). The site's
areaid is the same number as the DB's, so no name matching is needed.

Resumable: areas that already have labels are skipped, so an interrupted run can just be
re-run. Polite by default -- one request at a time with a delay, because this is somebody
else's server doing us a favour.

    python tools/fetch_map_labels.py [--force] [--delay 0.4] [--only 119,131]
"""
import argparse, re, sqlite3, sys, time, urllib.error, urllib.request

DB  = "pwa/gaardian_maps.db"
URL = "https://maps.gaardian.com/index.php?areaid=%d"
UA  = "aardwolf-pwa map-label sync (personal client; contact via github.com/reno77/aardwolf-pwa)"

# new MapLabel(4, 11, 2, "text", "blue", 21)
# The text is a JS double-quoted string, so it may contain \" and \\.
LABEL = re.compile(
    r'new\s+MapLabel\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*'
    r'"((?:[^"\\]|\\.)*)"\s*,\s*"([^"]*)"\s*,\s*(-?\d+)\s*\)'
)

def unescape(s):
    return s.replace('\\"', '"').replace("\\'", "'").replace('\\\\', '\\').replace('\\/', '/')

def fetch(areaid, tries=3, delay=1.0):
    req = urllib.request.Request(URL % areaid, headers={"User-Agent": UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None            # area not published; not an error worth retrying
            if attempt == tries - 1:
                raise
        except Exception:
            if attempt == tries - 1:
                raise
        time.sleep(delay * (attempt + 1))
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-fetch areas that already have labels")
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between requests")
    ap.add_argument("--only", default="", help="comma-separated areaids, for testing")
    a = ap.parse_args()

    db = sqlite3.connect(DB)
    cur = db.cursor()
    ids = [int(x) for x in a.only.split(",") if x.strip()] or \
          [r[0] for r in cur.execute("SELECT areaid FROM areas ORDER BY areaid")]
    have = {r[0] for r in cur.execute("SELECT DISTINCT areaid FROM labels")}

    done = added = skipped = missing = 0
    for areaid in ids:
        if areaid in have and not a.force:
            skipped += 1
            continue
        try:
            html = fetch(areaid)
        except Exception as e:
            print("area %-4s FAILED %s" % (areaid, e), flush=True)
            continue
        if html is None:
            missing += 1
            continue

        rows = []
        for m in LABEL.finditer(html):
            x, y, w, text, color, typ = m.groups()
            text = unescape(text).strip()
            if text:
                rows.append((areaid, int(x), int(y), int(w), text, color, int(typ)))
        if a.force:
            cur.execute("DELETE FROM labels WHERE areaid=?", (areaid,))
        if rows:
            cur.executemany(
                "INSERT INTO labels(areaid,xpos,ypos,width,text,color,type) VALUES (?,?,?,?,?,?,?)",
                rows)
            added += len(rows)
        db.commit()
        done += 1
        if done % 25 == 0:
            print("...%d areas, %d labels so far" % (done, added), flush=True)
        time.sleep(a.delay)

    print("fetched %d area(s), %d label(s) added, %d already had labels, %d not published"
          % (done, added, skipped, missing))

if __name__ == "__main__":
    sys.exit(main())
