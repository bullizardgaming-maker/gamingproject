// Paint the right theme before the app loads: the viewer's choice, else the device setting.
// A separate file (not inline) because the CSP allows only first-party script files.
try {
  var t = localStorage.getItem('bz.theme');
  if (t === 'dark' || ((!t || t === 'system') && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
