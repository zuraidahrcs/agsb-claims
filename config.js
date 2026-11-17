// AGSB Claims app settings.
// One entry per company. Each company has its own claims Google Sheet and its own web app link (ends in /exec).
// If a company gets a new web app link (a NEW deployment), replace its api: link below.
window.AGSB_COMPANIES = [
  { id: 'agsb', name: 'Amboi Group', full: 'AMBOI GROUP SDN BHD',
    api: 'https://script.google.com/macros/s/AKfycbx_7UYJbBIX6UuLgzHiULEBcAs3vXTUgdQLf-w8nRnMyl9ZCy3VW-4l_XWC32N0TF0U/exec' },
  { id: 'rcs', name: 'RedCube Solutions', full: 'REDCUBE SOLUTIONS PLT',
    api: 'https://script.google.com/macros/s/AKfycbx1JoEn7vQLiQpPA0jna8HYxOjm18GgmyJGYY_dJQAGfzyzfO1iFLKWYhYwze47UzAo/exec' }
];
