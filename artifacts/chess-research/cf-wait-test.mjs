import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
mkdirSync('/tmp/cf-screens', { recursive: true });
const log = (...a) => console.log('[CF]', ...a);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(90000);

log('Loading page...');
await page.goto('https://www.chessfriends.com', { waitUntil: 'domcontentloaded' });

// Wait for CF to be fully initialized — it fires CF.App.onReady or sets CF.Store
log('Waiting for CF app to fully initialize...');
await page.waitForFunction(() => {
  return !!(window.CF && window.CF.Store && window.CF.App);
}, { timeout: 60000 }).catch(e => log('CF wait timeout:', e.message));

// Now snapshot  
const snap = await page.evaluate(() => {
  const cfKeys = window.CF ? Object.keys(window.CF) : [];
  const cfAppKeys = window.CF?.App ? Object.keys(window.CF.App) : [];
  const actionEls = Array.from(document.querySelectorAll('[action]')).map(el=>({
    action:el.getAttribute('action'),text:(el.textContent||'').trim().slice(0,40),visible:el.offsetParent!==null
  }));
  const inputs = Array.from(document.querySelectorAll('input')).map(el=>({
    type:el.type,name:el.name,cls:el.className.slice(0,60),visible:el.offsetParent!==null
  }));
  return { cfKeys, cfAppKeys, actionEls, inputs, url: window.location.href };
});
log('CF keys:', snap.cfKeys);
log('CF.App keys:', snap.cfAppKeys);
log('Action elements:', JSON.stringify(snap.actionEls));
log('Inputs:', JSON.stringify(snap.inputs));
log('URL:', snap.url);

await page.screenshot({ path: '/tmp/cf-screens/s1-after-cf-ready.png' });

// Try waiting specifically for button[action=login] — the login trigger
log('\nWaiting for button[action=login]...');
try {
  await page.waitForSelector('button[action=login]', { timeout: 30000 });
  log('button[action=login] appeared!');
} catch(e) {
  log('button[action=login] never appeared:', e.message);
  // Check what IS visible
  const vis = await page.evaluate(() => {
    const all = document.querySelectorAll('button,[action],a.x-button');
    return Array.from(all).filter(el=>el.offsetParent!==null).map(el=>({
      tag:el.tagName,action:el.getAttribute('action'),text:(el.textContent||'').trim().slice(0,40),cls:el.className.slice(0,60)
    })).slice(0,30);
  });
  log('Visible interactive elements:', JSON.stringify(vis));
}

await page.screenshot({ path: '/tmp/cf-screens/s2-wait-login.png' });

// Try waiting for the Ext viewport to render
log('\nWaiting for Ext viewport...');
await page.waitForFunction(() => {
  if (!window.Ext?.ComponentQuery) return false;
  const btns = Ext.ComponentQuery.query('button') || [];
  return btns.length > 0;
}, { timeout: 30000 }).catch(e => log('Ext viewport wait:', e.message));

const extBtns = await page.evaluate(() => {
  if (!window.Ext?.ComponentQuery) return [];
  const btns = Ext.ComponentQuery.query('button') || [];
  return btns.map(b => ({
    xtype: b.xtype, action: b.config?.action||b.action||'',
    text: b.getText?.() || b.config?.text || '',
    rendered: b.rendered, hidden: b.hidden, id: b.id
  })).slice(0,40);
});
log('Ext buttons:', JSON.stringify(extBtns));

await page.screenshot({ path: '/tmp/cf-screens/s3-ext-ready.png' });

await browser.close();
log('Done! Check /tmp/cf-screens/');
