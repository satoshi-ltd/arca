import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('brand activity suppresses brief requests and keeps sustained activity stable', () => {
  const source = fs.readFileSync(new URL('../apps/desktop/src/app.js', import.meta.url), 'utf8');
  let now = 0, serial = 0;
  const timers = new Map(), classes = new Set(), attributes = {};
  const indicator = { firstChild: null, innerHTML: '' };
  const mark = {
    isConnected: true,
    classList: { contains: name => classes.has(name), toggle: (name, value) => value ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => { attributes[name] = value; },
    querySelector: () => indicator,
  };
  const context = vm.createContext({
    $: () => mark, busy: false, status: { phase: 'idle' },
    document: { body: { classList: { contains: () => false } } },
    Date: { now: () => now }, busyIcon: () => 'busy',
    setTimeout: (fn, delay) => { timers.set(++serial, { fn, at: now + delay }); return serial; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source.slice(source.indexOf('let activeRequests = 0;'), source.indexOf('const api =')), context);
  const activity = n => vm.runInContext(`activeRequests = ${n}; updateBrandActivity();`, context);
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  activity(1); advance(99); activity(0); advance(500);
  assert.equal(classes.has('is-busy'), false);
  activity(1); advance(299);
  assert.equal(classes.has('is-busy'), false);
  advance(1);
  assert.equal(attributes['aria-busy'], 'true');
  activity(0); advance(499);
  assert.equal(classes.has('is-busy'), true);
  activity(1); advance(1);
  assert.equal(classes.has('is-busy'), true, 'new work cancels pending hide');
  activity(0); advance(0);
  assert.equal(attributes['aria-busy'], 'false');
});
