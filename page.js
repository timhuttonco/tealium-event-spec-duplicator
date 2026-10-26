// Runs in the page's own JS world (manifest "world": "MAIN") so it can reach
// Tealium's in-memory profile models on window.gApp.
//
// An Event Spec is two linked Backbone models:
//   eventDefinitionCollection  -> { tealiumEvent, eventAttributes (collection), linkedFilteredStreamId, ... }
//   filteredStreamCollection   -> { name: "Event Specification: <event>", conditions (model), logic, ... }
// Both only reach Tealium's servers when the user clicks Save / Publish, so a
// duplicate is made by adding cloned models and marking the profile dirty.
// The clones must keep Tealium's own model/collection classes at every level:
// its save path calls methods on them (e.g. eventAttributes.each, stream.hasQuantifier).
(function () {
  'use strict';

  const TEALIUM_EVENT_OPERAND = 'current_visit.last_event.data.udo.tealium_event';
  const STREAM_NAME_PREFIX = 'Event Specification: ';

  function models() {
    const im = window.gApp && window.gApp.inMemoryModels;
    if (!im || !im.eventDefinitionCollection || !im.filteredStreamCollection) return null;
    return { defs: im.eventDefinitionCollection, streams: im.filteredStreamCollection };
  }

  const isModel = (v) => v && typeof v === 'object' && 'attributes' in v && 'cid' in v && typeof v.get === 'function';
  const isCollection = (v) => v && typeof v === 'object' && Array.isArray(v.models) && typeof v.each === 'function';

  // Deep copy that rebuilds nested Backbone models/collections with their own classes.
  function cloneValue(v) {
    if (isCollection(v)) return new v.constructor(v.models.map((m) => cloneModel(m)));
    if (isModel(v)) return cloneModel(v);
    if (Array.isArray(v)) return v.map(cloneValue);
    if (v && typeof v === 'object' && v.constructor === Object) {
      const o = {};
      for (const k in v) o[k] = cloneValue(v[k]);
      return o;
    }
    return v;
  }

  function cloneAttributes(model) {
    const a = {};
    for (const k in model.attributes) a[k] = cloneValue(model.attributes[k]);
    return a;
  }

  function cloneModel(model, overrides) {
    return new model.constructor(Object.assign(cloneAttributes(model), overrides));
  }

  // Rewrite every `tealium_event equals <old>` clause to point at the new event.
  // Walks plain objects/arrays and (not-yet-added) Backbone models' attributes.
  function retarget(node, oldEvent, newEvent) {
    if (isCollection(node)) {
      node.models.forEach((m) => retarget(m, oldEvent, newEvent));
    } else if (isModel(node)) {
      retarget(node.attributes, oldEvent, newEvent);
    } else if (Array.isArray(node)) {
      node.forEach((n) => retarget(n, oldEvent, newEvent));
    } else if (node && typeof node === 'object') {
      if (node.operand1 === TEALIUM_EVENT_OPERAND && node.operand2 === oldEvent) node.operand2 = newEvent;
      Object.values(node).forEach((v) => retarget(v, oldEvent, newEvent));
    }
  }

  function currentUser(fallback) {
    try {
      const u = window.utui_sso || {};
      return u.email || u.user || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function validateName(name) {
    const m = models();
    if (!m) return 'Tealium profile data is not loaded yet.';
    if (!name) return 'Enter a new event name.';
    if (/\s/.test(name)) return 'Event names cannot contain spaces.';
    const taken = m.defs.some((d) => (d.get('tealiumEvent') || '').toLowerCase() === name.toLowerCase());
    if (taken) return `An event spec named "${name}" already exists.`;
    return null;
  }

  function duplicate(sourceId, newEvent) {
    const m = models();
    const error = validateName(newEvent);
    if (error) throw new Error(error);

    const src = m.defs.get(sourceId);
    if (!src) throw new Error('Source event spec not found.');
    const oldEvent = src.get('tealiumEvent');
    const srcStream = m.streams.get(src.get('linkedFilteredStreamId'));
    if (!srcStream) throw new Error(`Linked filtered stream for "${oldEvent}" not found.`);

    const now = new Date().toISOString();
    const user = currentUser(src.get('updatedBy'));
    const stamps = { createdBy: user, updatedBy: user, creationDate: now, updatedDate: now };
    const newStreamId = window.gApp.utils.uuid();

    const streamAttrs = cloneAttributes(srcStream);
    retarget(streamAttrs.conditions, oldEvent, newEvent);
    if (typeof streamAttrs.logic === 'string') {
      const logic = JSON.parse(streamAttrs.logic);
      retarget(logic, oldEvent, newEvent);
      streamAttrs.logic = JSON.stringify(logic);
    }
    Object.assign(streamAttrs, stamps, { id: newStreamId, name: STREAM_NAME_PREFIX + newEvent });
    const stream = new srcStream.constructor(streamAttrs);

    const def = cloneModel(src, Object.assign({}, stamps, {
      id: window.gApp.utils.uuid(),
      tealiumEvent: newEvent,
      linkedFilteredStreamId: newStreamId,
    }));

    // Stream first: adding the definition fires Tealium's own listeners, which
    // expect the linked stream to exist.
    m.streams.add(stream);
    m.defs.add(def);
    window.gApp.utils.setDirty(true);

    return { id: def.id, streamId: newStreamId, event: newEvent, attributes: def.get('eventAttributes').length };
  }

  function findByEvent(event) {
    const m = models();
    return m && m.defs.find((d) => d.get('tealiumEvent') === event);
  }

  window.__eventSpecDuplicator = { duplicate, validateName, findByEvent };

  // ---------- UI ----------
  // The Event Spec "Edit Details" slideout has stable data-testids (unlike its
  // generated class names). We add a Duplicate button to its header, styled
  // like the Duplicate button on Tealium's Audience slideout.

  const SEL_CLOSE = '[data-testid="event-spec-edit-slideout-close-button"]';
  const SEL_TITLE = '[data-testid="event-spec-edit-slideout-header-title"]';

  const CSS = `
    #esd-dup { display: flex; align-items: center; margin-right: 15px; cursor: pointer;
      font-size: 16px; color: rgb(130, 138, 148); }
    #esd-dup .esd-dup-text { font-size: 16px; font-weight: bold; color: rgb(0, 124, 194); margin: 0 7px; }
    #esd-dup:hover .esd-dup-text { text-decoration: underline; }
    #esd-backdrop { position: fixed; inset: 0; z-index: 100000; background: rgba(0,0,0,.35);
      display: flex; align-items: center; justify-content: center; }
    #esd-modal { background: #fff; color: #222; width: 440px; max-width: calc(100vw - 32px);
      border-radius: 6px; padding: 24px; font: 14px/1.4 proxima-nova, Proxima, "Helvetica Neue", Helvetica, Arial, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,.3); }
    #esd-modal h2 { margin: 0 0 4px; font-size: 18px; }
    #esd-modal p { margin: 0 0 16px; color: #666; }
    #esd-modal label { display: block; margin-bottom: 4px; font-weight: 600; }
    #esd-modal input { width: 100%; box-sizing: border-box; padding: 8px 10px;
      border: 1px solid #bbb; border-radius: 4px; font: inherit; }
    #esd-msg { min-height: 18px; margin-top: 8px; color: #c5221f; }
    #esd-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    #esd-actions button { padding: 8px 16px; border-radius: 4px; border: 1px solid #bbb;
      background: #fff; cursor: pointer; font: inherit; font-weight: 600; }
    #esd-actions button.primary { background: rgb(0, 124, 194); border-color: rgb(0, 124, 194); color: #fff; }
    #esd-toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 100001;
      background: #222; color: #fff; padding: 12px 18px; border-radius: 6px;
      font: 14px/1.4 proxima-nova, Proxima, "Helvetica Neue", Helvetica, Arial, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.3); }
  `;

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.assign(n, attrs || {});
    (children || []).forEach((c) => n.append(c));
    return n;
  }

  function toast(text) {
    document.getElementById('esd-toast')?.remove();
    const t = el('div', { id: 'esd-toast', textContent: text });
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  function openNameDialog(source) {
    if (document.getElementById('esd-backdrop')) return;
    const event = source.get('tealiumEvent');
    const attrs = (source.get('eventAttributes') || []).length;

    const nameInput = el('input', { value: event + '_copy' });
    const msg = el('div', { id: 'esd-msg' });
    const cancel = el('button', { textContent: 'Cancel' });
    const go = el('button', { textContent: 'Duplicate', className: 'primary' });

    const close = () => backdrop.remove();
    const submit = () => {
      try {
        const r = duplicate(source.id, nameInput.value.trim());
        close();
        toast(`Created "${r.event}" with ${r.attributes} attributes. Click Save / Publish to keep it.`);
      } catch (e) {
        msg.textContent = e.message;
      }
    };
    cancel.addEventListener('click', close);
    go.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close();
    });

    const modal = el('div', { id: 'esd-modal' }, [
      el('h2', { textContent: 'Duplicate Event Spec' }),
      el('p', { textContent: `Copies "${event}" and its ${attrs} attribute definitions.` }),
      el('label', { textContent: 'New event name (tealium_event)' }),
      nameInput,
      msg,
      el('div', { id: 'esd-actions' }, [cancel, go]),
    ]);
    const backdrop = el('div', { id: 'esd-backdrop' }, [modal]);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.body.append(backdrop);
    nameInput.focus();
    nameInput.select();
  }

  function syncButton() {
    const closeBtn = document.querySelector(SEL_CLOSE);
    const title = document.querySelector(SEL_TITLE);
    const existing = document.getElementById('esd-dup');
    // Only offer Duplicate for a spec that already exists (not the "New Event Spec" form).
    const source = closeBtn && title && findByEvent(title.textContent.trim());
    if (!source) {
      existing?.remove();
      return;
    }
    const header = closeBtn.parentElement.parentElement; // flex row, justify-content: space-between
    if (existing && existing.parentElement === header) return;
    existing?.remove();
    const btn = el('div', { id: 'esd-dup', title: 'Duplicate this event spec' }, [
      el('span', { className: 'fas fa-copy' }),
      el('div', { className: 'esd-dup-text', textContent: 'Duplicate' }),
    ]);
    // Resolve the spec at click time: the slideout can be reused for another spec.
    btn.addEventListener('click', () => {
      const t = document.querySelector(SEL_TITLE);
      const s = t && findByEvent(t.textContent.trim());
      if (s) openNameDialog(s);
    });
    header.append(btn);
  }

  document.head.append(el('style', { textContent: CSS }));
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncButton(); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  syncButton();
})();
