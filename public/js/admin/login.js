/* RSVPer admin sign-in (password mode). */
(function () {
  'use strict';

  var form = document.getElementById('loginForm');
  var input = document.getElementById('password');
  var error = document.getElementById('loginError');
  var button = document.getElementById('loginBtn');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.hidden = true;
    if (!input.value) {
      error.hidden = false;
      error.textContent = 'Please enter your password.';
      return;
    }
    button.disabled = true;
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password: input.value }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (res.ok) {
              window.location.href = '/admin';
              return;
            }
            error.hidden = false;
            error.textContent = body.error || 'Sign-in failed.';
            input.select();
          });
      })
      .catch(function () {
        error.hidden = false;
        error.textContent = 'Could not reach the server. Please try again.';
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
