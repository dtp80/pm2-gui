#!/usr/bin/env node
'use strict'

var userData = require('../lib/user-data')

try {
  var dir = userData.ensureUserDataDir()
  console.log('[pm2-gui] User data directory ready:', dir)
} catch (err) {
  console.warn('[pm2-gui] Could not initialize user data directory:', err.message)
  process.exit(0)
}
