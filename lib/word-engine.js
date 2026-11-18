/*
 * LoonaWords — shared word engine for the Loona Word Unscrambler suite.
 * Dictionary: ENABLE (Enhanced North American Benchmark Lexicon), public domain.
 * Loads lib/enable-words.txt.gz (sibling of this script) once, builds indexes,
 * then answers unscramble / pattern / validity / score queries fully on-device.
 *
 * Usage (browser):
 *   <script src=".../lib/word-engine.js"></script>
 *   await LoonaWords.load();
 *   LoonaWords.unscramble('retina?');  // [{w:'retinas', s:6}, ...]
 *   LoonaWords.pattern('c?oss?ord');   // ['crossword', ...]
 *   LoonaWords.isValid('zyzzyva');     // true
 *   LoonaWords.scoreWord('zyzzyva');   // 43
 *
 * Also require()-able in Node (module.exports guard) for testing.
 */
(function (global) {
  'use strict';

  var LETTER_VALUES = {
    a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3,
    n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10
  };
  var VALUES = new Int8Array(26);
  Object.keys(LETTER_VALUES).forEach(function (ch) {
    VALUES[ch.charCodeAt(0) - 97] = LETTER_VALUES[ch];
  });

  // ---- state -------------------------------------------------------------
  var words = [];            // sorted array of all words
  var wordSet = new Set();   // validity lookup
  var byLength = new Map();  // length -> array of words (alphabetical)
  // Anagram groups: signature (sorted letters) -> { counts:Uint8Array(26), len, words:[...] }
  var sigGroups = [];
  var loaded = false;
  var loadPromise = null;

  // ---- base-URL resolution -------------------------------------------------
  // The wordlist and the pako fallback live next to THIS script, wherever the
  // including page sits, so resolve from the script's own URL.
  function engineBase() {
    if (typeof document !== 'undefined') {
      var src = null;
      if (document.currentScript && document.currentScript.src) {
        src = document.currentScript.src;
      } else {
        var tags = document.getElementsByTagName('script');
        for (var i = tags.length - 1; i >= 0; i--) {
          var s = tags[i].src || '';
          if (/word-engine\.js($|[?#])/.test(s)) { src = s; break; }
        }
      }
      if (src) return src.replace(/word-engine\.js.*$/, '');
    }
    return null; // Node: handled via __dirname
  }

  function isNode() {
    return typeof window === 'undefined' &&
      typeof module !== 'undefined' && !!module.exports &&
      typeof require === 'function';
  }

  // ---- decompression -------------------------------------------------------
  async function gunzipViaStream(buf) {
    var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  function loadPakoBrowser(base) {
    return new Promise(function (resolve, reject) {
      if (global.pako && (global.pako.ungzip || global.pako.inflate)) return resolve(global.pako);
      var sc = document.createElement('script');
      sc.src = base + 'pako_inflate.min.js';
      sc.onload = function () {
        if (global.pako) resolve(global.pako);
        else reject(new Error('pako loaded but window.pako missing'));
      };
      sc.onerror = function () { reject(new Error('failed to load pako_inflate.min.js')); };
      document.head.appendChild(sc);
    });
  }

  async function gunzipToText(buf, base) {
    // Preferred: native DecompressionStream (all modern browsers, Node >= 17).
    if (typeof DecompressionStream !== 'undefined') {
      try { return await gunzipViaStream(buf); } catch (e) { /* fall through to pako */ }
    }
    // Fallback: pako (MIT). Gzip data needs ungzip; inflate is the zlib format.
    var pako = null;
    if (global.pako) pako = global.pako;
    else if (isNode()) {
      try {
        var path = require('path');
        pako = require(path.join(__dirname, 'pako_inflate.min.js'));
      } catch (e) { /* fall through */ }
    } else if (base) {
      pako = await loadPakoBrowser(base);
    }
    if (pako) {
      var out = (pako.ungzip || pako.inflate)(new Uint8Array(buf));
      return new TextDecoder('utf-8').decode(out);
    }
    // Last resort in Node: zlib.
    if (isNode()) {
      var zlib = require('zlib');
      return zlib.gunzipSync(Buffer.from(buf)).toString('utf-8');
    }
    throw new Error('No gzip decompressor available (no DecompressionStream, no pako)');
  }

  async function fetchWordlistText(customUrl) {
    if (isNode()) {
      var fs = require('fs');
      var path = require('path');
      var file = customUrl || path.join(__dirname, 'enable-words.txt.gz');
      var buf = fs.readFileSync(file);
      return await gunzipToText(buf, null);
    }
    var base = engineBase();
    var url = customUrl || (base ? base + 'enable-words.txt.gz' : 'enable-words.txt.gz');
    var res = await fetch(url);
    if (!res.ok) throw new Error('wordlist fetch failed: HTTP ' + res.status + ' for ' + url);
    var buf2 = await res.arrayBuffer();
    return await gunzipToText(buf2, base);
  }

  // ---- indexing --------------------------------------------------------------
  function buildIndexes(text) {
    words = text.split(/\s+/).filter(function (w) { return w.length > 0; });
    wordSet = new Set(words);
    byLength = new Map();
    var sigMap = new Map();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var arr = byLength.get(w.length);
      if (!arr) { arr = []; byLength.set(w.length, arr); }
      arr.push(w);
      var counts = new Uint8Array(26);
      for (var j = 0; j < w.length; j++) counts[w.charCodeAt(j) - 97]++;
      var sig = '';
      for (var c = 0; c < 26; c++) {
        if (counts[c]) sig += String.fromCharCode(97 + c).repeat(counts[c]);
      }
      var g = sigMap.get(sig);
      if (!g) {
        g = { counts: counts, len: w.length, words: [] };
        sigMap.set(sig, g);
      }
      g.words.push(w);
    }
    sigGroups = Array.from(sigMap.values());
    loaded = true;
  }

  // ---- public API --------------------------------------------------------------
  function load(customUrl) {
    if (loadPromise) return loadPromise; // idempotent
    loadPromise = (async function () {
      var text = await fetchWordlistText(customUrl);
      buildIndexes(text);
      return api;
    })();
    // Allow a retry after a failed load.
    loadPromise.catch(function () { loadPromise = null; loaded = false; });
    return loadPromise;
  }

  function ensureLoaded() {
    if (!loaded) throw new Error('LoonaWords: dictionary not loaded — await LoonaWords.load() first');
  }

  function scoreWord(word) {
    var w = String(word).toLowerCase();
    var s = 0;
    for (var i = 0; i < w.length; i++) {
      var v = LETTER_VALUES[w[i]];
      if (v) s += v;
    }
    return s;
  }

  function isValid(word) {
    ensureLoaded();
    return wordSet.has(String(word).toLowerCase());
  }

  /*
   * unscramble(letters): letters = a-z plus '?' blanks (up to 15 chars total).
   * Returns [{w, s}] for every dictionary word whose letter multiset fits the
   * rack. Letters a word needs beyond the rack counts must be covered by
   * blanks, and those instances score 0. Sorted: score desc, length desc, A-Z.
   */
  function unscramble(letters) {
    ensureLoaded();
    var rack = String(letters).toLowerCase().replace(/[^a-z?]/g, '');
    var rackCounts = new Uint8Array(26);
    var blanks = 0;
    for (var i = 0; i < rack.length; i++) {
      if (rack[i] === '?') blanks++;
      else rackCounts[rack.charCodeAt(i) - 97]++;
    }
    var rackLen = rack.length;
    var out = [];
    for (var gi = 0; gi < sigGroups.length; gi++) {
      var g = sigGroups[gi];
      if (g.len > rackLen || g.len < 2) continue;
      var deficit = 0;
      var score = 0;
      for (var c = 0; c < 26; c++) {
        var need = g.counts[c];
        if (!need) continue;
        var have = rackCounts[c];
        if (need > have) deficit += need - have;
        score += Math.min(need, have) * VALUES[c];
        if (deficit > blanks) break;
      }
      if (deficit > blanks) continue;
      for (var wi = 0; wi < g.words.length; wi++) out.push({ w: g.words[wi], s: score });
    }
    out.sort(function (a, b) {
      return b.s - a.s || b.w.length - a.w.length || (a.w < b.w ? -1 : a.w > b.w ? 1 : 0);
    });
    return out;
  }

  /*
   * pattern(p): p = a-z plus '?' wildcards. Returns every word of exactly
   * p.length matching the fixed letters, in alphabetical order.
   */
  function pattern(p) {
    ensureLoaded();
    var pat = String(p).toLowerCase();
    if (/[^a-z?]/.test(pat)) return [];
    var cand = byLength.get(pat.length);
    if (!cand) return [];
    var fixed = [];
    for (var i = 0; i < pat.length; i++) if (pat[i] !== '?') fixed.push([i, pat[i]]);
    if (!fixed.length) return cand.slice();
    var out = [];
    for (var k = 0; k < cand.length; k++) {
      var w = cand[k];
      var ok = true;
      for (var f = 0; f < fixed.length; f++) {
        if (w[fixed[f][0]] !== fixed[f][1]) { ok = false; break; }
      }
      if (ok) out.push(w);
    }
    return out;
  }

  var api = {
    load: load,
    unscramble: unscramble,
    pattern: pattern,
    isValid: isValid,
    scoreWord: scoreWord,
    LETTER_VALUES: LETTER_VALUES,
    get loaded() { return loaded; },
    get wordCount() { return words.length; },
    get words() { return words; }
  };

  global.LoonaWords = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
