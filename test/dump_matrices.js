// Emits our QR matrices as JSON so the Python side can diff them against segno.
// Usage: node dump_matrices.js <corpus.json> > out.json
const fs = require('fs');
const path = require('path');
const QR = require(path.join(__dirname, '..', 'src', 'qr.js'));

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = [];

for (const c of cases) {
  try {
    const q = QR.encode(c.text, { ecl: c.ecl, mask: c.mask, boost: false, padQuirk: !!c.padQuirk });
    out.push({
      text: c.text, ecl: c.ecl, mask: c.mask,
      ok: true,
      version: q.version, size: q.size, chosenMask: q.mask, chosenEcl: q.ecl,
      // one string of '0'/'1' per row
      rows: q.modules.map(r => r.map(v => (v ? '1' : '0')).join(''))
    });
  } catch (e) {
    out.push({ text: c.text, ecl: c.ecl, mask: c.mask, ok: false, error: String(e.message || e) });
  }
}

const self = QR._internal.rsGeneratorSelfTest();
process.stdout.write(JSON.stringify({ rsSelfTest: self, cases: out }));
