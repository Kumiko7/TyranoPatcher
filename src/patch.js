/*
 * TyranoPatcher runtime patch
 *
 * Injected into the game page by TyranoPatcher.exe through the DevTools protocol.
 * Written in ES5 so it also runs on old NW.js based TyranoScript builds.
 *
 *  - Transition skip: left click / Enter while the engine is blocked on a transition, [wait],
 *    [wt], [wa], a character fade etc. instantly finishes it and moves on.
 *  - Fast skip: while the game's skip mode is on, every engine wait / animation is collapsed to
 *    ~0ms instead of playing out (or being cut to 70ms per effect).
 *  - Rollback: a hotkey (Backspace / PageUp / mouse back button by default) returns to the state
 *    of the previous line of text; press repeatedly to go further back.
 */
(function () {
  'use strict';

  var W = window;
  if (W.__tyranoPatcher) return;

  var CFG = W.__tyranoPatcherConfig || {};
  if (CFG.transitionSkip === undefined) CFG.transitionSkip = true;
  if (CFG.fastSkip === undefined) CFG.fastSkip = true;
  if (CFG.toast === undefined) CFG.toast = true;
  if (CFG.skipSoundEffects === undefined) CFG.skipSoundEffects = true;
  if (CFG.rollback === undefined) CFG.rollback = true;
  if (CFG.rollbackKeys === undefined) CFG.rollbackKeys = 'Backspace, PageUp';
  if (CFG.rollbackMouseBack === undefined) CFG.rollbackMouseBack = true;
  if (!(CFG.rollbackHistory > 0)) CFG.rollbackHistory = 300;

  var P = W.__tyranoPatcher = { version: '1.1.1', config: CFG, stats: { flushes: 0, skipFlushes: 0, rollbacks: 0 } };

  var nativeSetTimeout = W.setTimeout;
  var nativeClearTimeout = W.clearTimeout;
  var nativeRaf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : null;
  var slice = Array.prototype.slice;

  var kag = null;        // TYRANO.kag once the engine is up
  var depth = 0;         // > 0 while engine code (tag execution) is on the stack
  var timers = [];       // pending timers created by engine code
  var fakeTimerId = 1e9; // ids for timers scheduled through the MessageChannel
  var sfDirty = false;   // system variables changed but not written yet (fast skip)
  var saveSystemVariableOrig = null;
  var wasSkipping = false;
  var swallowClickUntil = 0;
  var frozen = false;    // engine progression blocked while a rollback tears down the old state
  var generation = 0;    // bumped on rollback; async callbacks from an older generation are dropped

  // Tags that run user JavaScript; timers they create are the game's own business.
  var SCRIPT_TAGS = { iscript: 1, endscript: 1, eval: 1, emb: 1, loadjs: 1, html: 1, endhtml: 1 };

  function now() {
    return W.performance && performance.now ? performance.now() : new Date().getTime();
  }

  function log() {
    try { console.log.apply(console, ['[TyranoPatcher]'].concat(slice.call(arguments))); } catch (e) {}
  }

  function currentTagName() {
    try {
      var f = kag.ftag;
      var t = f.array_tag[f.current_order_index];
      return (t && t.name) || '';
    } catch (e) {
      return '';
    }
  }

  function isSkipping() {
    return !!(kag && kag.stat && kag.stat.is_skip === true);
  }

  function jQueries() {
    var list = [];
    var cands = [W.jQuery, W.$];
    for (var i = 0; i < cands.length; i++) {
      var q = cands[i];
      if (typeof q === 'function' && q.fn && q.fn.jquery && list.indexOf(q) < 0) list.push(q);
    }
    return list;
  }

  // ---------------------------------------------------------------------------------------------
  // Timer tracking. Every setTimeout created while engine code is running is remembered so it can
  // be fired early (transition skip) or created with a 0ms delay (fast skip).
  // ---------------------------------------------------------------------------------------------

  function findTimer(id) {
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) return i;
    return -1;
  }

  function removeTimer(rec) {
    var i = timers.indexOf(rec);
    if (i >= 0) timers.splice(i, 1);
    return i >= 0;
  }

  // Zero-delay task queue. Nested setTimeout(fn, 0) gets clamped to 4ms by the browser, which
  // adds up to seconds over a skipped chapter; a MessageChannel message has no clamp but is still
  // a separate task, so the engine's callback ordering is unchanged.
  var immediateQueue = [];
  var channel = null;
  try {
    if (W.MessageChannel) {
      channel = new MessageChannel();
      channel.port1.onmessage = function () {
        var job = immediateQueue.shift();
        if (job) job();
      };
    }
  } catch (e) {
    channel = null;
  }

  W.setTimeout = function (fn, delay) {
    if (depth === 0 || !kag || typeof fn !== 'function') return nativeSetTimeout.apply(W, arguments);
    var tag = currentTagName();
    if (SCRIPT_TAGS[tag]) return nativeSetTimeout.apply(W, arguments);

    var args = slice.call(arguments, 2);
    var ms = Number(delay) || 0;
    var fast = CFG.fastSkip && isSkipping();
    if (fast) ms = 0;

    var rec = { fn: fn, args: args, tag: tag, id: null };
    // Text is typed through a chain of timers that ends by advancing the engine. Keep tracking
    // that chain so a rollback can cancel it. (Other chains, e.g. looping frame animations, are
    // deliberately not followed.)
    var propagate = tag === 'text';
    var run = function () {
      if (!removeTimer(rec)) return; // cleared or already fired by flush()
      if (!propagate) return fn.apply(W, args);
      depth++;
      try {
        fn.apply(W, args);
      } finally {
        depth--;
      }
    };
    if (fast && channel) {
      rec.id = ++fakeTimerId;
      rec.fake = true;
      immediateQueue.push(run);
      channel.port2.postMessage(0);
    } else {
      rec.id = nativeSetTimeout(run, ms);
    }
    timers.push(rec);
    return rec.id;
  };

  W.clearTimeout = function (id) {
    var i = findTimer(id);
    if (i >= 0) {
      var rec = timers.splice(i, 1)[0];
      if (rec.fake) return undefined;
    }
    return nativeClearTimeout.apply(W, arguments);
  };

  function flushSystemVariables() {
    if (!sfDirty || !saveSystemVariableOrig) return;
    sfDirty = false;
    try { saveSystemVariableOrig.call(kag); } catch (e) { log('save error', e); }
  }

  function inEngine(fn) {
    return function () {
      depth++;
      try {
        return fn.apply(this, arguments);
      } finally {
        depth--;
      }
    };
  }

  // before(args) may return false to swallow the call.
  function wrapMethod(obj, name, before, after) {
    var orig = obj && obj[name];
    if (typeof orig !== 'function' || orig.__tyranoPatcher) return;
    var w = function () {
      if (frozen) return false;
      if (before && before.apply(this, arguments) === false) return false;
      depth++;
      try {
        return orig.apply(this, arguments);
      } finally {
        depth--;
        if (after) after.apply(this, arguments);
      }
    };
    w.__tyranoPatcher = true;
    obj[name] = w;
  }

  function wrapEngine() {
    var f = kag.ftag;
    var names = ['nextOrderWithLabel', 'nextOrderWithTag', 'startTag', 'buildTag', 'buildTagIndex', 'completeTrans'];
    for (var i = 0; i < names.length; i++) wrapMethod(f, names[i]);
    wrapMethod(f, 'nextOrder', beforeNextOrder);
    wrapMethod(f, 'nextOrderWithIndex', null, checkRestored);
    wrapRollbackHooks(f);

    // Callbacks of image preloads continue tag execution (bg, chara_show, chara_mod ...).
    if (typeof kag.preload === 'function' && !kag.preload.__tyranoPatcher) {
      var origPreload = kag.preload;
      kag.preload = function () {
        var args = slice.call(arguments);
        var gen = generation;
        for (var j = 0; j < args.length; j++) {
          if (typeof args[j] !== 'function') continue;
          args[j] = (function (cb) {
            var wrapped = inEngine(cb);
            return function () {
              if (gen !== generation) return undefined; // the tag that asked for it was rolled back
              return wrapped.apply(this, arguments);
            };
          })(args[j]);
        }
        return origPreload.apply(this, args);
      };
      kag.preload.__tyranoPatcher = true;
    }

    // Effects that are cut to 70ms while skipping (skipEffectIgnore) become ~instant.
    if (typeof kag.cutTimeWithSkip === 'function' && !kag.cutTimeWithSkip.__tyranoPatcher) {
      var origCut = kag.cutTimeWithSkip;
      kag.cutTimeWithSkip = function (time) {
        if (CFG.fastSkip && isSkipping()) return 1;
        return origCut.apply(this, arguments);
      };
      kag.cutTimeWithSkip.__tyranoPatcher = true;
    }

    // Every [eval] and every label (read-text tracking) synchronously rewrites the system save
    // file. While skipping, coalesce those writes; they are flushed within a second, when
    // skipping stops and when the page unloads.
    if (typeof kag.saveSystemVariable === 'function' && !kag.saveSystemVariable.__tyranoPatcher) {
      var origSave = kag.saveSystemVariable;
      kag.saveSystemVariable = function () {
        if (!(CFG.fastSkip && isSkipping())) {
          sfDirty = false;
          return origSave.apply(this, arguments);
        }
        if (!sfDirty) {
          sfDirty = true;
          nativeSetTimeout(flushSystemVariables, 1000);
        }
      };
      kag.saveSystemVariable.__tyranoPatcher = true;
      saveSystemVariableOrig = origSave;
    }

    // One-shot sound effects are dropped while skipping. On PC the engine plays every one of them
    // (e.g. a click sound per page); its mobile code path already skips them, so borrow that path
    // by reporting a non-PC environment for the duration of the call.
    var bgm = f.master_tag && f.master_tag.playbgm;
    if (bgm && typeof bgm.start === 'function' && !bgm.start.__tyranoPatcher) {
      var origBgmStart = bgm.start;
      bgm.start = function (pm) {
        if (pm && alreadyPlayingAfterRollback(pm)) {
          // The game's on-load hook (make.ks) re-issued a loop that never stopped; don't restart it.
          if (String(pm.stop) !== 'true') kag.ftag.nextOrder();
          return undefined;
        }
        if (!(CFG.fastSkip && CFG.skipSoundEffects && isSkipping() && pm && pm.target === 'se' &&
          String(pm.loop) !== 'true')) {
          return origBgmStart.apply(this, arguments);
        }
        var qs = jQueries();
        var saved = [];
        for (var k = 0; k < qs.length; k++) {
          if (typeof qs[k].userenv !== 'function') continue;
          saved.push({ q: qs[k], fn: qs[k].userenv });
          qs[k].userenv = function () { return 'sp'; };
        }
        try {
          return origBgmStart.apply(this, arguments);
        } finally {
          for (var m = 0; m < saved.length; m++) saved[m].q.userenv = saved[m].fn;
        }
      };
      bgm.start.__tyranoPatcher = true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Finishing running animations
  // ---------------------------------------------------------------------------------------------

  function isOurs(el) {
    for (; el; el = el.parentNode) if (el.id === '__tyranoPatcherToast') return true;
    return false;
  }

  // CSS animations / transitions / element.animate() through the Web Animations API.
  function webAnimations() {
    if (!document.getAnimations) return null;
    var out = [];
    var all;
    try { all = document.getAnimations(); } catch (e) { return null; }
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (a.playState !== 'running' && a.playState !== 'pending') continue;
      try {
        var t = a.effect && a.effect.getComputedTiming();
        if (!t || !isFinite(t.endTime)) continue; // infinite loops
        if (a.effect.target && isOurs(a.effect.target)) continue;
      } catch (e) {
        continue;
      }
      out.push(a);
    }
    return out;
  }

  // Fallback for runtimes without document.getAnimations(): shrink running CSS animations to 1ms.
  function domAnimations() {
    var out = [];
    var els = document.querySelectorAll('.tyrano_base *, .tyrano_base, body > *');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__tyranoPatcherDone || isOurs(el)) continue;
      var cs = W.getComputedStyle(el);
      var name = cs.animationName || cs.webkitAnimationName;
      if (!name || name === 'none') continue;
      var count = cs.animationIterationCount || cs.webkitAnimationIterationCount || '';
      if (count.indexOf('infinite') >= 0) continue;
      var state = cs.animationPlayState || cs.webkitAnimationPlayState || '';
      if (state.indexOf('paused') >= 0) continue;
      var dur = cs.animationDuration || cs.webkitAnimationDuration || '';
      if (/^(0s|0\.001s|1ms)(,|$)/.test(dur)) continue;
      out.push(el);
    }
    return out;
  }

  function finishDomAnimation(el) {
    el.style.setProperty('animation-duration', '1ms', 'important');
    el.style.setProperty('animation-delay', '0s', 'important');
    el.style.setProperty('-webkit-animation-duration', '1ms', 'important');
    el.style.setProperty('-webkit-animation-delay', '0s', 'important');
  }

  function jqueryTimers() {
    var out = [];
    var qs = jQueries();
    for (var i = 0; i < qs.length; i++) {
      var t = qs[i].timers || [];
      for (var j = 0; j < t.length; j++) out.push({ q: qs[i], t: t[j] });
    }
    return out;
  }

  function hasTimer(q, elem) {
    var t = q.timers || [];
    for (var i = 0; i < t.length; i++) if (t[i].elem === elem) return true;
    return false;
  }

  // Jump each animated element to the end of its current animation, over and over, so queued
  // follow-ups (more animations, .queue(fn) callbacks such as jQuery UI effects' completion) run
  // exactly as they would have. .finish() is not used because it silently drops queued functions.
  function finishJquery(list) {
    var seen = [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      var elem = x.t && x.t.elem;
      if (!elem || seen.indexOf(elem) >= 0) continue;
      seen.push(elem);
      for (var guard = 0; guard < 200 && hasTimer(x.q, elem); guard++) {
        try { x.q(elem).stop(false, true); } catch (e) { break; }
      }
    }
  }

  function animeInstances() {
    var out = [];
    var a = W.anime;
    if (!a || !a.running) return out;
    for (var i = 0; i < a.running.length; i++) {
      var inst = a.running[i];
      if (!inst || inst.paused || inst.loop === true || inst.remaining === Infinity) continue;
      out.push(inst);
    }
    return out;
  }

  // Finish everything the engine is currently waiting on. Returns true if anything was finished.
  function flush() {
    if (!kag) return false;
    var did = false;
    var startIndex = kag.ftag.current_order_index;
    var startScenario = kag.stat.current_scenario;

    for (var pass = 0; pass < 6; pass++) {
      var snapTimers = timers.slice();
      var web = webAnimations();
      var dom = web === null ? domAnimations() : [];
      var jq = jqueryTimers();
      var an = animeInstances();
      var quake2 = kag.tmp && typeof kag.tmp.quake2_finish === 'function';

      if (!snapTimers.length && !(web && web.length) && !dom.length && !jq.length && !an.length && !quake2) break;
      did = true;

      depth++;
      try {
        var i;
        if (web) for (i = 0; i < web.length; i++) { try { web[i].finish(); } catch (e) {} }
        for (i = 0; i < dom.length; i++) finishDomAnimation(dom[i]);
        for (i = 0; i < an.length; i++) { try { an[i].seek(an[i].duration); } catch (e) {} }
        if (jq.length) finishJquery(jq);
        if (quake2 && typeof kag.tmp.quake2_finish === 'function') { try { kag.tmp.quake2_finish(); } catch (e) {} }

        for (i = 0; i < snapTimers.length; i++) {
          var rec = snapTimers[i];
          if (!removeTimer(rec)) continue; // already fired / cleared by an earlier callback
          if (!rec.fake) nativeClearTimeout(rec.id);
          try { rec.fn.apply(W, rec.args); } catch (e) { log('timer error', e); }
        }
      } finally {
        depth--;
      }

      // Once the engine moved on to the next tag, leave whatever that tag starts alone.
      if (kag.ftag.current_order_index !== startIndex || kag.stat.current_scenario !== startScenario) break;
    }
    return did;
  }

  // ---------------------------------------------------------------------------------------------
  // State checks
  // ---------------------------------------------------------------------------------------------

  function visible(el) {
    if (!el) return false;
    var cs = W.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function menuOpen() {
    var menus = document.querySelectorAll('.layer_menu');
    for (var i = 0; i < menus.length; i++) if (visible(menus[i]) && menus[i].children.length) return true;
    if (document.querySelector('.remodal-is-opened, .remodal-is-opening')) return true;
    if (kag.tmp && kag.tmp.sleep_game) return true;
    return false;
  }

  function clickLayerVisible() {
    return visible(document.querySelector('.layer_event_click'));
  }

  // True when the engine is blocked on something other than user input.
  function engineBusy() {
    if (!kag || !kag.ftag || !kag.stat) return false;
    if (currentTagName() === 's') return false; // waiting for a choice / button
    if (menuOpen()) return false;
    return true;
  }

  var INTERACTIVE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, VIDEO: 1 };
  var INTERACTIVE_CLASSES = ['event-setting-element', 'button_menu', 'glink_button', 'button_graphic'];
  var POINTER_EVENTS = ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'pointerdown'];

  function isInteractive(el) {
    var qs = jQueries();
    for (; el && el.nodeType === 1; el = el.parentNode) {
      if (el === document.body || el === document.documentElement) return false;
      if (el.id === 'tyrano_base' || el.id === 'vchat_base') return false;
      if (el.classList && el.classList.contains('layer_event_click')) return false;
      if (INTERACTIVE_TAGS[el.tagName]) return true;
      if (el.onclick || el.onmousedown || el.onmouseup) return true;
      for (var c = 0; c < INTERACTIVE_CLASSES.length; c++) {
        if (el.classList && el.classList.contains(INTERACTIVE_CLASSES[c])) return true;
      }
      for (var i = 0; i < qs.length; i++) {
        var ev = qs[i]._data && qs[i]._data(el, 'events');
        if (!ev) continue;
        for (var j = 0; j < POINTER_EVENTS.length; j++) if (ev[POINTER_EVENTS[j]]) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Transition skip (input)
  // ---------------------------------------------------------------------------------------------

  function tryTransitionSkip() {
    if (!CFG.transitionSkip || !kag) return false;
    if (clickLayerVisible() || !engineBusy()) return false;
    if (!flush()) return false;
    P.stats.flushes++;
    return true;
  }

  function onMouseDown(e) {
    swallowClickUntil = 0;
    if (e.button !== 0 || isInteractive(e.target)) return;
    if (tryTransitionSkip()) {
      swallowClickUntil = now() + 1500;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function onClick(e) {
    if (swallowClickUntil && now() < swallowClickUntil) {
      swallowClickUntil = 0;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function onKeyDown(e) {
    if (e.keyCode !== 13 || e.repeat) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    if (tryTransitionSkip()) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  W.addEventListener('mousedown', onMouseDown, true);
  W.addEventListener('click', onClick, true);
  W.addEventListener('keydown', onKeyDown, true);
  W.addEventListener('beforeunload', function () { flushSystemVariables(); }, true);

  // ---------------------------------------------------------------------------------------------
  // Rollback
  //
  // When the player advances from a line (the engine leaves an [l] / [p] it was waiting on), a
  // snapshot of that moment is pushed: the same data the engine's own save contains (layers,
  // variables, scenario position), plus the backlog. The rollback key pops the newest snapshot
  // and restores it with the engine's loader, so the line currently on screen is never in the
  // history and each press goes back one line.
  // ---------------------------------------------------------------------------------------------

  var history = [];      // [{ data, backlog }] oldest first
  var waitingAt = null;  // { index, scenario } of the [l] / [p] the engine is waiting on
  var restored = null;   // the entry we rolled back to: { entry, rested, guardUntil, started }
  var ourLoad = false;

  var LINE_WAIT_TAGS = { l: 1, p: 1 };
  var USER_EVENT = /^(mouse|pointer|key|touch|click|dblclick|wheel|mousewheel|DOMMouseScroll)/;

  function Q() {
    return W.$ && W.$.fn && W.$.fn.jquery ? W.$ : W.jQuery;
  }

  function backlogArray() {
    var tf = kag.variable && kag.variable.tf;
    return tf && tf.system && tf.system.backlog;
  }

  // Temporarily put elements that are mid-way through a jQuery animation at its end values, so
  // the snapshot does not freeze them half-faded / half-moved. Returns a function undoing it.
  function applyTweenEnds() {
    var undo = [];
    var list = jqueryTimers();
    for (var i = 0; i < list.length; i++) {
      var tweens = list[i].t.anim && list[i].t.anim.tweens;
      if (!tweens) continue;
      for (var j = 0; j < tweens.length; j++) {
        var tw = tweens[j];
        if (!tw.elem || !tw.elem.style || !(tw.prop in tw.elem.style)) continue;
        undo.push({ elem: tw.elem, prop: tw.prop, value: tw.elem.style[tw.prop] });
        try { list[i].q.style(tw.elem, tw.prop, tw.end + (tw.unit || '')); } catch (e) {}
      }
    }
    return function () {
      for (var k = undo.length - 1; k >= 0; k--) undo[k].elem.style[undo[k].prop] = undo[k].value;
    };
  }

  function captureSnapshot() {
    var data = {
      title: '',
      stat: kag.stat,
      // Same convention as the engine's save: the loader inserts [call storage=make.ks] after this
      // index and parks the engine on the [l]/[p], so one click continues from the next tag.
      current_order_index: kag.ftag.current_order_index - 1,
      save_date: '',
      img_data: ''
    };
    var three = kag.tmp && kag.tmp.three;
    if (three) {
      var models = {};
      for (var key in three.models) {
        try { models[key] = three.models[key].toSaveObj(); } catch (e) {}
      }
      data.three = { stat: three.stat, evt: three.evt, models: models };
    }
    var undo = applyTweenEnds();
    try {
      data.layer = kag.layer.getLayeyHtml();
    } finally {
      undo();
    }
    var copy = Q().extend(true, {}, data);
    // A restored line should wait for the player, not resume skip / auto mode.
    copy.stat.is_skip = false;
    copy.stat.is_auto = false;
    copy.stat.is_wait_auto = false;
    var bl = backlogArray();
    return { data: copy, backlog: bl ? bl.slice() : null };
  }

  function recordLine() {
    try {
      history.push(captureSnapshot());
      if (history.length > CFG.rollbackHistory) history.splice(0, history.length - CFG.rollbackHistory);
    } catch (e) {
      log('snapshot error', e);
    }
  }

  function atRestedPosition() {
    var d = restored.entry.data;
    return kag.stat.current_scenario === d.stat.current_scenario &&
      kag.ftag.current_order_index === d.current_order_index + 1;
  }

  // ftag.nextOrder hook: the engine is about to move on.
  function beforeNextOrder() {
    if (restored && restored.rested) {
      if (atRestedPosition()) {
        // Right after a rollback, ignore stray async callbacks of the discarded state (e.g. an
        // audio file that finished loading) that would advance the engine on their own.
        if (now() < restored.guardUntil && !(W.event && USER_EVENT.test(W.event.type))) return false;
        // Leaving the line we rolled back to: it goes back on the history as it was.
        history.push(restored.entry);
      }
      restored = null;
    }
    if (!waitingAt) return;
    var w = waitingAt;
    waitingAt = null;
    if (CFG.rollback && kag.ftag.current_order_index === w.index && kag.stat.current_scenario === w.scenario) recordLine();
  }

  // ftag.nextOrderWithIndex hook: detects the engine settling back on the [l]/[p] after our load.
  function checkRestored() {
    if (restored && !restored.rested && atRestedPosition() && LINE_WAIT_TAGS[currentTagName()]) {
      restored.rested = true;
      restored.guardUntil = now() + 1000;
      // Some engines hide the "click to continue" glyph right before advancing, i.e. before the
      // snapshot was taken; the line is waiting for a click again, so show it.
      try { kag.ftag.showNextImg(); } catch (e) {}
    }
  }

  function wrapRollbackHooks(f) {
    var mt = f.master_tag || {};
    for (var name in LINE_WAIT_TAGS) {
      var tag = mt[name];
      if (!tag || typeof tag.start !== 'function' || tag.start.__tyranoPatcher) continue;
      (function (tag) {
        var orig = tag.start;
        tag.start = function () {
          var index = kag.ftag.current_order_index;
          var scenario = kag.stat.current_scenario;
          waitingAt = null;
          // While skipping the engine moves on from inside this call, so record it right here.
          if (CFG.rollback && isSkipping()) recordLine();
          var r = orig.apply(this, arguments);
          // Still on this tag afterwards => the engine is now waiting for the player.
          if (kag.ftag.current_order_index === index && kag.stat.current_scenario === scenario) {
            waitingAt = { index: index, scenario: scenario };
          }
          return r;
        };
        tag.start.__tyranoPatcher = true;
      })(tag);
    }

    // Some games' loaders stop every sound up front (e.g. a custom [stop_sounds]) regardless of
    // the "keep the music" option. While a rollback is loading: never let those stops advance
    // the engine, and when the music stays the same, only let voices be stopped.
    var stopbgm = mt.stopbgm;
    if (stopbgm && typeof stopbgm.start === 'function' && !stopbgm.start.__tyranoPatcher) {
      var origStop = stopbgm.start;
      stopbgm.start = function (pm) {
        if (ourLoad && restored && pm) {
          if (restored.keepAudio && String(pm.target || 'bgm') !== 'voice') return undefined;
          var copy = {};
          for (var key in pm) copy[key] = pm[key];
          copy.stop = 'true';
          return origStop.call(this, copy);
        }
        return origStop.apply(this, arguments);
      };
      stopbgm.start.__tyranoPatcher = true;
    }

    var menu = kag.menu;
    if (menu && typeof menu.loadGameData === 'function' && !menu.loadGameData.__tyranoPatcher) {
      var origLoad = menu.loadGameData;
      menu.loadGameData = function () {
        waitingAt = null;
        if (!ourLoad) {
          restored = null;
          // Loading a save starts a different timeline. Returning from [sleepgame] screens
          // (config, gallery ...) also goes through here and keeps the history.
          if (!(kag.tmp && kag.tmp.sleep_game)) history.length = 0;
        }
        return origLoad.apply(this, arguments);
      };
      menu.loadGameData.__tyranoPatcher = true;
    }
  }

  // Stop everything the current state still has in flight, without letting any of it advance
  // the engine, so none of it can touch the state that is about to be restored.
  function cancelInFlight() {
    frozen = true;
    generation++;
    try {
      for (var i = 0; i < timers.length; i++) if (!timers[i].fake) nativeClearTimeout(timers[i].id);
      timers.length = 0;
      immediateQueue.length = 0;

      // Jump jQuery / jQuery UI animations to their end (engine calls from their callbacks are
      // blocked), so e.g. a shaking screen gets its original position back.
      finishJquery(jqueryTimers());

      if (W.anime && W.anime.running) {
        var running = W.anime.running.slice();
        for (var j = 0; j < running.length; j++) { try { running[j].pause(); } catch (e) {} }
      }
      if (kag.tmp) {
        if (typeof kag.tmp.quake2_finish === 'function') {
          try { cancelAnimationFrame(kag.tmp.quake2_timer_id); } catch (e) {}
          kag.tmp.quake2_finish = false;
          Q()('#root_layer_game, #root_layer_system').css('transform', '');
          Q()('.quake2-element').remove();
        }
        kag.tmp.num_anim = 0;
      }
      // Screen masks live outside the layers that a load replaces.
      var masks = document.querySelectorAll('.layer_mask');
      if (masks.length) {
        for (var m = 0; m < masks.length; m++) masks[m].parentNode.removeChild(masks[m]);
        Q()('#root_layer_game').css('opacity', '');
      }
    } finally {
      frozen = false;
    }
  }

  // True when a rollback that keeps the music is still loading and pm asks for a loop that is
  // already playing on the same channel.
  function alreadyPlayingAfterRollback(pm) {
    if (!restored || restored.rested || !restored.keepAudio) return false;
    if (String(pm.loop) !== 'true' || !pm.storage) return false;
    var map = pm.target === 'se' ? kag.tmp.map_se : pm.target === 'voice' ? null : kag.tmp.map_bgm;
    var howl = map && map[pm.buf === undefined ? '0' : pm.buf];
    if (!howl || typeof howl.playing !== 'function') return false;
    try {
      var src = String(howl._src || '');
      return howl.playing() && src.slice(-String(pm.storage).length - 1) === '/' + pm.storage;
    } catch (e) {
      return false;
    }
  }

  function sameAudio(a, b) {
    try {
      return a.current_bgm === b.current_bgm && a.current_bgm_vol === b.current_bgm_vol &&
        JSON.stringify(a.current_se || {}) === JSON.stringify(b.current_se || {});
    } catch (e) {
      return false;
    }
  }

  function rollback() {
    if (!CFG.rollback || !kag || !kag.menu || !kag.layer) return false;
    if (menuOpen()) return false;
    if (restored && !restored.rested && now() - restored.started < 3000) return true; // still loading
    if (!history.length) {
      showToast('Nothing further to roll back to', 1200);
      return true;
    }
    var entry = history.pop();

    kag.stat.is_skip = false;
    if (kag.stat.is_auto) {
      try { kag.ftag.startTag('autostop', { next: 'false' }); } catch (e) {}
      kag.stat.is_auto = false;
    }
    kag.stat.is_wait_auto = false;
    cancelInFlight();
    waitingAt = null;

    var bl = backlogArray();
    if (bl && entry.backlog) {
      bl.length = 0;
      for (var i = 0; i < entry.backlog.length; i++) bl.push(entry.backlog[i]);
    }

    // Keep the music playing if it is the same (this includes one-shot sounds still ringing out,
    // e.g. a jingle); otherwise the loader stops everything and restarts the line's music.
    var keepAudio = sameAudio(entry.data.stat, kag.stat);
    restored = { entry: entry, rested: false, guardUntil: 0, started: now(), keepAudio: keepAudio };
    var options = { bgm_over: keepAudio ? 'true' : 'false' };
    var timersBefore = jqueryTimers();
    ourLoad = true;
    depth++;
    try {
      kag.menu.loadGameData(Q().extend(true, {}, entry.data), options);
    } catch (e) {
      log('rollback error', e);
    } finally {
      depth--;
      ourLoad = false;
    }
    // Load effects (e.g. plugins crossfading from the old screen) would make rollback sluggish.
    var started = [];
    var timersAfter = jqueryTimers();
    for (var k = 0; k < timersAfter.length; k++) {
      var known = false;
      for (var b = 0; b < timersBefore.length && !known; b++) known = timersBefore[b].t === timersAfter[k].t;
      if (!known) started.push(timersAfter[k]);
    }
    if (started.length) finishJquery(started);
    P.stats.rollbacks++;
    return true;
  }

  var KEY_NAMES = {
    backspace: 8, tab: 9, enter: 13, shift: 16, ctrl: 17, alt: 18, pause: 19, escape: 27, esc: 27,
    space: 32, pageup: 33, pagedown: 34, end: 35, home: 36, left: 37, up: 38, right: 39, down: 40,
    insert: 45, 'delete': 46, del: 46
  };

  function parseKeys(spec) {
    var out = [];
    var parts = String(spec || '').split(/[,;\s]+/);
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].toLowerCase();
      var m;
      if (!k) continue;
      if (KEY_NAMES[k]) out.push(KEY_NAMES[k]);
      else if ((m = /^f([1-9]|1[0-2])$/.exec(k))) out.push(111 + Number(m[1]));
      else if (/^[a-z0-9]$/.test(k)) out.push(k.toUpperCase().charCodeAt(0));
      else if (/^\d{2,3}$/.test(k)) out.push(Number(k));
    }
    return out;
  }

  var rollbackKeyCodes = parseKeys(CFG.rollbackKeys);

  function onRollbackKey(e) {
    if (!CFG.rollback || rollbackKeyCodes.indexOf(e.keyCode) < 0) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (rollback()) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function isMouseBack(e) {
    return CFG.rollback && CFG.rollbackMouseBack && e.button === 3;
  }

  function swallowMouseBack(e) {
    if (!isMouseBack(e)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  W.addEventListener('keydown', onRollbackKey, true);
  W.addEventListener('mousedown', function (e) {
    if (isMouseBack(e)) rollback();
    swallowMouseBack(e);
  }, true);
  // Otherwise the back button would navigate the page back or run the game's own binding.
  W.addEventListener('mouseup', swallowMouseBack, true);
  W.addEventListener('auxclick', swallowMouseBack, true);

  P.rollback = rollback;
  P.history = history;

  // ---------------------------------------------------------------------------------------------
  // Fast skip (loop)
  // ---------------------------------------------------------------------------------------------

  function tick() {
    var skipping = false;
    try {
      wrapEngine(); // cheap; re-wraps if a plugin replaced a method
      skipping = CFG.fastSkip && isSkipping();
      if (wasSkipping && !skipping) flushSystemVariables();
      wasSkipping = skipping;
      if (skipping && engineBusy() && !clickLayerVisible() && flush()) P.stats.skipFlushes++;
    } catch (e) {
      log('tick error', e);
    }
    if (skipping && nativeRaf && !document.hidden) nativeRaf(tick);
    else nativeSetTimeout(tick, skipping ? 16 : 100);
  }

  // ---------------------------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------------------------

  var toastEl = null;
  var toastTimer = null;

  function showToast(text, holdMs) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = '__tyranoPatcherToast';
      toastEl.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;pointer-events:none;' +
        'font:12px/1.4 sans-serif;color:#fff;background:rgba(0,0,0,.65);padding:4px 8px;border-radius:4px';
    }
    if (!toastEl.parentNode) document.body.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    if (toastTimer) nativeClearTimeout(toastTimer);
    var op = 1;
    toastTimer = nativeSetTimeout(function fade() {
      op -= 0.1;
      if (op <= 0) {
        if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
        toastTimer = null;
        return;
      }
      toastEl.style.opacity = String(op);
      toastTimer = nativeSetTimeout(fade, 40);
    }, holdMs);
  }

  function startupToast() {
    if (!CFG.toast) return;
    var features = [CFG.transitionSkip ? 'transition skip' : '', CFG.fastSkip ? 'fast skip' : '',
      CFG.rollback ? 'rollback' : ''].filter(Boolean);
    showToast('TyranoPatcher: ' + features.join(' + ') + ' active', 2500);
  }

  var waited = 0;
  function waitForEngine() {
    var T = W.TYRANO;
    // ftag.kag is only set once init_game() ran (older engines define ftag before that).
    if (T && T.kag && T.kag.ftag && T.kag.ftag.kag && typeof T.kag.ftag.nextOrder === 'function' && T.kag.stat && T.kag.layer) {
      kag = T.kag;
      P.kag = kag;
      wrapEngine();
      P.flush = flush;
      tick();
      startupToast();
      log('active', P.version, 'engine', kag.version, JSON.stringify(CFG));
      return;
    }
    waited += 100;
    if (waited > 10 * 60 * 1000) return; // not a TyranoScript page
    nativeSetTimeout(waitForEngine, 100);
  }
  waitForEngine();
})();
