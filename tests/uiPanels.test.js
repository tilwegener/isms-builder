/**
 * Statische Prüfungen von ui/app.js
 *
 * app.js ist eine Browser-Datei ohne Export und lässt sich in Jest nicht ohne DOM
 * laden. Die Prüfungen hier sind deshalb rein textuell — sie fangen Fehlerklassen ab,
 * die sonst erst im Browser und nur bei Nutzung der betroffenen Maske auffallen.
 *
 * 1. removeAllDynamicPanels() muss jeden dynamischen Panel-Container abräumen
 * 2. Callbacks dürfen die globale i18n-Funktion t() nicht überschatten
 *
 * Hintergrund zu 1: renderSectionContent() ruft removeAllDynamicPanels() auf, das die
 * dynamischen Panels über eine hartcodierte ID-Liste abräumt. Jede render*-Funktion
 * entfernt nur ihren eigenen Container. Fehlt eine ID in dieser Liste, bleibt das
 * Panel beim Sektionswechsel im DOM stehen — der Nutzer klickt links auf ein anderes
 * Modul und sieht rechts weiterhin das alte (so passiert mit 'nis2Container', V 1.37.0).
 *
 * Hintergrund zu 2: heißt der Parameter eines mehrzeiligen Template-Callbacks `t`,
 * überschattet er die globale i18n-Funktion `t()`. Ein `t('key')` im Callback wirft dann
 * "t is not a function"; in einer async render*-Funktion bricht damit der innerHTML-Aufbau
 * ab und die Maske bleibt dauerhaft auf „lädt…" stehen (so passiert in
 * renderAdminTemplatesTab, V 1.37.1).
 */
const fs = require('fs')
const path = require('path')

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8')

function removeListIds() {
  const fn = APP_JS.match(/function removeAllDynamicPanels\s*\(\)\s*\{([\s\S]*?)\n\}/)
  expect(fn).not.toBeNull()
  return new Set([...fn[1].matchAll(/'([A-Za-z0-9_]+Container)'/g)].map(m => m[1]))
}

function createdIds() {
  return new Set([...APP_JS.matchAll(/container\.id\s*=\s*'([A-Za-z0-9_]+Container)'/g)].map(m => m[1]))
}

describe('removeAllDynamicPanels', () => {
  test('existiert und listet Container-IDs', () => {
    const ids = removeListIds()
    expect(ids.size).toBeGreaterThan(10)
  })

  test('räumt jeden dynamisch erzeugten Panel-Container ab', () => {
    const listed = removeListIds()
    const missing = [...createdIds()].filter(id => !listed.has(id))
    expect(missing).toEqual([])
  })

  test('nis2Container ist enthalten (Regression V 1.37.0)', () => {
    expect(removeListIds().has('nis2Container')).toBe(true)
  })
})

/**
 * Sucht Callbacks, deren Parameter genau `t` heißt und deren Rumpf über mehrere Zeilen
 * geht (Template-Literal). Genau dort ist die Überschattung gefährlich, weil solche
 * Blöcke typischerweise Labels über t('key') übersetzen.
 */
function shadowedTCallbacks() {
  const lines = APP_JS.split('\n')
  const hits = []
  lines.forEach((line, i) => {
    if (!/=>\s*`\s*$/.test(line)) return                   // mehrzeiliges Template-Literal
    if (!/\(\s*\(?\s*t\s*(,\s*[A-Za-z0-9_]+\s*)?\)?\s*=>/.test(line)) return  // Parameter ist `t`
    for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
      if (/\bt\(\s*['"`]/.test(lines[j])) { hits.push({ callback: i + 1, use: j + 1 }); break }
      if (/^\s*`\)/.test(lines[j]) || /`\)\.join\(/.test(lines[j])) break     // Ende des Callbacks
    }
  })
  return hits
}

describe('i18n-Funktion t() wird nicht überschattet', () => {
  test('kein mehrzeiliger Template-Callback mit dem Parameternamen t ruft t() auf', () => {
    expect(shadowedTCallbacks()).toEqual([])
  })
})

/**
 * Navigations-Reihenfolge: die Default-Liste steht an drei Stellen (UI + beide Stores)
 * und muss jede Section aus SECTION_META enthalten. Fehlt eine ID, taucht das Modul unter
 * Administration → Organisation → Menüreihenfolge nicht auf und lässt sich nicht
 * einsortieren (so passiert mit 'nis2' und 'policy-acks', V 1.37.1).
 *
 * Die Store-Dateien werden bewusst als Text gelesen und nicht require't — ein require
 * würde beim Laden das echte data/-Verzeichnis anfassen.
 */
function idList(source, regex) {
  const m = source.match(regex)
  expect(m).not.toBeNull()
  return m[1].split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean)
}

function sectionMetaIds() {
  const block = APP_JS.match(/const SECTION_META = \[([\s\S]*?)\n\]/)
  expect(block).not.toBeNull()
  return [...block[1].matchAll(/id:\s*'([a-z0-9-]+)'/g)].map(m => m[1])
}

function storeNavOrder(relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
  return idList(src, /navOrder:\s*\[([^\]]+)\]/)
}

describe('Navigations-Reihenfolge', () => {
  test('_NAV_ORDER_DEFAULT enthält jede Section aus SECTION_META', () => {
    const nav = idList(APP_JS, /const _NAV_ORDER_DEFAULT = \[([^\]]+)\]/)
    const missing = sectionMetaIds().filter(id => !nav.includes(id))
    expect(missing).toEqual([])
  })

  test('_NAV_ORDER_DEFAULT enthält keine unbekannten IDs', () => {
    const nav = idList(APP_JS, /const _NAV_ORDER_DEFAULT = \[([^\]]+)\]/)
    const meta = sectionMetaIds()
    expect(nav.filter(id => !meta.includes(id))).toEqual([])
  })

  test('JSON-Store und Knex-Store haben dieselbe Default-Reihenfolge wie die UI', () => {
    const nav = idList(APP_JS, /const _NAV_ORDER_DEFAULT = \[([^\]]+)\]/)
    expect(storeNavOrder('server/db/orgSettingsStore.js')).toEqual(nav)
    expect(storeNavOrder('server/db/stores/orgSettingsStore.js')).toEqual(nav)
  })

  test('gespeicherte Reihenfolgen werden um fehlende Sections ergänzt', () => {
    expect(APP_JS).toMatch(/function _navOrderWithMissing/)
    expect(APP_JS).toMatch(/const list = _navOrderWithMissing\(order\)/)
  })
})
