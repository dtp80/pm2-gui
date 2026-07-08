'use strict'

var express = require('express')
var session = require('express-session')
var path = require('path')
var http = require('http')
var router = require('../lib/util/router')

module.exports = function (options) {
  var app = express()
  app.set('view engine', 'pug')
  app.set('views', path.join(__dirname, 'templates/views'))
  app.use(express.static(path.join(__dirname, 'public')))
  app.use(express.json())
  app.use(session({
    secret: process.env.PM2_GUI_SESSION_SECRET || 'pm2@gui',
    resave: false,
    saveUninitialized: true
  }))
  if (options.middleware) {
    app.use(options.middleware)
  }
  router(app)

  var server = http.createServer(app)
  server.listen(options.port)
  return server
}
