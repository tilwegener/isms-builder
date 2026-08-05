// ISMS Builder V 1.29 – API Server (Node.js / Express)
// © 2026 Claude Hecker — AGPL-3.0

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const express = require('express')
const fs = require('fs')
const path = require('path')

const app = express()
const { requireAuth, authorize, signToken, getSessionFromReq } = require('./auth')
const PORT = process.env.PORT || 3000

app.use(express.json())

// ── UI-Dateien: Login-Seite öffentlich, alles andere nur mit gültigem JWT ──
const uiDir    = path.join(__dirname, '../ui')
const docsDir  = path.join(__dirname, '../docs')
const uiStatic = express.static(uiDir)

const PUBLIC_UI_FILES = new Set([
  'login.html',
  'style.css',
  'logincheck.js',
  'login-submit.js',
  'qr2fa.js',
  'isms-builder-banner.png'
])

app.use('/ui', (req, res, next) => {
  const filename = path.basename(req.path)
  if (filename === 'login.html') {
    // ACHTUNG: clearCookie NUR wenn KEINE gültige Session existiert.
    // Ein bedingungsloses clearCookie löscht die Session auch bei eingeloggten
    // Nutzern (z.B. bfcache-Rückkehr, SPA-Navigation) → alle API-Calls 401.
    // Regressionstest: tests/auth.test.js → "Session-Persistenz"
    const sess = getSessionFromReq(req)
    if (!sess) res.clearCookie('sm_session', { path: '/' })
    res.setHeader('Cache-Control', 'no-store')
    return uiStatic(req, res, next)
  }
  // vendor/ and i18n/ assets are public — required by login page before auth
  if (req.path.startsWith('/vendor/')) return uiStatic(req, res, next)
  if (req.path.startsWith('/i18n/'))   return uiStatic(req, res, next)
  // docs/ served from project root (screenshots, badges etc. referenced in seeded README)
  if (req.path.startsWith('/docs/')) {
    const sess = getSessionFromReq(req)
    if (!sess) return res.redirect('/ui/login.html')
    req.url = req.path.slice('/docs'.length)
    return express.static(docsDir)(req, res, next)
  }
  if (PUBLIC_UI_FILES.has(filename)) return uiStatic(req, res, next)
  const sess = getSessionFromReq(req)
  if (!sess) return res.redirect('/ui/login.html')
  uiStatic(req, res, next)
})

const storage = require('./storage')
const rbacStore = require('./rbacStore')
rbacStore.init()

// Fallback: provide a minimal setUserTotpSecret if not present in rbacStore
try {
  if (typeof rbacStore.setUserTotpSecret !== 'function') {
    const DB_FILE = path.join(__dirname, '../data', 'rbac_users.json')
    rbacStore.setUserTotpSecret = function(username, secret){
      let data = {}
      try { data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) } catch {}
      data[username] = data[username] || { username }
      data[username].totpSecret = secret
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
      return { username, totpSecret: secret }
    }
  }
} catch (e) {
  // ignore in environments where file IO is restricted
}

// Initialize storage backend
const storageReady = Promise.resolve(storage.init?.()).catch(e => {
  console.error('[storage] init failed:', e.message)
})

// ── Root route ──
// Leitet zur Login-Seite weiter — die eigentliche App liegt unter /ui/.
// Vorher: res.send('ISMS Templates API') → verwirrte Nutzer die localhost:3000 aufriefen.
// Fix für GitHub Issue #11 (dukefleed66, 2026-03-16).
app.get('/', (req, res) => {
  res.redirect('/ui/login.html')
})

// Ensure Knex-backed storage has finished creating/migrating tables before any
// API route can execute module-specific store queries during startup.
app.use(async (req, res, next) => {
  await storageReady
  next()
})

