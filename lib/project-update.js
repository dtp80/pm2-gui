'use strict'

var fs = require('fs')
var path = require('path')
var { execFile } = require('child_process')
var AdmZip = require('adm-zip')

var pm = require('./pm')
var projectsStore = require('./projects-store')

var APP_ROOT = path.resolve(__dirname, '..')
var MAX_TOTAL_BYTES = 200 * 1024 * 1024
var INSTALL_TIMEOUT_MS = 10 * 60 * 1000

var EXCLUDED_NAME_RE = /^(node_modules|\.git|\.svn|\.hg|logs?|\.DS_Store|Thumbs\.db|\.next|\.nuxt|\.cache|coverage|\.turbo|\.vercel)$/i

function isExcludedRelPath (relPath) {
  var parts = String(relPath || '').replace(/\\/g, '/').split('/')
  return parts.some(function (part) {
    return !part || EXCLUDED_NAME_RE.test(part)
  })
}

function assertSafeTargetDir (targetDir) {
  var resolved = path.resolve(targetDir)
  if (!path.isAbsolute(resolved)) {
    throw new Error('Project path must be absolute')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Project directory does not exist: ' + resolved)
  }
  if (resolved === APP_ROOT || resolved.indexOf(APP_ROOT + path.sep) === 0) {
    throw new Error('Refusing to update the pm2-gui install directory')
  }
  return resolved
}

function safeJoin (root, relPath) {
  var cleaned = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.indexOf('\0') >= 0) {
    throw new Error('Invalid relative path')
  }
  if (isExcludedRelPath(cleaned)) {
    return null
  }
  var dest = path.resolve(root, cleaned)
  var rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (dest !== root && dest.indexOf(rootWithSep) !== 0) {
    throw new Error('Path escapes project root: ' + relPath)
  }
  return dest
}

function resolveUpdateTarget (options, fn) {
  options = options || {}
  var pm2Home = options.pm2Home

  if (options.projectId) {
    var project = projectsStore.findProject(options.projectId)
    if (!project) {
      return fn(new Error('Saved project not found'))
    }
    try {
      var dir = assertSafeTargetDir(project.path)
      return findRunningByPath(dir, pm2Home, function (err, proc) {
        if (err) return fn(err)
        fn(null, {
          targetDir: dir,
          project: project,
          pmId: proc ? proc.pm_id : null,
          process: proc || null
        })
      })
    } catch (err) {
      return fn(err)
    }
  }

  if (options.pmId == null || options.pmId === '') {
    return fn(new Error('projectId or pmId is required'))
  }

  pm._findById({ id: options.pmId, pm2: pm2Home }, function (err, proc) {
    if (err) return fn(err)
    if (!proc) return fn(new Error('Process not found'))
    var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
    if (!cwd) return fn(new Error('Process has no pm_cwd; cannot update'))
    try {
      var targetDir = assertSafeTargetDir(cwd)
      var matched = projectsStore.listProjects().find(function (p) {
        return path.resolve(p.path) === targetDir
      }) || null
      fn(null, {
        targetDir: targetDir,
        project: matched,
        pmId: proc.pm_id,
        process: proc
      })
    } catch (assertErr) {
      fn(assertErr)
    }
  })
}

function findRunningByPath (targetDir, pm2Home, fn) {
  pm.list({ pm2: pm2Home }, function (err, procs) {
    if (err) return fn(err)
    var proc = (procs || []).find(function (p) {
      var cwd = p.pm2_env && p.pm2_env.pm_cwd
      return cwd && path.resolve(cwd) === targetDir
    }) || null
    fn(null, proc)
  })
}

function stopIfRunning (target, pm2Home, fn) {
  if (!target.process || !target.process.pm2_env) {
    return fn(null, { stopped: false })
  }
  if (target.process.pm2_env.status !== 'online') {
    return fn(null, { stopped: false, status: target.process.pm2_env.status })
  }
  pm.action({
    action: 'stop',
    id: target.pmId,
    pm2: pm2Home
  }, function (err) {
    if (err) return fn(err)
    fn(null, { stopped: true, pmId: target.pmId })
  })
}

function mergeUploadedFiles (targetDir, files, fields) {
  var written = []
  var totalBytes = 0
  var relPaths = fields && fields.paths
    ? [].concat(fields.paths)
    : null

  files.forEach(function (file, index) {
    totalBytes += file.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Upload exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    var rel = (relPaths && relPaths[index]) || file.originalname || file.fieldname
    rel = String(rel || '').replace(/\\/g, '/')
    // Strip a single top-level folder prefix if present (folder picker often includes it)
    if (fields && fields.stripPrefix) {
      var prefix = String(fields.stripPrefix).replace(/\\/g, '/').replace(/\/?$/, '/')
      if (rel.indexOf(prefix) === 0) {
        rel = rel.slice(prefix.length)
      }
    }

    var dest = safeJoin(targetDir, rel)
    if (!dest) return

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file.path, dest)
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function mergeZipArchive (targetDir, zipPath) {
  var zip = new AdmZip(zipPath)
  var entries = zip.getEntries()
  var written = []
  var totalBytes = 0

  entries.forEach(function (entry) {
    if (entry.isDirectory) return
    var rel = entry.entryName.replace(/^\/+/, '')
    // Drop a single common root folder if the zip wraps everything
    var dest = safeJoin(targetDir, rel)
    if (!dest) return

    totalBytes += entry.header.size || 0
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Archive exceeds ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + ' MB limit')
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, entry.getData())
    written.push(rel)
  })

  return { written: written, totalBytes: totalBytes }
}

