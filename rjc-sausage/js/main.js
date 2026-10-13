// R.J.C. Sausage Co. concept: mobile nav, wholesale inquiry form, footer year.
import { sendInquiry, formFields, setBusy } from '../../assets/js/live.js';

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

  // Wholesale form: posted to the admin API (saved to the inbox and emailed). If that fails, or this
  // copy of the site has no API behind it, the same details open in the visitor's email app instead.
  // CONFIRM: the inbox below is the Rome's Joy Companies ordering address from romesjoy.com/contact-us/.
  const INBOX = 'ordering@romesjoy.com';
  const form = document.getElementById('inquiry');
  if (form) {
    const err = document.getElementById('form-error');
    const note = document.getElementById('form-note');
    const setNote = (text) => { note.textContent = text; };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      let firstBad = null;
      form.querySelectorAll('[required]').forEach((el) => {
        const ok = el.checkValidity() && el.value.trim() !== '';
        el.setAttribute('aria-invalid', String(!ok));
        if (!ok && !firstBad) firstBad = el;
      });
      if (firstBad) { err.hidden = false; firstBad.focus(); return; }
      err.hidden = true;
      const d = formFields(form);
      const payload = {
        name: d.name, email: d.email, phone: d.phone, message: d.message,
        Business: d.business, 'Type of business': d.type, 'Interested in': d.products, website: d.website,
      };
      const openMailApp = () => {
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
        window.location.href = `mailto:${INBOX}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        note.replaceChildren('We couldn\'t send that from here, so your email app should open with the details filled in. If it didn\'t, call ');
        const a = document.createElement('a');
        a.href = 'tel:+17733734320'; a.textContent = '773-373-4320';
        note.append(a, '.');
      };
      setBusy(form, true);
      setNote('Sending…');
      sendInquiry('rjc-sausage', 'wholesale', payload).then(() => {
        form.reset();
        setNote('Thanks, we got your inquiry. We\'ll be in touch within one business day with specs, pricing and delivery options.');
        note.setAttribute('tabindex', '-1');
        note.focus();
      }, openMailApp).finally(() => setBusy(form, false));
    });
  }

  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
