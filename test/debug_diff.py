import json, subprocess, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
import segno

text = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
ecl = sys.argv[2] if len(sys.argv) > 2 else "L"
mask = int(sys.argv[3]) if len(sys.argv) > 3 else 0

corpus = os.path.join(HERE, "_dbg.json")
json.dump([{"text": text, "ecl": ecl, "mask": mask, "padQuirk": True}], open(corpus, "w"))
res = subprocess.run(["node", os.path.join(HERE, "dump_matrices.js"), corpus],
                     capture_output=True, text=True, encoding="utf-8")
d = json.loads(res.stdout)["cases"][0]
ours = d["rows"]
ver = d["version"]
q = segno.make(text, version=ver, error=ecl, mask=mask, boost_error=False, mode="byte")
seg = ["".join("1" if v else "0" for v in row) for row in q.matrix]

n = len(ours)
print(f"version {ver} ecl {ecl} mask {mask} size {n}")
print()
print("  ours" + " " * (n - 2) + "   segno" + " " * (n - 3) + "   diff")
for y in range(n):
    dr = "".join("X" if a != b else "." for a, b in zip(ours[y], seg[y]))
    tr = lambda s: s.replace("1", "#").replace("0", " ")
    print(f"{y:3} |{tr(ours[y])}| |{tr(seg[y])}| |{dr}|")
print()
print("total diff:", sum(a != b for ra, rb in zip(ours, seg) for a, b in zip(ra, rb)))
