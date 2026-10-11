// R.J.C. Sausage Co. concept: mobile nav, wholesale inquiry composer, footer year.
(() => {
  const toggle = document.querySelector('.nav__toggle');
  const list = document.getElementById('nav-list');
  if (toggle && list) {
    const close = () => { toggle.setAttribute('aria-expanded', 'false'); list.classList.remove('is-open'); };
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      list.classList.toggle('is-open', open);
    });
    list.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && list.classList.contains('is-open')) { close(); toggle.focus(); }
    });
    matchMedia('(min-width: 900px)').addEventListener('change', close);
  }

  // Wholesale form: no backend on a static concept, so compose an email.
  // CONFIRM: the inbox below is the Rome's Joy Companies ordering address from romesjoy.com/contact-us/.
  const INBOX = 'ordering@romesjoy.com';
  const form = document.getElementById('inquiry');
  if (form) {
    const err = document.getElementById('form-error');
    const note = document.getElementById('form-note');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      let firstBad = null;
      form.querySelectorAll('[required]').forEach((el) => {
        const ok = el.checkValidity() && el.value.trim() !== '';
        el.setAttribute('aria-invalid', String(!ok));
        if (!ok && !firstBad) firstBad = el;
      });
      if (firstBad) { err.hidden = false; firstBad.focus(); return; }
      err.hidden = true;
      const d = Object.fromEntries(new FormData(form));
      const subject = `Wholesale inquiry: R.J.C. Sausage (${d.business})`;
      const body = [
        `Business: ${d.business}`,
        `Type: ${d.type}`,
        `Contact: ${d.name}`,
        `Email: ${d.email}`,
        d.phone ? `Phone: ${d.phone}` : '',
        `Interested in: ${d.products}`,
        '',
        d.message || '',
      ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
      const href = `mailto:${INBOX}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = href;
      note.innerHTML = '';
      note.append('Your email app should open now. If it didn\'t, call ');
      const a = document.createElement('a');
      a.href = 'tel:+17733734320'; a.textContent = '773-373-4320';
      note.append(a, '.');
    });
  }

  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