// ── Health Check (kein Auth erforderlich) ──
// Prüft: Express läuft, SQLite erreichbar, JSON-Datei lesbar
// Für Monitoring / Demo-Server-Cron aktivieren
/*
app.get('/health', (req, res) => {
  const result = { status: 'ok', sqlite: false, json: false, ts: new Date().toISOString() }
  try {
    const db = require('./db/database').getDb()
    db.prepare('SELECT 1').get()
    result.sqlite = true
  } catch {}
  try {
    const orgFile = path.join(__dirname, '../data/org-settings.json')
    fs.readFileSync(orgFile)
    result.json = true
  } catch {}
  if (!result.sqlite || !result.json) result.status = 'degraded'
  res.status(result.status === 'ok' ? 200 : 503).json(result)
})
*/

// ── Mount routers ──
app.use(require('./routes/auth'))
app.use(require('./routes/templates'))
app.use(require('./routes/soa'))
app.use(require('./routes/risks'))
app.use(require('./routes/goals'))
app.use(require('./routes/assets'))
app.use(require('./routes/governance'))
app.use(require('./routes/bcm'))
app.use(require('./routes/calendar'))
app.use(require('./routes/guidance'))
app.use(require('./routes/gdpr'))
app.use(require('./routes/reports'))
app.use(require('./routes/legal'))
app.use(require('./routes/training'))
app.use(require('./routes/admin'))
app.use(require('./routes/public'))
app.use(require('./routes/trash'))
app.use(require('./routes/suppliers'))
app.use(require('./routes/findings'))
app.use(require('./routes/scanImport'))
app.use(require('./routes/ai'))
app.use(require('./routes/orgUnits'))
app.use(require('./routes/acknowledgements'))
app.use(require('./routes/ackPublic'))
app.use(require('./routes/nis2'))
app.use(require('./routes/assessments'))
app.use(require('./routes/assessmentPublic'))

// Test-user management routes (temporary, test-env only)
try {
  const testUsers = require('./testUsers')
  app.get('/test/users', requireAuth, authorize('admin'), testUsers.listUsers)
  app.post('/test/users', requireAuth, authorize('admin'), testUsers.createUser)
  app.put('/test/users/:username', requireAuth, authorize('admin'), testUsers.updateUser)
  app.delete('/test/users/:username', requireAuth, authorize('admin'), testUsers.deleteUser)
} catch (e) {
  // ignore if testUsers module not available in some builds
}

// ── Autopurge: Einträge nach 30 Tagen endgültig löschen ──────────────────────
async function runAutopurge() {
  await storageReady
  const CUTOFF = new Date(Date.now() - 30 * 86400000).toISOString()
  let total = 0

  async function purge(label, getDeleted, permanentDeleteFn) {
    try {
      const items = await getDeleted() || []
      for (const item of items.filter(i => i.deletedAt && i.deletedAt < CUTOFF)) {
        await permanentDeleteFn(item.id)
        total++
      }
    } catch(e) { console.warn(`[autopurge] ${label}: ${e.message}`) }
  }

  // Templates: need type parameter
  try {
    const deletedTmpl = await storage.getDeletedTemplates?.() || []
    for (const t of deletedTmpl.filter(t => t.deletedAt && t.deletedAt < CUTOFF)) {
      try { await storage.permanentDeleteTemplate?.(t.type, t.id); total++ } catch {}
    }
  } catch(e) { console.warn(`[autopurge] Templates: ${e.message}`) }

  const riskStore     = require('./db/riskStore')
  const goalsStore    = require('./db/goalsStore')
  const guidanceStore = require('./db/guidanceStore')
  const trainingStore = require('./db/trainingStore')
  const legalStore    = require('./db/legalStore')
  const gdprStore     = require('./db/gdprStore')
  const pubStore      = require('./db/publicIncidentStore')

  await purge('Risks',              () => riskStore.getDeleted(),                     (id) => riskStore.permanentDelete(id))
  await purge('Goals',              () => goalsStore.getDeleted(),                    (id) => goalsStore.permanentDelete(id))
  await purge('Guidance',           () => guidanceStore.getDeleted(),                 (id) => guidanceStore.permanentDelete(id))
  await purge('Training',           () => trainingStore.getDeleted(),                 (id) => trainingStore.permanentDelete(id))
  await purge('Contracts',          () => legalStore.contracts.getDeleted(),          (id) => legalStore.contracts.permanentDelete(id))
  await purge('NDAs',               () => legalStore.ndas.getDeleted(),               (id) => legalStore.ndas.permanentDelete(id))
  await purge('Policies',           () => legalStore.privacyPolicies.getDeleted(),    (id) => legalStore.privacyPolicies.permanentDelete(id))
  await purge('GDPR VVT',           () => gdprStore.vvt.getDeleted(),                 (id) => gdprStore.vvt.permanentDelete(id))
  await purge('GDPR AV',            () => gdprStore.av.getDeleted(),                  (id) => gdprStore.av.permanentDelete(id))
  await purge('GDPR DSFA',          () => gdprStore.dsfa.getDeleted(),                (id) => gdprStore.dsfa.permanentDelete(id))
  await purge('GDPR Incidents',     () => gdprStore.incidents.getDeleted(),           (id) => gdprStore.incidents.permanentDelete(id))
  await purge('GDPR DSAR',          () => gdprStore.dsar.getDeleted(),                (id) => gdprStore.dsar.permanentDelete(id))
  await purge('GDPR TOMs',          () => gdprStore.toms.getDeleted(),                (id) => gdprStore.toms.permanentDelete(id))
  await purge('Public Incidents',   () => pubStore.getDeleted(),                      (id) => pubStore.permanentDelete(id))

  const supplierStore = require('./db/supplierStore')
  await purge('Suppliers',          () => supplierStore.getDeleted(),                  (id) => supplierStore.permanentDelete(id))

  const findingStore  = require('./db/findingStore')
  await purge('Findings',           () => findingStore.getDeleted(),                   (id) => findingStore.permanentDelete(id))

  if (total > 0) console.log(`[autopurge] ${total} Einträge nach 30 Tagen endgültig gelöscht`)
}

