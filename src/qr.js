/* ===========================================================================
   qr.js - QR Code encoder, written from scratch.
   Byte mode only. Versions 1..20. ECC levels L / M / Q / H.

   Structure follows ISO/IEC 18004. Block geometry is derived rather than
   tabulated: only the EC-codewords-per-block and block-count tables are
   literal, everything else (total codewords, short/long block split) falls
   out of the function-pattern module count.

   Works as a plain <script> (defines window.QR) and under Node.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- error correction levels -------------------------------------------
  // .ord indexes the tables below; .bits is the 2-bit value baked into the
  // format information (deliberately not the same order as .ord).
  var ECL = {
    L: { ord: 0, bits: 1 },
    M: { ord: 1, bits: 0 },
    Q: { ord: 2, bits: 3 },
    H: { ord: 3, bits: 2 }
  };

  // ECC codewords per block, indexed [ecl.ord][version]. Index 0 unused.
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28]
  ];

  // Number of error correction blocks, indexed [ecl.ord][version].
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25]
  ];

  var MIN_VERSION = 1, MAX_VERSION = 20;
  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  // --- GF(256) arithmetic, primitive polynomial 0x11D, generator 2 --------
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /* Reed-Solomon generator polynomial of the given degree.
     g(x) = (x - a^0)(x - a^1) ... (x - a^(degree-1))

     Coefficients run from the HIGHEST power down to x^0, with the leading
     coefficient (always 1) omitted. Building this reversed is the classic
     trap: at degree 1 the answer is the single element [1] either way, so the
     mistake only surfaces at degree 2, where the correct result is [3, 2] and
     the reversed one is [2, 3]. rsGeneratorSelfTest pins that case down. */
  function rsGeneratorPoly(degree) {
    var result = new Uint8Array(degree);
    result[degree - 1] = 1;          // start as the polynomial "1"
    var root = 1;                    // a^0
    for (var i = 0; i < degree; i++) {
      // multiply the accumulated polynomial by (x - root)
      for (var j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, generator) {
    var result = new Uint8Array(generator.length);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (var j = 0; j < result.length; j++) {
        result[j] ^= gfMul(generator[j], factor);
      }
    }
    return result;
  }

  // Exposed so the harness can assert the non-reversed ordering directly.
  function rsGeneratorSelfTest() {
    var d1 = rsGeneratorPoly(1);
    var d2 = rsGeneratorPoly(2);
    var d7 = rsGeneratorPoly(7);
    return {
      deg1: Array.from(d1),
      deg2: Array.from(d2),
      deg7: Array.from(d7),
      ok: d1[0] === 1 && d2[0] === 3 && d2[1] === 2
    };
  }

  // --- capacity ----------------------------------------------------------
  // Data+ecc bits available once every function pattern is removed.
  function numRawDataModules(ver) {
    var size = ver * 4 + 17;
    var result = size * size;
    result -= 8 * 8 * 3;             // three finder patterns + separators
    result -= 15 * 2 + 1;            // two format info strips + dark module
    result -= (size - 16) * 2;       // timing patterns outside the finders
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (numAlign - 1) * (numAlign - 1) * 25;   // free-standing alignment
      result -= (numAlign - 2) * 2 * 20;                // alignment over timing
      if (ver >= 7) result -= 6 * 3 * 2;                // version info blocks
    }
    return result;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8)
      - ECC_PER_BLOCK[ecl.ord][ver] * NUM_BLOCKS[ecl.ord][ver];
  }

  function charCountBits(ver) {
    return ver <= 9 ? 8 : 16;        // byte mode, versions 1..26
  }

  function alignmentPatternPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var size = ver * 4 + 17;
    var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  // --- bit buffer --------------------------------------------------------
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.append = function (value, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function toUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  // --- codeword assembly -------------------------------------------------
  function buildCodewords(bytes, ver, ecl, padQuirk) {
    var capacity = numDataCodewords(ver, ecl) * 8;
    var bb = new BitBuffer();
    bb.append(4, 4);                                  // byte mode indicator
    bb.append(bytes.length, charCountBits(ver));
    for (var i = 0; i < bytes.length; i++) bb.append(bytes[i], 8);
    if (bb.bits.length > capacity) return null;

    // terminator, then pad to a byte boundary, then alternating pad bytes
    bb.append(0, Math.min(4, capacity - bb.bits.length));

    /* padQuirk reproduces segno's write_padding_bits, which computes
       8 - (length % 8) and so appends a whole spurious zero byte when the
       stream is already byte-aligned. In byte mode the stream is
       4 + count + 8n bits, which after a full 4-bit terminator is *always*
       aligned - so segno always inserts that byte. Only the test harness sets
       this, to prove the padding is the single point of divergence. */
    if (padQuirk && bb.bits.length + 8 <= capacity) {
      bb.append(0, 8 - bb.bits.length % 8);
    } else {
      bb.append(0, (8 - bb.bits.length % 8) % 8);
    }

    for (var pad = 0xEC; bb.bits.length < capacity; pad ^= 0xEC ^ 0x11) {
      bb.append(pad, 8);
    }

    var dataCw = new Uint8Array(bb.bits.length / 8);
    for (var k = 0; k < bb.bits.length; k++) {
      dataCw[k >>> 3] |= bb.bits[k] << (7 - (k & 7));
    }
    return dataCw;
  }

  // Split into blocks, compute ECC, interleave.
  function addEccAndInterleave(data, ver, ecl) {
    var numBlocks = NUM_BLOCKS[ecl.ord][ver];
    var blockEccLen = ECC_PER_BLOCK[ecl.ord][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - rawCodewords % numBlocks;
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);

    /* Every block is stored at the LONG block length, even the short ones.
       A short block leaves a placeholder in its final data slot, which the
       interleave loop below skips. Without that placeholder the ECC section
       of a short block starts one index early, and the skip lands on a real
       error correction codeword instead of the pad - the whole ECC run comes
       out shifted by one and the symbol is quietly corrupt. */
    var blockLen = shortBlockLen + 1;
    var eccStart = blockLen - blockEccLen;
    var blocks = [];
    var gen = rsGeneratorPoly(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var dlen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
      var dat = data.subarray(k, k + dlen);
      k += dlen;
      var block = new Uint8Array(blockLen);
      block.set(dat, 0);
      block.set(rsRemainder(dat, gen), eccStart);
      blocks.push(block);
    }

    var result = new Uint8Array(rawCodewords);
    var idx = 0;
    for (var col = 0; col < blockLen; col++) {
      for (var b = 0; b < numBlocks; b++) {
        // skip the placeholder that short blocks carry in the last data column
        if (col !== shortBlockLen - blockEccLen || b >= numShortBlocks) {
          result[idx++] = blocks[b][col];
        }
      }
    }
    return result;
  }

  // --- matrix ------------------------------------------------------------
  function QRCode(ver, ecl, dataCodewords, forcedMask) {
    this.version = ver;
    this.ecl = ecl;
    this.size = ver * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(addEccAndInterleave(dataCodewords, ver, ecl));

    var mask = forcedMask;
    if (mask === undefined || mask === null || mask < 0) {
      var minPenalty = Infinity;
      for (var m = 0; m < 8; m++) {
        this.applyMask(m);
        this.drawFormatBits(m);
        var p = this.penaltyScore();
        if (p < minPenalty) { minPenalty = p; mask = m; }
        this.applyMask(m);                              // undo (XOR is its own inverse)
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  QRCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  };

  QRCode.prototype.drawFunctionPatterns = function () {
    var size = this.size, i, j;
    for (i = 0; i < size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);        // vertical timing
      this.setFunctionModule(i, 6, i % 2 === 0);        // horizontal timing
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(size - 4, 3);
    this.drawFinderPattern(3, size - 4);

    var alignPos = alignmentPatternPositions(this.version);
    var n = alignPos.length;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        // skip the three corners, occupied by finder patterns
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) {
          this.drawAlignmentPattern(alignPos[i], alignPos[j]);
        }
      }
    }
    this.drawFormatBits(0);                              // placeholder
    this.drawVersion();
  };

  QRCode.prototype.drawFinderPattern = function (cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunctionModule(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  };

  QRCode.prototype.drawAlignmentPattern = function (cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  };

  QRCode.prototype.drawFormatBits = function (mask) {
    var data = (this.ecl.bits << 3) | mask;              // 5 bits
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;           // 15 bits

    var i2;
    for (i2 = 0; i2 <= 5; i2++) this.setFunctionModule(8, i2, getBit(bits, i2));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (i2 = 9; i2 < 15; i2++) this.setFunctionModule(14 - i2, 8, getBit(bits, i2));

    for (i2 = 0; i2 < 8; i2++) this.setFunctionModule(this.size - 1 - i2, 8, getBit(bits, i2));
    for (i2 = 8; i2 < 15; i2++) this.setFunctionModule(8, this.size - 15 + i2, getBit(bits, i2));
    this.setFunctionModule(8, this.size - 8, true);      // always-dark module
  };

  QRCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;               // 18 bits

    for (var j = 0; j < 18; j++) {
      var bit = getBit(bits, j);
      var a = this.size - 11 + j % 3;
      var b = Math.floor(j / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  };

  QRCode.prototype.drawCodewords = function (data) {
    var i = 0;                                           // bit index
    for (var right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                        // column 6 is the timing pattern
      for (var vert = 0; vert < this.size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
          // remainder bits past the data stream stay light
        }
      }
    }
  };

  QRCode.prototype.applyMask = function (mask) {
    for (var y = 0; y < this.size; y++) {
      for (var x = 0; x < this.size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
          default: throw new Error('bad mask');
        }
        if (!this.isFunction[y][x] && invert) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  };

  // --- penalty scoring ---------------------------------------------------
  QRCode.prototype.penaltyScore = function () {
    var result = 0, size = this.size, x, y;

    // Rule 1 (plus rule 3, which rides the same run scan).
    for (y = 0; y < size; y++) {
      var runColor = false, runX = 0, runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    for (x = 0; x < size; x++) {
      var runColorV = false, runY = 0, runHistoryV = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (this.modules[y][x] === runColorV) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistoryV);
          if (!runColorV) result += this.finderPenaltyCountPatterns(runHistoryV) * PENALTY_N3;
          runColorV = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColorV, runY, runHistoryV) * PENALTY_N3;
    }

    // Rule 2: 2x2 blocks of one colour.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 4: proportion of dark modules away from 50%.
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (this.modules[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  };

  /* Rule 3 support (the 1:1:3:1:1 finder lookalike).

     The run-length history is a sliding window of seven runs advanced one run
     at a time, so a given dark core is examined exactly once - the search is
     non-overlapping. Modules outside the symbol count as light: the first run
     of every line is inflated by `size`, and a virtual light run of `size` is
     appended at the end. Both halves matter. Drop the border and edge-hugging
     lookalikes go unpenalised; let the window overlap and one core gets scored
     repeatedly. Either way mask selection drifts toward codes that real
     scanners struggle with. */
  QRCode.prototype.finderPenaltyAddHistory = function (currentRunLength, runHistory) {
    if (runHistory[0] === 0) currentRunLength += this.size;   // leading light border
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  };

  QRCode.prototype.finderPenaltyCountPatterns = function (runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3
      && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  };

  QRCode.prototype.finderPenaltyTerminateAndCount = function (currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {                                    // close the dark run
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size;                            // trailing light border
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  };

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // --- public entry point ------------------------------------------------
  function encode(text, opts) {
    opts = opts || {};
    var eclName = (opts.ecl || 'M').toUpperCase();
    var baseEcl = ECL[eclName];
    if (!baseEcl) throw new Error('unknown ecc level: ' + eclName);
    var ecl = baseEcl;
    var bytes = typeof text === 'string' ? toUtf8(text) : Array.from(text);

    var minVer = Math.max(MIN_VERSION, opts.minVersion || MIN_VERSION);
    var maxVer = Math.min(MAX_VERSION, opts.maxVersion || MAX_VERSION);
    var ver = null, dataCw = null;
    for (var v = minVer; v <= maxVer; v++) {
      var cw = buildCodewords(bytes, v, ecl, opts.padQuirk);
      if (cw) { ver = v; dataCw = cw; break; }
    }
    if (ver === null) {
      throw new Error('data too long for version ' + maxVer + ' at level ' + eclName +
        ' (' + bytes.length + ' bytes)');
    }

    // Optionally raise the ECC level for free if the data still fits.
    if (opts.boost) {
      var order = ['L', 'M', 'Q', 'H'];
      for (var oi = order.length - 1; oi > baseEcl.ord; oi--) {
        var better = ECL[order[oi]];
        var cw2 = buildCodewords(bytes, ver, better, opts.padQuirk);
        if (cw2) { ecl = better; dataCw = cw2; break; }
      }
    }

    var qr = new QRCode(ver, ecl, dataCw, opts.mask);
    var eclName2 = Object.keys(ECL).filter(function (k) { return ECL[k] === ecl; })[0];
    return {
      version: qr.version,
      size: qr.size,
      mask: qr.mask,
      ecl: eclName2,
      modules: qr.modules,
      get: function (x, y) {
        return x >= 0 && y >= 0 && x < qr.size && y < qr.size ? qr.modules[y][x] : false;
      }
    };
  }

  return {
    encode: encode,
    MIN_VERSION: MIN_VERSION,
    MAX_VERSION: MAX_VERSION,
    _internal: {
      rsGeneratorPoly: rsGeneratorPoly,
      rsGeneratorSelfTest: rsGeneratorSelfTest,
      numRawDataModules: numRawDataModules,
      numDataCodewords: numDataCodewords,
      alignmentPatternPositions: alignmentPatternPositions,
      ECL: ECL,
      debugCodewords: function (text, ver, eclName, padQuirk) {
        var ecl = ECL[eclName];
        var bytes = toUtf8(text);
        var d = buildCodewords(bytes, ver, ecl, padQuirk);
        return { data: Array.from(d), final: Array.from(addEccAndInterleave(d, ver, ecl)) };
      }
    }
  };
});
