/** Registry of every supported local source. */
"use strict";

const zcode = require("./sources/zcode");
const workbuddy = require("./sources/workbuddy");
const claude = require("./sources/claude");
const codex = require("./sources/codex");
const opencode = require("./sources/opencode");
const pi = require("./sources/pi");
const codelyCli = require("./sources/codely-cli");
const traeCn = require("./sources/trae-cn");
const { loadCustomSources, CONFIG_PATH } = require("./custom-sources");
const { makeDeclarativeSource } = require("./sources/declarative");

/**
 * Built-in sources. ADR 0008's "exactly six" invariant was superseded when
 * Codely CLI and Trae CN joined the roster; test/registry.test.mjs asserts
 * the current list, so keep this array and EXPECTED_SOURCES in sync.
 * User-defined sources are kept in `dynamicAdapters` — adding one can never
 * shadow a shipped adapter.
 */
const ADAPTERS = [zcode, workbuddy, claude, codex, opencode, pi, codelyCli, traeCn];

let dynamicAdapters = [];
let lastLoad = { count: 0, errors: [], configPath: null };

/**
 * (Re)build the user-defined adapters for a workspace.
 * Safe to call repeatedly; an absent or broken config simply yields none.
 */
async function refreshDynamicSources(options = {}) {
  const { specs, errors, configPath } = await loadCustomSources(options);
  dynamicAdapters = [];
  for (const spec of specs) {
    try {
      dynamicAdapters.push(makeDeclarativeSource(spec));
    } catch (err) {
      errors.push(`spec ${spec.id}: ${err && err.message}`);
    }
  }
  lastLoad = { count: dynamicAdapters.length, errors, configPath };
  return dynamicAdapters;
}

function getDynamicAdapters() {
  return dynamicAdapters;
}

/** Diagnostics for the UI (why a custom source did or did not appear). */
function getDynamicLoadReport() {
  return lastLoad;
}

/** Built-ins first, so a custom spec can never shadow a shipped source. */
function allAdapters() {
  return dynamicAdapters.length ? [...ADAPTERS, ...dynamicAdapters] : ADAPTERS;
}

function getAdapter(source) {
  return allAdapters().find((a) => a.source === source) ?? null;
}

module.exports = {
  ADAPTERS,
  getAdapter,
  allAdapters,
  getDynamicAdapters,
  getDynamicLoadReport,
  refreshDynamicSources,
  CONFIG_PATH,
};