// Autopurge beim Serverstart
runAutopurge().catch(e => console.warn(`[autopurge] ${e.message}`))

// Guidance seed documents (idempotent) after the shared Knex schema is ready.
async function runGuidanceSeeds() {
  await storageReady
  const guidanceStore = require('./db/guidanceStore')
  const seeds = [
    ['Architekturdokumentation', () => guidanceStore.seedArchitectureDocs()],
    ['Demo-Beitrag', () => guidanceStore.seedDemoDoc()],
    ['Rollen-Guides', () => guidanceStore.seedRoleGuides()],
    ['SoA-Guide', () => guidanceStore.seedSoaGuide()],
    ['Policy-Guide', () => guidanceStore.seedPolicyGuide()],
    ['ISO-Hinweis', () => guidanceStore.seedIsoNotice()],
  ]
  for (const [label, seed] of seeds) {
    try {
      await seed()
    } catch (e) {
      console.warn(`[seed] ${label} konnte nicht eingespeist werden: ${e.message}`)
    }
  }
}

runGuidanceSeeds().catch(e => console.warn(`[seed] ${e.message}`))

// ── Export für Tests ──────────────────────────────────────────────────────────
module.exports = app

// ── SSL / HTTPS + Notifier (nur im Produktivbetrieb) ─────────────────────────
if (require.main === module) {
  require('./notifier').start()
  require('./art23Watcher').start()
  const SSL_CERT = process.env.SSL_CERT_FILE
  const SSL_KEY  = process.env.SSL_KEY_FILE

  if (SSL_CERT && SSL_KEY) {
    const https = require('https')
    try {
      const sslOptions = {
        cert: fs.readFileSync(SSL_CERT),
        key:  fs.readFileSync(SSL_KEY),
      }
      https.createServer(sslOptions, app).listen(PORT, () => {
        console.log(`ISMS Builder listening on https://localhost:${PORT}  [SSL]`)
      })
    } catch (e) {
      console.error(`[SSL] Failed to load certificate files: ${e.message}`)
      console.error('[SSL] Falling back to HTTP.')
      app.listen(PORT, () => {
        console.log(`ISMS Builder listening on http://localhost:${PORT}  [HTTP fallback]`)
      })
    }
  } else {
    app.listen(PORT, () => {
      console.log(`ISMS Builder listening on http://localhost:${PORT}`)
    })
  }
}
