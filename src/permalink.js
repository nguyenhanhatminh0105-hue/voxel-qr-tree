/* Share and restore the scene from the address bar.

   The whole point of this app is producing something worth sending to
   somebody, and until now the result lived only in memory: no way to share a
   particular tree, bookmark one, or reload without losing it.

   State rides in the HASH, not the query string, because the app is required
   to run from a file:// URL. A hash is readable with no API at all, survives
   `file://`, and never reaches a server. Writing it goes through
   `history.replaceState` so the back button stays useful - pushState on every
   swatch click would bury the page the visitor arrived from under thirty
   entries of their own fiddling.

   Every write is wrapped: some browsers refuse History calls on file://, and
   a refusal must cost the URL bar, never the app. Reading is plain string
   work and cannot throw.

     #u=<encoded url>&s=<species>&c=<swatch>

   `c` is omitted when the swatch is null, which means "use the species' own
   foliage colour" - a present-but-empty value would be a third state that
   does not exist. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Permalink = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function parse(hash) {
    var out = { text: null, species: null, swatch: null };
    if (!hash) return out;
    var s = String(hash).replace(/^#/, '');
    if (!s) return out;
    var parts = s.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      var k = parts[i].slice(0, eq);
      var v = parts[i].slice(eq + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { continue; }
      if (k === 'u' && v) out.text = v;
      else if (k === 's' && v) out.species = v;
      else if (k === 'c' && v) out.swatch = v;
    }
    return out;
  }

  /* Only ever hand back a species the build actually has. A hash is visitor
     input: a stale or hand-edited `s=gum` would otherwise reach the planter,
     which throws on an unknown species by design, and take the page down on
     load. Unknown values fall back to the default rather than failing. */
  function pick(value, allowed, fallback) {
    if (!value) return fallback;
    for (var i = 0; i < allowed.length; i++) if (allowed[i] === value) return value;
    return fallback;
  }

  function build(state) {
    var out = 'u=' + encodeURIComponent(state.text || '') +
              '&s=' + encodeURIComponent(state.species || '');
    if (state.swatch) out += '&c=' + encodeURIComponent(state.swatch);
    return '#' + out;
  }

  function write(state) {
    var hash = build(state);
    if (typeof location === 'undefined') return hash;
    if (location.hash === hash) return hash;      // nothing to say
    try {
      history.replaceState(null, '', hash);
    } catch (e) {
      /* File-protocol History refusals land here. The scene is already
         correct on screen; only the address bar misses out. */
    }
    return hash;
  }

  function read() {
    return parse(typeof location !== 'undefined' ? location.hash : '');
  }

  return { parse: parse, build: build, read: read, write: write, pick: pick };
}));