function detectPackageManager (targetDir) {
  if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) {
    return { bin: 'pnpm', args: ['install', '--prod'] }
  }

  // package.json "packageManager": "pnpm@..."
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.packageManager === 'string' && pkg.packageManager.indexOf('pnpm') === 0) {
      return { bin: 'pnpm', args: ['install', '--prod'] }
    }
  } catch (err) {}

  if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) {
    return { bin: 'yarn', args: ['install', '--production'] }
  }

  return { bin: 'npm', args: ['install', '--omit=dev'] }
}

/**
 * Always run install after upload when package.json is present (create + update).
 * Chooses pnpm / yarn / npm from lockfiles and packageManager field.
 */
function installDepsAfterUpload (targetDir, fn) {
  var pkgPath = path.join(targetDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return fn(null, { skipped: true, reason: 'no package.json' })
  }

  var mgr = detectPackageManager(targetDir)
  execFile(mgr.bin, mgr.args, {
    cwd: targetDir,
    timeout: INSTALL_TIMEOUT_MS,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err) {
      return fn(new Error(
        mgr.bin + ' install failed: ' + (err.message || '') +
        (stderr ? '\n' + String(stderr).slice(-800) : '')
      ))
    }
    fn(null, {
      skipped: false,
      command: mgr.bin + ' ' + mgr.args.join(' '),
      stdoutTail: String(stdout || '').slice(-400)
    })
  })
}

function startAfterUpdate (target, pm2Home, fn) {
  // Prefer restarting the existing PM2 entry when we stopped one.
  if (target.pmId != null) {
    return pm.action({
      action: 'start',
      id: target.pmId,
      pm2: pm2Home
    }, function (err) {
      if (!err) {
        return fn(null, { method: 'pm.start', pmId: target.pmId })
      }
      if (!target.project) {
        return fn(err)
      }
      projectsStore.startProject(target.project, { pm2Home: pm2Home }, function (startErr, proc) {
        if (startErr) return fn(startErr)
        fn(null, { method: 'startProject', process: proc, fallbackFrom: err.message })
      })
    })
  }

  if (target.project) {
    return projectsStore.startProject(target.project, { pm2Home: pm2Home }, function (err, proc) {
      if (err) return fn(err)
      fn(null, { method: 'startProject', process: proc })
    })
  }

  fn(new Error('No saved project or pm id available to start after update'))
}

/**
 * Apply an uploaded update (multipart files and/or a .zip archive).
 * @param {Object} options
 * @param {String} [options.projectId]
 * @param {Number|String} [options.pmId]
 * @param {String} [options.pm2Home]
 * @param {Array} options.files multer file objects
 * @param {Object} options.fields form fields (paths[], stripPrefix, archive handled via files)
 * @param {Function} fn
 */
function applyUpdate (options, fn) {
  options = options || {}
  var files = options.files || []
  var fields = options.fields || {}

  if (!files.length) {
    return fn(new Error('No files uploaded'))
  }

  resolveUpdateTarget(options, function (err, target) {
    if (err) return fn(err)

    var steps = []

    stopIfRunning(target, options.pm2Home, function (stopErr, stopInfo) {
      if (stopErr) return fn(stopErr)
      steps.push({ step: 'stop', result: stopInfo })

      var mergeResult
      try {
        var zipFile = files.find(function (f) {
          return f.fieldname === 'archive' || /\.zip$/i.test(f.originalname || '')
        })
        if (zipFile && (files.length === 1 || zipFile.fieldname === 'archive')) {
          mergeResult = mergeZipArchive(target.targetDir, zipFile.path)
        } else {
          mergeResult = mergeUploadedFiles(target.targetDir, files, fields)
        }
        steps.push({
          step: 'merge',
          filesWritten: mergeResult.written.length,
          bytes: mergeResult.totalBytes
        })
      } catch (mergeErr) {
        return fn(mergeErr)
      }

      installDepsAfterUpload(target.targetDir, function (installErr, installInfo) {
        if (installErr) {
          return fn(installErr)
        }
        steps.push({ step: 'install', result: installInfo })

        startAfterUpdate(target, options.pm2Home, function (startErr, startInfo) {
          if (startErr) {
            return fn(startErr)
          }
          steps.push({ step: 'start', result: startInfo })
          fn(null, {
            ok: true,
            targetDir: target.targetDir,
            projectId: target.project && target.project.id,
            pmId: target.pmId,
            steps: steps
          })
        })
      })
    })
  })
}

