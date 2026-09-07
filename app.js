// Grepql — all app logic. No network calls anywhere in this file.
(function () {
  "use strict";

  const GQL = window.GraphQLLib;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  /** @type {{schema: any, schemaText: string|null, tabs: Record<string, TabState>, activeTab: string|null}} */
  const state = {
    schema: null,
    schemaText: null,
    tabs: {},
    activeTab: null,
  };

  // localStorage autosave: the schema is re-parsed from the raw text that
  // was loaded (rather than trying to serialize a GraphQLSchema object),
  // and the in-progress selection tree is flattened to plain field-name
  // paths + arg values — the live GraphQLField references in each Node get
  // re-resolved against the freshly-parsed schema on restore instead of
  // being serialized. A refresh (or reopening the file later) picks back
  // up wherever you left off; "Import new schema" is the explicit way out.
  //
  // localStorage has no native expiration, so staleness is enforced here:
  // a savedAt timestamp goes out with every write, and restoreAutosave()
  // below drops anything older than the configured TTL (see Settings)
  // instead of restoring it. This only runs when the page is actually
  // reopened — it doesn't reach into an open tab and delete anything on a
  // timer, since a tab you're still working in counts as still in use.
  const STORAGE_KEY = "graphqlQueryBuilder.autosave.v1";

  // Settings (persistence toggle, TTL, remembered copy-checkbox state) live
  // under a separate, non-expiring key. Unlike the autosave above, this is
  // never subject to the TTL and is never touched by "nuke" actions
  // (disabling persistence, Import new schema) — only clearing site data
  // at the browser level removes it.
  const SETTINGS_KEY = "graphqlQueryBuilder.settings.v1";
  const DEFAULT_SETTINGS = {
    persistenceEnabled: false,
    ttlDays: 1,
    ttlHours: 0,
    ttlMinutes: 0,
    copyOneLine: false,
    copyUrlEncode: false,
    introspectionOneLine: false,
    introspectionUrlEncode: false,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      // Settings persistence is a nicety, not a requirement — ignore.
    }
  }

  function settingsTtlMs(settings) {
    return ((settings.ttlDays * 24 + settings.ttlHours) * 60 + settings.ttlMinutes) * 60 * 1000;
  }

  // TabState: { kind: 'query'|'mutation'|'subscription', rootType, selection: Map<string,Node>, opName: string }
  // Node: { field, argValues: {[name]:string}, children: Map<string,Node>|null, fragments: Map<string,Map>|null, includeTypename: bool }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------

  const el = {
    schemaStatus: document.getElementById("schema-status"),
    landing: document.getElementById("landing"),
    builder: document.getElementById("builder"),
    defaultIntrospectionQuery: document.getElementById("default-introspection-query"),
    copyIntrospectionBtn: document.getElementById("copy-introspection-btn"),
    schemaInput: document.getElementById("schema-input"),
    schemaFile: document.getElementById("schema-file"),
    loadSchemaBtn: document.getElementById("load-schema-btn"),
    clearSchemaInputBtn: document.getElementById("clear-schema-input-btn"),
    importError: document.getElementById("import-error"),
    loadDifferentBtn: document.getElementById("load-different-btn"),
    operationTabs: document.getElementById("operation-tabs"),
    fieldFilter: document.getElementById("field-filter"),
    clearAllBtn: document.getElementById("clear-all-btn"),
    fieldTree: document.getElementById("field-tree"),
    opNameInput: document.getElementById("op-name-input"),
    queryOutput: document.getElementById("query-output"),
    copyQueryBtn: document.getElementById("copy-query-btn"),
    oneLineCheckbox: document.getElementById("one-line-checkbox"),
    urlEncodeCheckbox: document.getElementById("url-encode-checkbox"),
    introspectionOneLineCheckbox: document.getElementById("introspection-one-line-checkbox"),
    introspectionUrlEncodeCheckbox: document.getElementById("introspection-url-encode-checkbox"),
    introspectionVariantSelect: document.getElementById("introspection-variant-select"),
    variantNote: document.getElementById("variant-note"),
    warnings: document.getElementById("warnings"),
    settingsBtn: document.getElementById("settings-btn"),
    settingsPopover: document.getElementById("settings-popover"),
    settingPersistenceCheckbox: document.getElementById("setting-persistence-checkbox"),
    settingTtlDays: document.getElementById("setting-ttl-days"),
    settingTtlHours: document.getElementById("setting-ttl-hours"),
    settingTtlMinutes: document.getElementById("setting-ttl-minutes"),
    settingsDefaultsBtn: document.getElementById("settings-defaults-btn"),
    settingsClearCacheBtn: document.getElementById("settings-clear-cache-btn"),
  };

  // ---------------------------------------------------------------------
  // Settings panel (persistence toggle, TTL, remembered copy checkboxes).
  // Wired up before anything else touches these checkboxes, so the very
  // first render of the introspection box / query panel already reflects
  // whatever was remembered from last time.
  // ---------------------------------------------------------------------

  function clampNonNegativeInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function applySettingsToUI(settings) {
    el.settingPersistenceCheckbox.checked = settings.persistenceEnabled;
    el.settingTtlDays.value = settings.ttlDays;
    el.settingTtlHours.value = settings.ttlHours;
    el.settingTtlMinutes.value = settings.ttlMinutes;
    el.oneLineCheckbox.checked = settings.copyOneLine;
    el.urlEncodeCheckbox.checked = settings.copyUrlEncode;
    el.introspectionOneLineCheckbox.checked = settings.introspectionOneLine;
    el.introspectionUrlEncodeCheckbox.checked = settings.introspectionUrlEncode;
  }

  (function initSettingsUI() {
    let settings = loadSettings();
    applySettingsToUI(settings);

    el.settingsBtn.addEventListener("click", () => {
      const opening = el.settingsPopover.hidden;
      el.settingsPopover.hidden = !opening;
      el.settingsBtn.setAttribute("aria-expanded", String(opening));
    });

    document.addEventListener("click", (e) => {
      if (el.settingsPopover.hidden) return;
      const menu = el.settingsBtn.closest(".settings-menu");
      if (menu && menu.contains(e.target)) return;
      el.settingsPopover.hidden = true;
      el.settingsBtn.setAttribute("aria-expanded", "false");
    });

    el.settingPersistenceCheckbox.addEventListener("change", () => {
      settings.persistenceEnabled = el.settingPersistenceCheckbox.checked;
      saveSettings(settings);
      if (settings.persistenceEnabled) {
        // Resume saving right away, rather than waiting for the next edit.
        persistState();
      } else {
        // Nuke whatever's already saved immediately, but leave in-progress
        // work (and the UI) alone — this only stops it from being saved
        // going forward, until the tab is refreshed or closed.
        localStorage.removeItem(STORAGE_KEY);
      }
    });

    function onTtlInputChange() {
      settings.ttlDays = clampNonNegativeInt(el.settingTtlDays.value, DEFAULT_SETTINGS.ttlDays);
      settings.ttlHours = clampNonNegativeInt(el.settingTtlHours.value, DEFAULT_SETTINGS.ttlHours);
      settings.ttlMinutes = clampNonNegativeInt(el.settingTtlMinutes.value, DEFAULT_SETTINGS.ttlMinutes);
      el.settingTtlDays.value = settings.ttlDays;
      el.settingTtlHours.value = settings.ttlHours;
      el.settingTtlMinutes.value = settings.ttlMinutes;
      saveSettings(settings);
    }
    el.settingTtlDays.addEventListener("change", onTtlInputChange);
    el.settingTtlHours.addEventListener("change", onTtlInputChange);
    el.settingTtlMinutes.addEventListener("change", onTtlInputChange);

    el.settingsDefaultsBtn.addEventListener("click", () => {
      settings = { ...DEFAULT_SETTINGS };
      saveSettings(settings);
      applySettingsToUI(settings);
      if (settings.persistenceEnabled) persistState();
      renderIntrospectionBox();
      renderQueryPanel();
    });

    // Deliberately redundant with unchecking "Save schema between sessions"
    // (which also wipes the current save immediately) — that toggle isn't
    // an obvious "delete my data now" action, so this gives that its own
    // explicit button, without touching the persistence setting itself.
    el.settingsClearCacheBtn.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      const original = el.settingsClearCacheBtn.textContent;
      el.settingsClearCacheBtn.textContent = "Cleared";
      el.settingsClearCacheBtn.disabled = true;
      setTimeout(() => {
        el.settingsClearCacheBtn.textContent = original;
        el.settingsClearCacheBtn.disabled = false;
      }, 1200);
    });

    // Keep settings in sync as the copy checkboxes are toggled elsewhere on
    // the page — this only remembers their state, it doesn't add behavior.
    el.oneLineCheckbox.addEventListener("change", () => {
      settings.copyOneLine = el.oneLineCheckbox.checked;
      saveSettings(settings);
    });
    el.urlEncodeCheckbox.addEventListener("change", () => {
      settings.copyUrlEncode = el.urlEncodeCheckbox.checked;
      saveSettings(settings);
    });
    el.introspectionOneLineCheckbox.addEventListener("change", () => {
      settings.introspectionOneLine = el.introspectionOneLineCheckbox.checked;
      saveSettings(settings);
    });
    el.introspectionUrlEncodeCheckbox.addEventListener("change", () => {
      settings.introspectionUrlEncode = el.introspectionUrlEncodeCheckbox.checked;
      saveSettings(settings);
    });
  })();

  // ---------------------------------------------------------------------
  // Plain-text GraphQL tokenizer — for highlighting text we didn't generate
  // ourselves (the static introspection query on the landing page). The
  // query-builder's own output is tokenized as it's printed (see "Document
  // generation" below); this is a standalone lexer for arbitrary GraphQL
  // text, reusing the same {cls, text} token shape so it can go through
  // the same span-rendering and one-line-collapsing code.
  // ---------------------------------------------------------------------

  // VS Code-style bracket-pair colorization: each { / } pair is colored by
  // its nesting depth (cycling through a small palette), so a matching
  // opening/closing brace always share a color — independent of the
  // word-level (keyword/string/field) coloring elsewhere. Shared by both
  // the query-builder's own generator and the plain-text tokenizer below.
  const BRACE_PALETTE_SIZE = 3;
  function braceCls(depth) {
    return "br" + (depth % BRACE_PALETTE_SIZE);
  }

  const GRAPHQL_KEYWORDS = new Set(["query", "mutation", "subscription", "fragment", "on"]);

  function tokenizePlainGraphQL(text) {
    const toks = [];
    let depth = 0;
    let prevSignificant = null;
    const re =
      /"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|#[^\n]*|\.\.\.|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}()[\]:,]|[_A-Za-z][_0-9A-Za-z]*|\s+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = m[0];

      if (/^\s+$/.test(t)) {
        toks.push({ cls: undefined, text: t });
        continue;
      }
      if (t[0] === "#") {
        toks.push({ cls: undefined, text: t });
        continue;
      }
      if (t[0] === '"') {
        toks.push({ cls: "string", text: t });
      } else if (t === "...") {
        toks.push({ cls: "kw", text: t });
      } else if (t === "{") {
        toks.push({ cls: braceCls(depth), text: t });
        depth++;
      } else if (t === "}") {
        depth--;
        toks.push({ cls: braceCls(depth), text: t });
      } else if (/^[()[\]:,]$/.test(t)) {
        toks.push({ cls: "punct", text: t });
      } else if (/^-?\d/.test(t)) {
        toks.push({ cls: "number", text: t });
      } else if (t === "true" || t === "false") {
        toks.push({ cls: "bool", text: t });
      } else if (t === "null") {
        toks.push({ cls: "kw", text: t });
      } else if (GRAPHQL_KEYWORDS.has(t)) {
        toks.push({ cls: "kw", text: t });
      } else {
        // Bare name: a fragment/type name right after "fragment"/"on"/"...",
        // an arg name right before ":", otherwise a field/selection name.
        if (prevSignificant === "fragment" || prevSignificant === "on" || prevSignificant === "...") {
          toks.push({ cls: "type", text: t });
        } else {
          let j = re.lastIndex;
          while (j < text.length && /\s/.test(text[j])) j++;
          const cls = text[j] === ":" ? "arg-name" : t.startsWith("__") ? "field-meta" : "field";
          toks.push({ cls, text: t });
        }
      }

      prevSignificant = t;
    }
    return toks;
  }

  // Field names, arg names, and *unresolved* return/arg type kind+name for
  // the three root operation types only — no full type list, and no
  // ofType unwrapping at all. This is deliberately as shallow and narrow
  // as an introspection query gets: no full type list (unlike "basic",
  // which keeps full depth and breadth, just drops descriptions), and no
  // attempt to unwrap NonNull/List wrappers (a field like `[Post!]!` will
  // show kind: NON_NULL, name: null rather than a partially-resolved
  // guess) — a fixed-depth partial unwrap would silently go wrong on any
  // field wrapped deeper than whatever depth was chosen, which is worse
  // than just being upfront that this tier doesn't resolve wrapped types.
  // It's the one most likely to survive aggressive query-depth/cost
  // limits, at the real cost of being recon-only: there's no schema here
  // to build from, so it can't be loaded into the builder (see the check
  // in parseSchemaText), and wrapped types only show as "wrapped", not
  // what they wrap.
  const ROOT_TYPES_ONLY_QUERY = `query RootTypesOnly {
  __schema {
    queryType {
      name
      fields(includeDeprecated: true) {
        name
        args { name }
        type { kind name }
      }
    }
    mutationType {
      name
      fields(includeDeprecated: true) {
        name
        args { name }
        type { kind name }
      }
    }
    subscriptionType {
      name
      fields(includeDeprecated: true) {
        name
        args { name }
        type { kind name }
      }
    }
  }
}`;

  const INTROSPECTION_VARIANTS = {
    full: GQL.getIntrospectionQuery(),
    basic: GQL.getIntrospectionQuery({ descriptions: false }),
    root: ROOT_TYPES_ONLY_QUERY,
  };

  const introspectionTokensByVariant = {};
  for (const key of Object.keys(INTROSPECTION_VARIANTS)) {
    introspectionTokensByVariant[key] = tokenizePlainGraphQL(INTROSPECTION_VARIANTS[key]);
  }

  let currentIntrospectionText = "";

  const VARIANT_NOTES = {
    root:
      "Recon only: this shows field/arg names and unresolved types (a field like [Post!]! " +
      "just shows as \"wrapped\", not what's inside), and has no full type list — it can't be " +
      'loaded into the builder below. Try "Basic schema" for something you can build queries from.',
  };

  function renderIntrospectionBox() {
    const variant = el.introspectionVariantSelect.value;
    const baseTokens = introspectionTokensByVariant[variant];
    const oneLine = el.introspectionOneLineCheckbox.checked;
    const urlEncode = el.introspectionUrlEncodeCheckbox.checked;

    // URL-encoding implies one line regardless of whether that checkbox is
    // also on — collapseToSingleLine is a no-op on already-collapsed
    // tokens, so there's no double-collapse case to worry about.
    const toks = oneLine || urlEncode ? collapseToSingleLine(baseTokens) : baseTokens;
    const plainText = toks.map((t) => t.text).join("");

    if (urlEncode) {
      // Encoded text isn't meaningfully "GraphQL" to syntax-highlight
      // anymore, and showing exactly what will land on the clipboard beats
      // showing pretty text that doesn't match it.
      currentIntrospectionText = encodeURIComponent(plainText);
      el.defaultIntrospectionQuery.textContent = currentIntrospectionText;
    } else {
      currentIntrospectionText = plainText;
      el.defaultIntrospectionQuery.innerHTML = toks
        .map((t) => (t.cls ? `<span class="tok-${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text)))
        .join("");
    }

    const note = VARIANT_NOTES[variant];
    el.variantNote.hidden = !note;
    el.variantNote.textContent = note || "";
  }

  el.introspectionOneLineCheckbox.addEventListener("change", renderIntrospectionBox);
  el.introspectionUrlEncodeCheckbox.addEventListener("change", renderIntrospectionBox);
  el.introspectionVariantSelect.addEventListener("change", renderIntrospectionBox);
  renderIntrospectionBox();

  // ---------------------------------------------------------------------
  // Clipboard (with file:// fallback)
  // ---------------------------------------------------------------------

  async function copyToClipboard(text, btn) {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback: temporary textarea + execCommand, for contexts where the
      // async Clipboard API is unavailable (older browsers, some file:// cases).
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e2) {
        btn.textContent = "Copy failed: select & copy manually";
        setTimeout(() => (btn.textContent = original), 2000);
        document.body.removeChild(ta);
        return;
      }
      document.body.removeChild(ta);
    }
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = original), 1200);
  }

  el.copyIntrospectionBtn.addEventListener("click", () => {
    copyToClipboard(currentIntrospectionText, el.copyIntrospectionBtn);
  });

  let currentQueryText = "";

  el.copyQueryBtn.addEventListener("click", () => {
    copyToClipboard(currentQueryText, el.copyQueryBtn);
  });

  el.oneLineCheckbox.addEventListener("change", renderQueryPanel);
  el.urlEncodeCheckbox.addEventListener("change", renderQueryPanel);

  // ---------------------------------------------------------------------
  // Import / parsing
  // ---------------------------------------------------------------------

  function showImportError(message) {
    el.importError.hidden = false;
    el.importError.textContent = message;
  }

  function clearImportError() {
    el.importError.hidden = true;
    el.importError.textContent = "";
  }

  function extractIntrospection(parsedJson) {
    if (parsedJson && parsedJson.__schema) return parsedJson;
    if (parsedJson && parsedJson.data && parsedJson.data.__schema) return parsedJson.data;
    return null;
  }

  function parseSchemaText(text) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Nothing to load: paste a schema or introspection result first.");

    let json = null;
    let jsonError = null;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      jsonError = e;
    }

    if (json !== null) {
      const introspection = extractIntrospection(json);
      if (!introspection) {
        throw new Error(
          "That's valid JSON, but it doesn't look like an introspection result " +
            '(expected a top-level "__schema" key, or "data.__schema"). ' +
            "If this was meant to be SDL text instead, make sure it isn't valid JSON."
        );
      }
      if (!Array.isArray(introspection.__schema.types)) {
        throw new Error(
          'This result has no "types" list under __schema, so there\'s no full schema here to build ' +
            "from (looks like a Root types only result). That's fine for seeing what operations exist, " +
            'but to actually build queries here, try the "Basic schema" or "Full introspection" option instead.'
        );
      }
      return GQL.buildClientSchema(introspection);
    }

    // Not JSON — treat as SDL.
    try {
      return GQL.buildSchema(trimmed);
    } catch (e) {
      throw new Error("Couldn't parse this as introspection JSON or as SDL.\n\n" + e.message);
    }
  }

  function loadSchemaFromText(text) {
    clearImportError();
    let schema;
    try {
      schema = parseSchemaText(text);
    } catch (e) {
      showImportError(e.message);
      return;
    }
    initSchema(schema, text);
  }

  el.loadSchemaBtn.addEventListener("click", () => {
    loadSchemaFromText(el.schemaInput.value);
  });

  el.clearSchemaInputBtn.addEventListener("click", () => {
    el.schemaInput.value = "";
    el.schemaFile.value = "";
    clearImportError();
    el.schemaInput.focus();
  });

  el.schemaFile.addEventListener("change", () => {
    const file = el.schemaFile.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      el.schemaInput.value = String(reader.result);
      loadSchemaFromText(String(reader.result));
    };
    reader.onerror = () => showImportError("Couldn't read that file.");
    reader.readAsText(file);
  });

  el.loadDifferentBtn.addEventListener("click", () => {
    state.schema = null;
    state.schemaText = null;
    state.tabs = {};
    state.activeTab = null;
    clearAutosave();
    el.schemaInput.value = "";
    el.schemaFile.value = "";
    el.builder.hidden = true;
    el.landing.hidden = false;
    el.schemaStatus.textContent = "";
    clearImportError();
  });

  // ---------------------------------------------------------------------
  // Schema init
  // ---------------------------------------------------------------------

  function makeTabState(kind, rootType) {
    return { kind, rootType, selection: new Map(), opName: "" };
  }

  // `restore`, when given (only on the autosave-restore path — never on a
  // fresh "Load schema" click), is the persisted `{ activeTab, tabs }`
  // payload to rehydrate the selection trees from instead of starting blank.
  function initSchema(schema, schemaText, restore) {
    state.schema = schema;
    state.schemaText = schemaText;
    state.tabs = {};
    state.typeGraph = buildTypeGraph(schema);

    const q = schema.getQueryType();
    const m = schema.getMutationType();
    const s = schema.getSubscriptionType();

    if (q) state.tabs.query = makeTabState("query", q);
    if (m) state.tabs.mutation = makeTabState("mutation", m);
    if (s) state.tabs.subscription = makeTabState("subscription", s);

    if (restore && restore.tabs) {
      for (const key of Object.keys(state.tabs)) {
        const savedTab = restore.tabs[key];
        if (!savedTab) continue;
        const tab = state.tabs[key];
        if (typeof savedTab.opName === "string") tab.opName = savedTab.opName;
        tab.selection = rehydrateSelection(schema, tab.rootType, savedTab.selection || []);
      }
    }

    state.activeTab =
      restore && restore.activeTab && state.tabs[restore.activeTab]
        ? restore.activeTab
        : q
        ? "query"
        : Object.keys(state.tabs)[0];

    const typeCount = Object.keys(schema.getTypeMap()).filter((n) => !n.startsWith("__")).length;
    el.schemaStatus.textContent = `Schema loaded (${typeCount} types)`;

    el.landing.hidden = true;
    el.builder.hidden = false;

    renderTabs();
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Autosave (localStorage)
  // ---------------------------------------------------------------------

  // Flattens one selection Node to plain data: field name (its fieldDef is
  // re-looked-up on restore, not serialized), the already-plain-JSON
  // argValues (strings, or the {raw, fields} shape from makeInputObjectValue
  // — never a live schema reference), and children/fragments recursed the
  // same way.
  function serializeNode(name, node) {
    const out = { name, argValues: node.argValues };
    if (node.children) out.children = serializeSelection(node.children);
    if (node.fragments) {
      // Keyed by possible-type name straight from the (possibly hostile)
      // target schema — see the note on argValues in makeNode.
      out.fragments = Object.create(null);
      for (const [typeName, subMap] of node.fragments) out.fragments[typeName] = serializeSelection(subMap);
    }
    return out;
  }

  function serializeSelection(map) {
    return [...map.entries()].map(([name, node]) => serializeNode(name, node));
  }

  function serializeTabs(tabs) {
    const out = {};
    for (const key of Object.keys(tabs)) {
      out[key] = { opName: tabs[key].opName, selection: serializeSelection(tabs[key].selection) };
    }
    return out;
  }

  // Rebuilds a Node from its serialized form against `fieldDef` from the
  // freshly-parsed schema. If the schema text changed since the save (a
  // field got renamed/removed), that branch is just silently dropped rather
  // than failing the whole restore — an autosave is a convenience, not a
  // contract.
  function rehydrateNode(schema, serialized, fieldDef) {
    const node = makeNode(fieldDef);
    if (serialized.argValues && typeof serialized.argValues === "object") node.argValues = serialized.argValues;

    if (node.children && Array.isArray(serialized.children)) {
      const named = GQL.getNamedType(fieldDef.type);
      const fields = named.getFields ? named.getFields() : {};
      for (const childSer of serialized.children) {
        const childFieldDef = fields[childSer.name];
        if (!childFieldDef) continue;
        node.children.set(childSer.name, rehydrateNode(schema, childSer, childFieldDef));
      }
    }

    if (node.fragments && serialized.fragments && typeof serialized.fragments === "object") {
      for (const typeName of Object.keys(serialized.fragments)) {
        const possibleType = schema.getType(typeName);
        if (!possibleType || !possibleType.getFields) continue;
        const fields = possibleType.getFields();
        const subMap = new Map();
        for (const childSer of serialized.fragments[typeName]) {
          const childFieldDef = fields[childSer.name];
          if (!childFieldDef) continue;
          subMap.set(childSer.name, rehydrateNode(schema, childSer, childFieldDef));
        }
        node.fragments.set(typeName, subMap);
      }
    }

    return node;
  }

  function rehydrateSelection(schema, rootType, serializedList) {
    const map = new Map();
    const fields = rootType.getFields ? rootType.getFields() : {};
    for (const ser of serializedList) {
      const fieldDef = fields[ser.name];
      if (!fieldDef) continue;
      map.set(ser.name, rehydrateNode(schema, ser, fieldDef));
    }
    return map;
  }

  // Called after every state-changing action (see renderQueryPanel). Best
  // effort: localStorage can throw (quota exceeded, private-mode Safari,
  // disabled entirely) and none of that should ever break the builder.
  function persistState() {
    try {
      if (!loadSettings().persistenceEnabled) return;
      if (!state.schema) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const payload = {
        savedAt: Date.now(),
        schemaText: state.schemaText,
        activeTab: state.activeTab,
        tabs: serializeTabs(state.tabs),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      // Autosave is a nicety, not a requirement — ignore and move on.
    }
  }

  function clearAutosave() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // ignore
    }
  }

  function isBranchType(type) {
    const named = GQL.getNamedType(type);
    return GQL.isObjectType(named) || GQL.isInterfaceType(named) || GQL.isUnionType(named);
  }

  // A directed graph over the schema's object/interface/union types: an
  // edge X -> Y means "exploring X's subtree can reach Y's fields" (either
  // because some field on X returns Y, or because Y is a possible concrete
  // type of an interface/union X). Built once per schema load — the search
  // box needs "does this field's subtree contain a match" on every
  // keystroke, and computing that as a fresh recursive walk per row (with
  // schemas that commonly cycle, e.g. User -> posts -> author -> User)
  // risks either wrong answers from naive memoization across differently-
  // truncated call stacks, or a lot of repeated work. Precomputing the
  // static graph once, then doing a plain reverse-BFS from "types with a
  // direct name match" per keystroke, sidesteps both problems.
  function buildTypeGraph(schema) {
    const forwardEdges = new Map();
    const typeMap = schema.getTypeMap();
    for (const typeName of Object.keys(typeMap)) {
      if (typeName.startsWith("__")) continue;
      const type = typeMap[typeName];
      if (!(GQL.isObjectType(type) || GQL.isInterfaceType(type) || GQL.isUnionType(type))) continue;

      const neighbors = new Set();
      if (GQL.isObjectType(type) || GQL.isInterfaceType(type)) {
        const fields = type.getFields();
        for (const fieldName of Object.keys(fields)) {
          if (isBranchType(fields[fieldName].type)) {
            neighbors.add(GQL.getNamedType(fields[fieldName].type).name);
          }
        }
      }
      if (GQL.isInterfaceType(type) || GQL.isUnionType(type)) {
        for (const possibleType of schema.getPossibleTypes(type)) neighbors.add(possibleType.name);
      }
      forwardEdges.set(typeName, neighbors);
    }

    const reverseEdges = new Map();
    for (const [from, tos] of forwardEdges) {
      if (!reverseEdges.has(from)) reverseEdges.set(from, new Set());
      for (const to of tos) {
        if (!reverseEdges.has(to)) reverseEdges.set(to, new Set());
        reverseEdges.get(to).add(from);
      }
    }
    return { reverseEdges };
  }

  // Returns the set of type names whose fields either directly match
  // `filter`, or whose subtree reaches a type that does — i.e. "expand
  // into this field to reveal a match somewhere below."
  function computeMatchingTypeNames(schema, typeGraph, filter) {
    const seedTypes = new Set();
    const typeMap = schema.getTypeMap();
    for (const typeName of Object.keys(typeMap)) {
      if (typeName.startsWith("__")) continue;
      const type = typeMap[typeName];
      if (!(GQL.isObjectType(type) || GQL.isInterfaceType(type))) continue;
      const fields = type.getFields();
      if (Object.keys(fields).some((fn) => fieldMatchesFilter(fn, filter))) seedTypes.add(typeName);
    }

    const result = new Set(seedTypes);
    const queue = [...seedTypes];
    while (queue.length) {
      const t = queue.shift();
      const preds = typeGraph.reverseEdges.get(t);
      if (!preds) continue;
      for (const p of preds) {
        if (!result.has(p)) {
          result.add(p);
          queue.push(p);
        }
      }
    }
    return result;
  }

  // Walks (creating ancestor nodes as needed) from the tab's root selection
  // down `path` and sets or clears the leaf. `path` is an array of
  // { kind: "field", name, fieldDef } steps, with a { kind: "fragment",
  // typeName } step inserted directly after any field whose return type is
  // an interface/union, for the concrete type being selected into. This is
  // the only place selection state gets mutated by a checkbox click — it's
  // what lets you check a box several levels deep inside a branch that was
  // only showing because the search box auto-expanded it, without that
  // branch (or any of its ancestors) having been selected yet.
  function setSelectedAtPath(tab, path, checked) {
    let map = tab.selection;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      const isLast = i === path.length - 1;

      let node = map.get(step.name);
      if (!node) {
        node = makeNode(step.fieldDef);
        map.set(step.name, node);
      }
      if (isLast) {
        if (!checked) map.delete(step.name);
        return;
      }

      const nextStep = path[i + 1];
      if (nextStep.kind === "fragment") {
        if (!node.fragments.has(nextStep.typeName)) node.fragments.set(nextStep.typeName, new Map());
        map = node.fragments.get(nextStep.typeName);
        i++; // consume the fragment step — it's just a transition, not its own map entry
      } else {
        map = node.children;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Selection tree helpers
  // ---------------------------------------------------------------------

  function makeNode(fieldDef) {
    const named = GQL.getNamedType(fieldDef.type);
    // argValues is keyed by argument name straight from the (possibly
    // hostile) target schema, which can legally be named "__proto__" —
    // Object.create(null) so a bracket-assignment to that key stores a
    // normal own property instead of silently reassigning this object's
    // prototype (which would also vanish on the next JSON.stringify).
    const node = { field: fieldDef, argValues: Object.create(null), children: null, fragments: null, includeTypename: false };
    if (GQL.isObjectType(named) || GQL.isInterfaceType(named)) {
      node.children = new Map();
    }
    if (GQL.isInterfaceType(named) || GQL.isUnionType(named)) {
      node.fragments = new Map();
      node.includeTypename = true;
    }
    for (const argDef of fieldDef.args) {
      const value = initialArgValue(argDef.type);
      if (value !== undefined) node.argValues[argDef.name] = value;
    }
    return node;
  }

  function isWrappedInList(type) {
    if (GQL.isNonNullType(type)) return isWrappedInList(type.ofType);
    return GQL.isListType(type);
  }

  // An arg's stored value is either a plain string (scalars, enums,
  // booleans, and lists of any of those — including lists of input
  // objects, which stay on the raw-text list path below) or, for a
  // non-list INPUT_OBJECT arg, a structured value node:
  //   { raw: null, fields: { [fieldName]: value } }   — structured mode
  //   { raw: "<text>", fields: {...} }                 — raw-text override
  // `fields` recurses with the same shape for nested input objects.
  function initialArgValue(type) {
    if (GQL.isNonNullType(type)) return initialArgValue(type.ofType);
    if (GQL.isListType(type)) {
      // Lists (including lists of input objects) keep the old flat-text
      // skeleton — a repeatable add/remove-item UI is a bigger feature
      // than structured single-object args.
      const skeleton = skeletonForArgType(type);
      return skeleton === null ? undefined : skeleton;
    }
    const named = GQL.getNamedType(type);
    if (GQL.isInputObjectType(named)) return makeInputObjectValue(named);
    return undefined;
  }

  function makeInputObjectValue(inputType, seenTypeNames) {
    const seen = seenTypeNames || new Set();
    if (seen.has(inputType.name) || seen.size > 6) {
      // Self-referential or very deep input types: fall back to raw mode
      // rather than recursing forever.
      return { raw: "{}", fields: Object.create(null) };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(inputType.name);

    // Keyed by input-object field name straight from the (possibly
    // hostile) target schema — see the same note on argValues in makeNode.
    const fields = Object.create(null);
    const inputFields = inputType.getFields();
    for (const name of Object.keys(inputFields)) {
      const fieldType = inputFields[name].type;
      const namedFieldType = GQL.getNamedType(fieldType);
      if (GQL.isInputObjectType(namedFieldType) && !isWrappedInList(fieldType)) {
        fields[name] = makeInputObjectValue(namedFieldType, nextSeen);
      } else {
        fields[name] = ""; // scalar/enum/bool/list leaf — starts blank, widget shows its type as a placeholder
      }
    }
    return { raw: null, fields };
  }

  // Pre-fills lists (including lists of input objects) with a generated
  // skeleton literal so you're editing a correctly-shaped starting point
  // instead of guessing field names blind.
  function skeletonForArgType(type, seenTypeNames) {
    if (GQL.isNonNullType(type)) return skeletonForArgType(type.ofType, seenTypeNames);
    if (GQL.isListType(type)) {
      const inner = skeletonForArgType(type.ofType, seenTypeNames);
      return inner === null ? null : `[${inner}]`;
    }
    const named = GQL.getNamedType(type);
    if (!GQL.isInputObjectType(named)) return null;
    return skeletonForInputType(named, seenTypeNames || new Set());
  }

  function skeletonForInputType(inputType, seenTypeNames) {
    if (seenTypeNames.has(inputType.name) || seenTypeNames.size > 6) return "{}"; // guard against self-referential / deep input types
    const nextSeen = new Set(seenTypeNames);
    nextSeen.add(inputType.name);

    const fields = inputType.getFields();
    const entries = Object.keys(fields).map((name) => `${name}: ${placeholderForType(fields[name].type, nextSeen)}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }

  function placeholderForType(type, seenTypeNames) {
    if (GQL.isNonNullType(type)) return placeholderForType(type.ofType, seenTypeNames);
    if (GQL.isListType(type)) return "[]";
    const named = GQL.getNamedType(type);
    if (GQL.isInputObjectType(named)) return skeletonForInputType(named, seenTypeNames);
    if (GQL.isEnumType(named)) return named.getValues()[0] ? named.getValues()[0].name : "null";
    if (named.name === "Boolean") return "false";
    if (named.name === "Int" || named.name === "Float") return "0";
    return '""';
  }

  function isBranchNode(node) {
    return node.children !== null || node.fragments !== null;
  }

  // ---------------------------------------------------------------------
  // Arg literal serialization
  // ---------------------------------------------------------------------

  function splitTopLevelCommas(s) {
    const parts = [];
    let depth = 0;
    let inStr = false;
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && s[i - 1] !== "\\") inStr = !inStr;
      if (!inStr) {
        if (ch === "[" || ch === "{") depth++;
        if (ch === "]" || ch === "}") depth--;
      }
      if (ch === "," && depth === 0 && !inStr) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim() !== "") parts.push(cur);
    return parts;
  }

  function serializeByType(raw, type) {
    if (GQL.isNonNullType(type)) return serializeByType(raw, type.ofType);

    if (GQL.isListType(type)) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) return trimmed; // user typed the full list literal themselves
      const items = splitTopLevelCommas(raw).map((s) => serializeByType(s.trim(), type.ofType));
      return "[" + items.join(", ") + "]";
    }

    const named = GQL.getNamedType(type);
    if (GQL.isEnumType(named)) return raw.trim(); // bare word — dropdown constrains this
    if (GQL.isInputObjectType(named)) return raw.trim(); // raw GraphQL object literal, passed through
    if (named.name === "Boolean") return raw.trim();
    if (named.name === "Int" || named.name === "Float") return raw.trim();
    return JSON.stringify(raw); // String, ID, custom scalars
  }

  function serializeArgValue(raw, type) {
    if (raw === undefined || raw.trim() === "") return undefined;
    return serializeByType(raw, type);
  }

  // Flags scalar/boolean args whose typed-in value doesn't actually match
  // their declared type (e.g. "abc" for an Int arg). Enums/booleans go
  // through dropdowns so they're always valid; input objects and raw list
  // literals are user-typed passthrough and aren't validated here.
  function checkArgTypeIssues(raw, type) {
    if (typeof raw !== "string" || raw.trim() === "") return [];
    if (GQL.isNonNullType(type)) return checkArgTypeIssues(raw, type.ofType);

    if (GQL.isListType(type)) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) return []; // user typed the full literal — trust it
      return splitTopLevelCommas(raw).flatMap((item) => checkArgTypeIssues(item.trim(), type.ofType));
    }

    const named = GQL.getNamedType(type);
    const value = raw.trim();
    if (GQL.isInputObjectType(named) || GQL.isEnumType(named)) return [];
    if (named.name === "Boolean") {
      return value === "true" || value === "false" ? [] : [`expected true/false, got "${value}"`];
    }
    if (named.name === "Int") {
      return /^-?\d+$/.test(value) ? [] : [`expected an integer, got "${value}"`];
    }
    if (named.name === "Float") {
      return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ? [] : [`expected a number, got "${value}"`];
    }
    return [];
  }

  // ---------------------------------------------------------------------
  // Document generation
  //
  // Builds a flat list of {cls, text} tokens rather than a plain string, so
  // the query panel can be syntax-highlighted from the same pass that
  // already knows the semantic role of each piece (field name vs arg name
  // vs literal vs punctuation) — no separate re-parsing of our own output.
  // ---------------------------------------------------------------------

  let warnings = [];
  let tokens = [];

  function push(cls, text) {
    tokens.push({ cls, text });
  }

  function nodeHasVisibleContent(node) {
    if (!isBranchNode(node)) return true;
    const ownHasFields = node.children && node.children.size > 0;
    const fragHasFields = node.fragments && [...node.fragments.values()].some((m) => m.size > 0);
    return ownHasFields || fragHasFields;
  }

  // Tokenizes an already-serialized literal (e.g. `"42"`, `[FOO, BAR]`,
  // `{ title: "hi" }`) purely for coloring — it's finished text, not
  // something we need to re-validate.
  function pushLiteralTokens(text) {
    const re = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]|[_A-Za-z][_0-9A-Za-z]*|\s+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = m[0];
      if (/^\s+$/.test(t)) push(undefined, t);
      else if (t[0] === '"') push("string", t);
      else if (t === "true" || t === "false") push("bool", t);
      else if (t === "null") push("kw", t);
      else if (/^[{}[\]:,]$/.test(t)) push("punct", t);
      else if (/^-?\d/.test(t)) push("number", t);
      else push("enum", t); // bare word: enum value, or an input-object field name
    }
  }

  // Serializes a structured INPUT_OBJECT value (see makeInputObjectValue)
  // into a GraphQL object literal, recursing into nested input objects and
  // validating each scalar leaf the same way top-level args are validated.
  // `pathLabel` is just for readable warnings (e.g. "input.address.zip").
  function serializeInputObjectValue(valueNode, inputType, pathLabel) {
    if (!valueNode) return undefined;
    if (typeof valueNode.raw === "string") {
      const trimmed = valueNode.raw.trim();
      return trimmed === "" ? undefined : trimmed;
    }
    const inputFields = inputType.getFields();
    const entries = [];
    for (const fieldName of Object.keys(inputFields)) {
      const fieldDef = inputFields[fieldName];
      const fieldPath = `${pathLabel}.${fieldName}`;
      const serialized = serializeInputFieldValue(valueNode.fields[fieldName], fieldDef.type, fieldPath);
      if (serialized !== undefined) {
        entries.push(`${fieldName}: ${serialized}`);
      } else if (GQL.isNonNullType(fieldDef.type)) {
        warnings.push(`Required field "${fieldPath}" is empty.`);
      }
    }
    return entries.length === 0 ? undefined : `{ ${entries.join(", ")} }`;
  }

  function serializeInputFieldValue(raw, type, pathLabel) {
    if (GQL.isNonNullType(type)) return serializeInputFieldValue(raw, type.ofType, pathLabel);
    if (GQL.isListType(type)) {
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      return serializeByType(raw, type);
    }
    const named = GQL.getNamedType(type);
    if (GQL.isInputObjectType(named)) return serializeInputObjectValue(raw, named, pathLabel);
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    for (const issue of checkArgTypeIssues(raw, type)) {
      warnings.push(`Field "${pathLabel}": ${issue}.`);
    }
    return serializeByType(raw, type);
  }

  function printArgs(node) {
    const included = [];
    for (const argDef of node.field.args) {
      const raw = node.argValues[argDef.name];
      let serialized;
      if (raw && typeof raw === "object") {
        serialized = serializeInputObjectValue(raw, GQL.getNamedType(argDef.type), argDef.name);
      } else {
        serialized = serializeArgValue(raw, argDef.type);
        if (serialized !== undefined) {
          for (const issue of checkArgTypeIssues(raw, argDef.type)) {
            warnings.push(`Arg "${argDef.name}" on field "${node.field.name}": ${issue}.`);
          }
        }
      }
      if (serialized === undefined) {
        if (GQL.isNonNullType(argDef.type)) {
          warnings.push(`Required arg "${argDef.name}" on field "${node.field.name}" is empty.`);
        }
        continue;
      }
      included.push({ name: argDef.name, serialized });
    }
    if (included.length === 0) return;
    push("punct", "(");
    included.forEach((a, i) => {
      if (i > 0) push("punct", ", ");
      push("arg-name", a.name);
      push("punct", ": ");
      pushLiteralTokens(a.serialized);
    });
    push("punct", ")");
  }

  function printSelectionSet(map, fragments, includeTypename, indent) {
    const pad = "  ".repeat(indent);
    let wroteAny = false;

    if (includeTypename) {
      push(undefined, pad);
      push("field-meta", "__typename");
      push(undefined, "\n");
      wroteAny = true;
    }

    for (const [name, node] of map) {
      if (isBranchNode(node) && !nodeHasVisibleContent(node)) {
        warnings.push(
          `"${name}" needs at least one field selected (directly, or within a "... on Type" fragment). Omitted.`
        );
        continue;
      }
      push(undefined, pad);
      printField(node, indent);
      push(undefined, "\n");
      wroteAny = true;
    }

    if (fragments) {
      for (const [typeName, subMap] of fragments) {
        if (subMap.size === 0) continue;
        push(undefined, pad);
        push("kw", "...");
        push(undefined, " ");
        push("kw", "on");
        push(undefined, " ");
        push("type", typeName);
        push(undefined, " ");
        push(braceCls(indent), "{");
        push(undefined, "\n");
        printSelectionSet(subMap, null, false, indent + 1);
        push(undefined, pad);
        push(braceCls(indent), "}");
        push(undefined, "\n");
        wroteAny = true;
      }
    }

    if (wroteAny) tokens.pop(); // trim the trailing newline before the parent adds its own
  }

  function printField(node, indent) {
    push("field", node.field.name);
    printArgs(node);
    if (isBranchNode(node)) {
      push(undefined, " ");
      push(braceCls(indent), "{");
      push(undefined, "\n");
      printSelectionSet(node.children || new Map(), node.fragments, node.includeTypename, indent + 1);
      push(undefined, "\n" + "  ".repeat(indent));
      push(braceCls(indent), "}");
    }
  }

  function generateDocument(tab) {
    warnings = [];
    tokens = [];
    if (!tab || tab.selection.size === 0) {
      return { text: "", tokens: [], warnings };
    }
    const name = tab.opName.trim();
    push("kw", tab.kind);
    if (name) {
      push(undefined, " ");
      push("op-name", name);
    }
    push(undefined, " ");
    push(braceCls(0), "{");
    push(undefined, "\n");
    printSelectionSet(tab.selection, null, false, 1);
    push(undefined, "\n");
    push(braceCls(0), "}");
    const text = tokens.map((t) => t.text).join("");
    return { text, tokens, warnings };
  }

  // Collapses every run of whitespace-only tokens to a single space, so the
  // same token stream can render as one line (for Burp/curl) without a
  // second text-mangling pass, and without losing syntax highlighting.
  // Indentation and newlines are pushed as separate adjacent tokens, so
  // this has to merge runs — mapping each token to its own space one-to-one
  // leaves doubled-up spaces behind (indent token + newline token, each
  // turning into a space).
  function collapseToSingleLine(toks) {
    const merged = [];
    for (const t of toks) {
      const isWs = /^\s+$/.test(t.text); // indent-guide tokens are pure whitespace too, despite carrying a class
      if (isWs) {
        const last = merged[merged.length - 1];
        if (last && last.collapsedWs) continue;
        merged.push({ cls: undefined, text: " ", collapsedWs: true });
      } else {
        merged.push(t);
      }
    }
    if (merged.length && merged[0].collapsedWs) merged.shift();
    if (merged.length && merged[merged.length - 1].collapsedWs) merged.pop();
    return merged;
  }

  // ---------------------------------------------------------------------
  // Rendering — tabs
  // ---------------------------------------------------------------------

  const TAB_LABELS = { query: "Query", mutation: "Mutation", subscription: "Subscription" };

  function renderTabs() {
    el.operationTabs.innerHTML = "";
    for (const key of Object.keys(state.tabs)) {
      const btn = document.createElement("div");
      btn.className = "tab" + (key === state.activeTab ? " active" : "");
      btn.textContent = TAB_LABELS[key];
      btn.addEventListener("click", () => {
        state.activeTab = key;
        renderTabs();
        renderAll();
      });
      el.operationTabs.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------------
  // Rendering — field tree
  // ---------------------------------------------------------------------

  function typeToString(type) {
    if (GQL.isNonNullType(type)) return typeToString(type.ofType) + "!";
    if (GQL.isListType(type)) return "[" + typeToString(type.ofType) + "]";
    return type.name;
  }

  function fieldMatchesFilter(name, filter) {
    if (!filter) return true;
    return name.toLowerCase().includes(filter);
  }

  // Builds the input widget for a scalar/enum/boolean/list arg or input
  // field (never an INPUT_OBJECT itself — those recurse via
  // renderInputObjectBlock instead). Shared between top-level args and
  // structured input-object fields so both get identical widgets.
  function createTypedWidget(type, currentValue, onChange) {
    const named = GQL.getNamedType(type);
    const isListSomewhere = isWrappedInList(type);

    let input;
    if (GQL.isEnumType(named)) {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "-";
      input.appendChild(blank);
      for (const v of named.getValues()) {
        const o = document.createElement("option");
        o.value = v.name;
        o.textContent = v.name;
        input.appendChild(o);
      }
    } else if (named.name === "Boolean" && !isListSomewhere) {
      input = document.createElement("select");
      for (const v of ["", "true", "false"]) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v || "-";
        input.appendChild(o);
      }
    } else if (isListSomewhere) {
      input = document.createElement("textarea");
      input.placeholder = GQL.isInputObjectType(named)
        ? `comma-separated ${named.name} literals, or a full [ ... ] literal`
        : "comma-separated values, or a full [ ... ] literal";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = typeToString(type);
    }

    input.value = currentValue || "";
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }

  // Renders a non-list INPUT_OBJECT value: either a raw-text textarea
  // (valueNode.raw !== null) or one typed row per field of the input
  // type, recursing into nested input objects the same way. `onChange`
  // re-renders just the query panel — the tree only needs a full rebuild
  // when the raw/structured toggle changes the DOM shape.
  function renderInputObjectBlock(container, valueNode, inputType, onChange, onToggle) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "link-btn";
    toggleBtn.textContent = typeof valueNode.raw === "string" ? "Edit as structured fields" : "Edit as raw text";
    toggleBtn.addEventListener("click", () => {
      if (typeof valueNode.raw === "string") {
        valueNode.raw = null; // switch to structured — .fields was never touched, so it's untouched
      } else {
        // Switch to raw: pre-fill with whatever's already in the structured
        // fields, so toggling isn't destructive.
        const serialized = serializeInputObjectValue({ raw: null, fields: valueNode.fields }, inputType, "value");
        valueNode.raw = serialized || "";
      }
      onToggle();
    });
    container.appendChild(toggleBtn);

    if (typeof valueNode.raw === "string") {
      const ta = document.createElement("textarea");
      ta.className = "input-object-raw";
      ta.placeholder = `raw GraphQL literal for ${inputType.name}, e.g. { field: "value" }`;
      ta.value = valueNode.raw;
      ta.addEventListener("input", () => {
        valueNode.raw = ta.value;
        onChange();
      });
      container.appendChild(ta);
      return;
    }

    const fieldsWrap = document.createElement("div");
    fieldsWrap.className = "arg-inputs";
    const inputFields = inputType.getFields();
    for (const fieldName of Object.keys(inputFields)) {
      const fieldDef = inputFields[fieldName];
      const named = GQL.getNamedType(fieldDef.type);

      if (GQL.isInputObjectType(named) && !isWrappedInList(fieldDef.type)) {
        const heading = document.createElement("div");
        heading.className = "arg-input";
        const label = document.createElement("label");
        label.textContent = fieldName + ":";
        if (GQL.isNonNullType(fieldDef.type)) label.className = "arg-required";
        heading.appendChild(label);
        fieldsWrap.appendChild(heading);

        if (typeof valueNode.fields[fieldName] !== "object" || valueNode.fields[fieldName] === null) {
          valueNode.fields[fieldName] = makeInputObjectValue(named);
        }
        const nested = document.createElement("div");
        nested.className = "input-object-nested";
        renderInputObjectBlock(nested, valueNode.fields[fieldName], named, onChange, onToggle);
        fieldsWrap.appendChild(nested);
        continue;
      }

      const row = document.createElement("div");
      row.className = "arg-input";
      const label = document.createElement("label");
      label.textContent = fieldName + ":";
      if (GQL.isNonNullType(fieldDef.type)) label.className = "arg-required";
      row.appendChild(label);

      const widget = createTypedWidget(fieldDef.type, valueNode.fields[fieldName], (v) => {
        valueNode.fields[fieldName] = v;
        onChange();
      });
      row.appendChild(widget);
      fieldsWrap.appendChild(row);
    }
    container.appendChild(fieldsWrap);
  }

  function renderArgInputs(node) {
    const wrap = document.createElement("div");
    wrap.className = "arg-inputs";
    for (const argDef of node.field.args) {
      const named = GQL.getNamedType(argDef.type);

      if (GQL.isInputObjectType(named) && !isWrappedInList(argDef.type)) {
        const heading = document.createElement("div");
        heading.className = "arg-input";
        const label = document.createElement("label");
        label.textContent = argDef.name + ":";
        if (GQL.isNonNullType(argDef.type)) label.className = "arg-required";
        heading.appendChild(label);
        wrap.appendChild(heading);

        const nested = document.createElement("div");
        nested.className = "input-object-nested";
        renderInputObjectBlock(nested, node.argValues[argDef.name], named, renderQueryPanel, () => {
          renderFieldTree();
          renderQueryPanel();
        });
        wrap.appendChild(nested);
        continue;
      }

      const row = document.createElement("div");
      row.className = "arg-input";
      const label = document.createElement("label");
      label.textContent = argDef.name + ":";
      if (GQL.isNonNullType(argDef.type)) label.className = "arg-required";
      row.appendChild(label);

      const widget = createTypedWidget(argDef.type, node.argValues[argDef.name], (v) => {
        node.argValues[argDef.name] = v;
        renderQueryPanel();
      });
      row.appendChild(widget);
      wrap.appendChild(row);
    }
    return wrap;
  }

  // Wraps the substring of `text` that case-insensitively matches `filter`
  // in <mark>, HTML-escaping everything else. `filter` may be pre-lowered
  // (it is, from renderFieldTree) — matching is case-insensitive regardless.
  function highlightMatch(text, filter) {
    if (!filter) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(filter.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + filter.length);
    const after = text.slice(idx + filter.length);
    return escapeHtml(before) + '<mark class="search-highlight">' + escapeHtml(match) + "</mark>" + escapeHtml(after);
  }

  function renderFieldList(
    container,
    parentType,
    selectionMap,
    filter,
    isDangerRoot,
    path,
    matchingTypes,
    visitedTypeNames,
    defaultExpand,
    showAllHere
  ) {
    const fields = parentType.getFields ? parentType.getFields() : {};
    for (const fieldName of Object.keys(fields)) {
      const fieldDef = fields[fieldName];
      const node = selectionMap ? selectionMap.get(fieldName) : undefined;
      const selected = !!node;

      // fieldMatchesFilter treats an empty filter as "matches everything" —
      // fine for the no-search browsing case, but not something that
      // should ever drive auto-expansion (that way lies infinite recursion
      // into cyclic schemas like User -> posts -> Post -> author -> User).
      // `isNameMatch` is the "this field is a real, active search hit"
      // signal used everywhere below; it's false whenever there's no filter.
      const isNameMatch = !!filter && fieldMatchesFilter(fieldName, filter);
      const branchType = isBranchType(fieldDef.type);
      const branchTypeName = branchType ? GQL.getNamedType(fieldDef.type).name : null;
      // Schemas commonly cycle (User -> posts -> Post -> author -> User);
      // once a type's been auto-expanded once on this path, don't let a
      // search match keep re-triggering auto-expansion back into it —
      // that would recurse forever. Selected branches aren't subject to
      // this (they're bounded by the real, finite selection tree already).
      const descendantMatch =
        !!filter && branchType && matchingTypes.has(branchTypeName) && !visitedTypeNames.has(branchTypeName);

      // Selected fields always stay visible regardless of the filter, so
      // searching for something new never hides what you've already built.
      // `showAllHere` is true when the field that led into *this* container
      // was itself a real match (selected, or matched by name) rather than
      // just a waypoint on the way to a match further down — in that case
      // every immediate child is available to click, not just the ones
      // that happen to match too. Everything else poofs the moment it
      // neither matches by name nor has a match somewhere in its subtree;
      // it reappears as soon as the filter no longer rules it out
      // (backspace enough, or clear it).
      if (filter && !showAllHere && !isNameMatch && !descendantMatch && !selected) continue;

      const fieldPath = [...path, { name: fieldName, fieldDef }];

      const row = document.createElement("div");
      row.className = "field-row" + (selected ? " selected" : "") + (isDangerRoot ? " mutation-danger" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected;
      checkbox.title = "Add to query";
      checkbox.addEventListener("change", () => {
        setSelectedAtPath(state.tabs[state.activeTab], fieldPath, checkbox.checked);
        renderFieldTree();
        renderQueryPanel();
      });

      const body = document.createElement("div");
      body.className = "field-body";

      const mainLine = document.createElement("div");
      mainLine.className = "field-main-line";

      const nameSpan = document.createElement("span");
      nameSpan.className = "field-name" + (fieldDef.isDeprecated ? " deprecated" : "");
      nameSpan.innerHTML = highlightMatch(fieldName, filter);
      mainLine.appendChild(nameSpan);

      const typeSpan = document.createElement("span");
      typeSpan.className = "field-type";
      typeSpan.textContent = ": " + typeToString(fieldDef.type);
      mainLine.appendChild(typeSpan);

      if (fieldDef.isDeprecated) {
        const badge = document.createElement("span");
        badge.className = "deprecated-badge";
        badge.textContent = "deprecated" + (fieldDef.deprecationReason ? ": " + fieldDef.deprecationReason : "");
        mainLine.appendChild(badge);
      }

      body.appendChild(mainLine);

      if (fieldDef.description) {
        const desc = document.createElement("div");
        desc.className = "field-desc";
        desc.textContent = fieldDef.description;
        body.appendChild(desc);
      }

      if (selected && fieldDef.args.length > 0) {
        body.appendChild(renderArgInputs(node));
      }

      row.appendChild(checkbox);
      row.appendChild(body);
      container.appendChild(row);

      // Expand into the field's return type if it's genuinely selected, if
      // its own name matches (finding "apiKeys" for a search of "apikey"
      // should reveal its fields ready to pick, not just show the row), if
      // the search box found a match somewhere below (never touches
      // selection state, so clearing the search collapses it right back
      // unless something inside got checked), or if this is a totally
      // blank tab (defaultExpand) — showing one level of structure so it's
      // obvious there's a query to build, not just a flat field list.
      // defaultExpand is deliberately not passed down into either recursive
      // call below, so it only ever opens exactly one level deep.
      if (branchType && (selected || descendantMatch || isNameMatch || defaultExpand)) {
        const nested = document.createElement("div");
        nested.className = "nested-container";

        const named = GQL.getNamedType(fieldDef.type);
        const hasOwnFields = GQL.isObjectType(named) || GQL.isInterfaceType(named);
        const hasFragments = GQL.isInterfaceType(named) || GQL.isUnionType(named);
        const nextVisited = new Set(visitedTypeNames);
        nextVisited.add(named.name);
        // Earned fresh at this exact field, not inherited from above: a
        // level revealed only because it's on the path to a deeper match
        // (descendantMatch) still filters its own children strictly, so
        // "needle in a haystack" search results stay narrow. A level
        // revealed because *it itself* is selected or matched keeps all
        // of its immediate children available — cascading further down
        // only through fields that are themselves selected or matched.
        const childShowAll = selected || isNameMatch;

        if (hasOwnFields) {
          renderFieldList(
            nested,
            named,
            node ? node.children : undefined,
            filter,
            false,
            fieldPath,
            matchingTypes,
            nextVisited,
            false,
            childShowAll
          );
        }

        if (hasFragments) {
          const possibleTypes = state.schema.getPossibleTypes(named);
          for (const possibleType of possibleTypes) {
            if (node && node.fragments && !node.fragments.has(possibleType.name)) {
              node.fragments.set(possibleType.name, new Map());
            }
            const fragMap = node && node.fragments ? node.fragments.get(possibleType.name) : undefined;

            const fragContainer = document.createElement("div");
            fragContainer.className = "nested-container";
            const fragPath = [...fieldPath, { kind: "fragment", typeName: possibleType.name }];
            const fragVisited = new Set(nextVisited);
            fragVisited.add(possibleType.name);
            renderFieldList(
              fragContainer,
              possibleType,
              fragMap,
              filter,
              false,
              fragPath,
              matchingTypes,
              fragVisited,
              false,
              childShowAll
            );

            // While searching, skip a fragment section that ended up with
            // nothing to show (e.g. its only reachable match got truncated
            // by the cycle guard above) rather than showing an empty
            // "... on Type" with nothing under it. Without an active
            // search, always show every possible type so it stays
            // browsable.
            if (filter && fragContainer.childElementCount === 0) continue;

            const header = document.createElement("div");
            header.className = "fragment-header";
            header.textContent = "... on " + possibleType.name;
            nested.appendChild(header);
            nested.appendChild(fragContainer);
          }
        }

        if (!filter || nested.childElementCount > 0) {
          container.appendChild(nested);
        }
      }
    }
  }

  function renderFieldTree() {
    el.fieldTree.innerHTML = "";
    const tab = state.tabs[state.activeTab];
    if (!tab) return;
    const filter = el.fieldFilter.value.trim().toLowerCase();
    const matchingTypes = filter ? computeMatchingTypeNames(state.schema, state.typeGraph, filter) : null;
    // A completely untouched tab (nothing selected, no search) defaults to
    // one level of expansion everywhere, so it reads as "here's a query to
    // build" rather than a flat list of fields. Searching narrows it back
    // down immediately, same as it would for any other tab state.
    const defaultExpand = !filter && tab.selection.size === 0;
    renderFieldList(
      el.fieldTree,
      tab.rootType,
      tab.selection,
      filter,
      tab.kind === "mutation",
      [],
      matchingTypes,
      new Set([tab.rootType.name]),
      defaultExpand,
      false
    );
  }

  el.fieldFilter.addEventListener("input", renderFieldTree);

  el.clearAllBtn.addEventListener("click", () => {
    const tab = state.tabs[state.activeTab];
    if (!tab) return;
    tab.selection.clear();
    renderFieldTree();
    renderQueryPanel();
  });

  // ---------------------------------------------------------------------
  // Rendering — query panel
  // ---------------------------------------------------------------------

  function renderQueryPanel() {
    persistState();

    const tab = state.tabs[state.activeTab];

    if (!tab) {
      el.queryOutput.textContent = "";
      currentQueryText = "";
      el.warnings.hidden = true;
      return;
    }

    let { tokens: toks, warnings: w } = generateDocument(tab);

    const oneLine = el.oneLineCheckbox.checked;
    const urlEncode = el.urlEncodeCheckbox.checked;

    // URL-encoding implies one line regardless of whether that checkbox is
    // also on — collapseToSingleLine is a no-op on already-collapsed
    // tokens, so there's no double-collapse case to worry about.
    if (oneLine || urlEncode) toks = collapseToSingleLine(toks);

    const plainText = toks.map((t) => t.text).join("");

    if (toks.length === 0) {
      currentQueryText = "";
      el.queryOutput.textContent = "// Select fields on the left to build a query.";
    } else if (urlEncode) {
      // Encoded text isn't meaningfully "GraphQL" to syntax-highlight
      // anymore, and showing exactly what will land on the clipboard beats
      // showing pretty text that doesn't match it.
      currentQueryText = encodeURIComponent(plainText);
      el.queryOutput.textContent = currentQueryText;
    } else {
      currentQueryText = plainText;
      el.queryOutput.innerHTML = toks
        .map((t) => (t.cls ? `<span class="tok-${t.cls}">${escapeHtml(t.text)}</span>` : escapeHtml(t.text)))
        .join("");
    }

    if (w.length > 0) {
      el.warnings.hidden = false;
      el.warnings.innerHTML =
        "<strong>Heads up:</strong><ul>" + w.map((msg) => `<li>${escapeHtml(msg)}</li>`).join("") + "</ul>";
    } else {
      el.warnings.hidden = true;
    }
  }

  el.opNameInput.addEventListener("input", () => {
    const tab = state.tabs[state.activeTab];
    if (tab) tab.opName = el.opNameInput.value;
    renderQueryPanel();
  });

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------------------------------------------------------------
  // Full render
  // ---------------------------------------------------------------------

  function renderAll() {
    const tab = state.tabs[state.activeTab];
    el.opNameInput.value = tab ? tab.opName : "";
    el.fieldFilter.value = "";
    renderFieldTree();
    renderQueryPanel();
  }

  // ---------------------------------------------------------------------
  // Restore autosaved schema + in-progress query, if any
  // ---------------------------------------------------------------------

  (function restoreAutosave() {
    const settings = loadSettings();
    if (!settings.persistenceEnabled) return;

    let saved;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      saved = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!saved || typeof saved.schemaText !== "string") return;

    if (typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > settingsTtlMs(settings)) {
      clearAutosave();
      return;
    }

    let schema;
    try {
      schema = parseSchemaText(saved.schemaText);
    } catch (e) {
      // Saved text no longer parses (shouldn't happen, but doesn't matter
      // why) — drop it and just show the normal landing page.
      clearAutosave();
      return;
    }
    el.schemaInput.value = saved.schemaText;
    initSchema(schema, saved.schemaText, saved);
  })();
})();
