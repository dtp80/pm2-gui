'use strict'

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('auth-form')
  var input = document.getElementById('auth-input')
  var errorEl = document.getElementById('auth-error')

  form.addEventListener('submit', function (event) {
    event.preventDefault()
    errorEl.hidden = true

    fetch('/auth_api?authorization=' + encodeURIComponent(input.value), {
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (data.status === 200) {
          window.location.href = '/'
          return
        }
        errorEl.textContent = data.error || 'Authorization failed.'
        errorEl.hidden = false
      })
      .catch(function () {
        errorEl.textContent = 'Unable to reach the server.'
        errorEl.hidden = false
      })
  })
})