function cleanupFiles (files) {
  ;(files || []).forEach(function (file) {
    if (file && file.path) {
      try {
        fs.unlinkSync(file.path)
      } catch (err) {}
    }
  })
}

function sanitizeProjectFolderName (name) {
  var cleaned = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() || ''
  cleaned = cleaned.replace(/^\.+/, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid project folder name')
  }
  if (!/^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]{0,120}$/.test(cleaned)) {
    throw new Error('Project folder name has invalid characters: ' + cleaned)
  }
  return cleaned
}

function assertProjectsRoot (rootPath) {
  var resolved = path.resolve(String(rootPath || '').trim())
  if (!path.isAbsolute(resolved)) {
    throw new Error('Default projects path must be an absolute path')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Default projects path does not exist: ' + resolved)
  }
  if (resolved === APP_ROOT || resolved.indexOf(APP_ROOT + path.sep) === 0) {
    throw new Error('Default projects path cannot be the pm2-gui install directory')
  }
  return resolved
}

/**
 * Create a new project under settings.projects_root from an uploaded laptop folder.
 */
function createFromUpload (options, fn) {
  options = options || {}
  var files = options.files || []
  var fields = options.fields || {}
  var settings = require('./settings').getSettings()
  var steps = []

  if (!files.length) {
    return fn(new Error('No files uploaded'))
  }

  var folderName
  try {
    folderName = sanitizeProjectFolderName(fields.folderName || fields.name)
  } catch (nameErr) {
    return fn(nameErr)
  }

  var root
  try {
    root = assertProjectsRoot(settings.projects_root || '')
  } catch (rootErr) {
    return fn(rootErr)
  }

  var targetDir = path.join(root, folderName)
  if (fs.existsSync(targetDir)) {
    return fn(new Error('Project folder already exists: ' + targetDir))
  }
  if (targetDir === APP_ROOT || targetDir.indexOf(APP_ROOT + path.sep) === 0) {
    return fn(new Error('Refusing to create a project inside the pm2-gui install directory'))
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true })
  } catch (mkdirErr) {
    return fn(new Error('Could not create project directory: ' + mkdirErr.message))
  }

  var mergeResult
  try {
    var zipFile = files.find(function (f) {
      return f.fieldname === 'archive' || /\.zip$/i.test(f.originalname || '')
    })
    if (zipFile && (files.length === 1 || zipFile.fieldname === 'archive')) {
      mergeResult = mergeZipArchive(targetDir, zipFile.path)
    } else {
      mergeResult = mergeUploadedFiles(targetDir, files, fields)
    }
    steps.push({
      step: 'merge',
      filesWritten: mergeResult.written.length,
      bytes: mergeResult.totalBytes,
      targetDir: targetDir
    })
  } catch (mergeErr) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true })
    } catch (rmErr) {}
    return fn(mergeErr)
  }

  var hasPackageJson = fs.existsSync(path.join(targetDir, 'package.json'))
  installDepsAfterUpload(targetDir, function (installErr, installInfo) {
    if (installErr) {
      return fn(installErr)
    }
    steps.push({ step: 'install', result: installInfo, hadPackageJson: hasPackageJson })

    var extras = {}
    if (fields.servicePort) {
      extras.servicePort = parseInt(fields.servicePort, 10) || null
    }
    if (fields.serviceUrl) {
      extras.serviceUrl = String(fields.serviceUrl)
    }

    var project
    try {
      project = projectsStore.addProject(targetDir, extras)
    } catch (addErr) {
      return fn(addErr)
    }
    steps.push({ step: 'register', projectId: project.id, name: project.name })

    var shouldStart = fields.start !== '0' && fields.start !== 'false' && fields.start !== false
    if (!shouldStart) {
      return fn(null, {
        ok: true,
        targetDir: targetDir,
        project: project,
        steps: steps
      })
    }

    projectsStore.startProject(project, { pm2Home: options.pm2Home }, function (startErr, proc) {
      if (startErr) {
        steps.push({ step: 'start', error: startErr.message })
        return fn(null, {
          ok: true,
          warning: 'Project saved but could not start: ' + startErr.message,
          targetDir: targetDir,
          project: project,
          steps: steps
        })
      }
      steps.push({ step: 'start', result: { method: 'startProject' } })
      fn(null, {
        ok: true,
        targetDir: targetDir,
        project: project,
        process: proc,
        steps: steps
      })
    })
  })
}

module.exports = {
  MAX_TOTAL_BYTES: MAX_TOTAL_BYTES,
  EXCLUDED_NAME_RE: EXCLUDED_NAME_RE,
  isExcludedRelPath: isExcludedRelPath,
  resolveUpdateTarget: resolveUpdateTarget,
  applyUpdate: applyUpdate,
  createFromUpload: createFromUpload,
  cleanupFiles: cleanupFiles,
  assertSafeTargetDir: assertSafeTargetDir,
  sanitizeProjectFolderName: sanitizeProjectFolderName
}
