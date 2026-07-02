import { test as base, chromium, type Page, type BrowserContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { PDFDocument } from 'pdf-lib';
// @ts-ignore
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

(() => {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
})();

const PROFILE_DIR = path.join(process.cwd(), '.chrome-profile-okte');

const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      chromiumSandbox: true,
    });
    await use(context);
    await context.close().catch(() => {});
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

const DRY_RUN = process.env.DRY_RUN === '1';
const KEEP_OPEN = process.env.KEEP_OPEN !== '0';

const _dnes = new Date();
const DATUM_DNES = `${String(_dnes.getDate()).padStart(2, '0')}.${String(_dnes.getMonth() + 1).padStart(2, '0')}.${_dnes.getFullYear()}`;

const CONFIG = {
  docuseal: {
    loginUrl: 'https://sign.wattiva.eu/sign_in',
    submissionsUrl: 'https://sign.wattiva.eu/submissions',
    email: process.env.DS_EMAIL || '',
    password: process.env.DS_PASSWORD || '',
  },
  okte: {
    publicUrl: 'https://edc.okte.sk/portal/ui/public',
    zmluvaUrl: 'https://edc.okte.sk/portal/ui/zmluva/zalozenie-zmluvy',
    username: process.env.OKTE_USER || '',
    password: process.env.OKTE_PASSWORD || '',
    subjekt: 'Voltia Technologies s.r.o.',
  },
  firemnyKontakt: {
    meno: 'Martin',
    priezvisko: 'Gonda',
    email: 'edc@wattiva.eu',
    telefon: '+421 948 297 937',
  },
  cestneVyhlasenie: {
    maPovolenieUrso: true,
    datumPodpisu: DATUM_DNES,
  },
  krok2: {
    poznamka: '',
    zmluvneVztahy: 'gonda',
    osoba: /gonda/i,
  },
  krok3: {
    nazovSuffix: ' FVE',
    triedaTdve: /fve/i,
    stavZariadenia: /prev[aá]dzke/i,
    meranieNaSvorkach: true,
    lokalnyZdroj: false,
    apAddrSame: true,
    podpora: 'anoBezPodpory',
    investicnaPodpora: { intenzita: '0', pomoc: '0', naklady: '9000' },
    generatorTypTechnologie: 'Slnečná - Fotovoltika',
    generatorTypPaliva: 'OZE - Teplo - Slnečné',
    typPripojenia: 'Rozhranie zariadenia na výrobu elektriny a sústavy',
  },
  maxVykonKw: 11,
};

type TypDokumentu = 'vyhlasenie' | 'splnomocnenie' | 'zmluva';

interface ProfilZakaznika {
  meno: string;
  rawAdresa?: string;
  vykonKw?: string;
  datumZacatia?: string;
  emailZakaznika?: string;
  telefonZakaznika?: string;
  datumNarodenia?: string;
  maSplnomocnenie: boolean;
  maVyhlasenie: boolean;
  maZmluva: boolean;
  subory: { vyhlasenie?: string; splnomocnenie?: string; zmluva?: string };
  parsedMeno?: { titul: string; meno: string; priezvisko: string };
  parsedAdresa?: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string };
  pdf?: {
    eicOdber: string; eicDodavka: string; datumZacatiaVyroby: string;
    kataster: string; parcela: string;
    datumCestne: string; datumSplnomocnenie: string;
    adrVyrobne?: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string };
  };
}

interface ZaznamReportu {
  meno: string;
  stav: 'OK' | 'PRESKOČENÝ' | 'DUPLICITA' | 'CHYBA';
  dovod?: string;
}

const NAZVY_SUBOROV: Record<TypDokumentu, string> = {
  vyhlasenie: 'Čestné vyhlásenie',
  splnomocnenie: 'Splnomocnenie',
  zmluva: 'Zmluva',
};

async function printniPdf(vstup: string, vystup: string): Promise<boolean> {
  try {
    const bytes = fs.readFileSync(vstup);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    try {
      pdf.getForm().flatten();
    } catch {}
    fs.writeFileSync(vystup, await pdf.save());
    return true;
  } catch {
    return false;
  }
}

async function stiahniPdf(page: Page, cesta: string): Promise<boolean> {
  for (let pokus = 1; pokus <= 2; pokus++) {
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
      await page.getByRole('button', { name: 'DOWNLOAD' }).first().click();
      const download = await downloadPromise;
      await download.saveAs(cesta);
      return true;
    } catch {
      if (pokus === 2) return false;
      await page.waitForTimeout(1000);
    }
  }
  return false;
}

function rozdelMeno(cele: string) {
  const casti = cele.trim().split(/\s+/);
  const tituly: string[] = [];
  let i = 0;
  while (i < casti.length && casti[i].includes('.')) tituly.push(casti[i++]);
  return { titul: tituly.join(' '), meno: casti[i] || '', priezvisko: casti.slice(i + 1).join(' ') };
}

function rozdelAdresu(raw?: string) {
  const out = { ulica: '', supisneCislo: '', orientacneCislo: '', psc: '', mesto: '' };
  if (!raw) return out;
  const ignoruj = ['SK', 'SLOVAKIA', 'SLOVENSKO'];
  const casti = raw.split(',').map(c => c.trim()).filter(c => c && !ignoruj.includes(c.toUpperCase()));
  if (casti[0]) {
    const tokeny = casti[0].split(/\s+/);
    const cislo = tokeny.pop() || '';
    out.ulica = tokeny.join(' ');
    const [sup, orient] = cislo.split('/');
    out.supisneCislo = sup || '';
    out.orientacneCislo = orient || '';
  }
  if (casti[1]) {
    const zvysok = casti[1].replace(/\bSK\b/gi, '').trim();
    const psc = zvysok.match(/\d{3}\s?\d{2}/);
    if (psc) {
      out.psc = psc[0];
      out.mesto = zvysok.replace(psc[0], '').trim();
    } else {
      out.mesto = zvysok;
    }
  }
  return out;
}

function bezpecneMeno(meno: string): string {
  return meno.replace(/[\\/:*?"<>|]/g, '').trim();
}

function vykonNaCislo(v?: string): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(',', '.').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function slovoZacinaMalym(w?: string): boolean {
  const p = (w || '').trim()[0] || '';
  return p !== '' && p === p.toLocaleLowerCase('sk') && p !== p.toLocaleUpperCase('sk');
}

function menoZleNaformatovane(clovek: ProfilZakaznika): boolean {
  const slova = [clovek.parsedMeno?.meno, clovek.parsedMeno?.priezvisko].filter(Boolean) as string[];
  if (!slova.length) return false;
  return slova.some(slovoZacinaMalym);
}

function validuj(clovek: ProfilZakaznika): { ok: boolean; dovody: string[] } {
  const d: string[] = [];

  const maTrojicu = clovek.maSplnomocnenie && clovek.maVyhlasenie && clovek.maZmluva;
  if (!maTrojicu) {
    const chyba: string[] = [];
    if (!clovek.maSplnomocnenie) chyba.push('Splnomocnenie');
    if (!clovek.maVyhlasenie) chyba.push('Čestné vyhlásenie');
    if (!clovek.maZmluva) chyba.push('Zmluva');
    d.push(`nekompletná trojica dokumentov (chýba: ${chyba.join(', ')})`);
  } else {
    if (!clovek.subory.vyhlasenie) d.push('nestiahnuté: Čestné vyhlásenie');
    if (!clovek.subory.splnomocnenie) d.push('nestiahnuté: Splnomocnenie');
    if (!clovek.subory.zmluva) d.push('nestiahnuté: Zmluva');
  }

  if (!clovek.parsedMeno?.meno) d.push('chýba meno');
  if (!clovek.parsedMeno?.priezvisko) d.push('chýba priezvisko');
  if (!clovek.datumNarodenia) d.push('chýba dátum narodenia');

  if (menoZleNaformatovane(clovek)) {
    d.push(`nesprávny formát mena (malé písmená/bez diakritiky): "${clovek.meno}"`);
  }

  if (!clovek.parsedAdresa?.ulica) d.push('chýba ulica');
  if (!clovek.parsedAdresa?.supisneCislo) d.push('chýba súpisné číslo');
  if (!clovek.parsedAdresa?.psc) d.push('chýba PSČ');
  if (!clovek.parsedAdresa?.mesto) d.push('chýba mesto');

  if (!clovek.emailZakaznika) d.push('chýba email');
  if (!clovek.telefonZakaznika) d.push('chýba telefón');

  const vykon = vykonNaCislo(clovek.vykonKw);
  if (vykon === null) d.push('chýba/nečitateľný inštalovaný výkon');
  else if (vykon > CONFIG.maxVykonKw) d.push(`výkon ${vykon} kW > ${CONFIG.maxVykonKw} kW`);

  return { ok: d.length === 0, dovody: d };
}

async function zrusProces(page: Page) {
  try {
    if (page.isClosed()) return;
    await zavriDialog(page);

    const zrusZar = page.locator('[hintid="contractFinanceDataVyrobca11kw_grid_kontakty_cancel"]');
    if (await zrusZar.isVisible().catch(() => false)) {
      await zrusZar.click().catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await zavriDialog(page);
    }

    const zrusProc = page.getByRole('button', { name: 'Zrušiť proces' });
    if (await zrusProc.isVisible().catch(() => false)) {
      await zrusProc.click().catch(() => {});
      await page.waitForTimeout(700).catch(() => {});
      const dialog = page.getByRole('dialog');
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole('button', { name: /OK|Áno|Potvrd|Zrušiť/i }).first().click().catch(() => {});
      }
      await page.waitForTimeout(1000).catch(() => {});
    }
  } catch {}
}

async function zavriDialog(page: Page): Promise<boolean> {
  const dialog = page.getByRole('dialog');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  for (const meno of ['OK', 'Zatvoriť', 'Zavrieť', 'Rozumiem', 'Áno', 'Pokračovať']) {
    const b = dialog.getByRole('button', { name: meno });
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(400).catch(() => {}); return true; }
  }
  await dialog.getByRole('button').first().click().catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
  return true;
}

async function precitajDialog(page: Page): Promise<string | null> {
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.isVisible().catch(() => false))) return null;
  const t = (await dialog.innerText().catch(() => '')).trim();
  return t || '(prázdny dialóg)';
}

function jeChybovyText(t: string): boolean {
  return /neexist|nenájd|nenajd|nie je|nespr[áa]vn|chyb|zlyhal|nepodaril|mus[íi]te|povinn|neplatn|invalid|error|nemo[žz]no|u[žz] existuje|duplicit|nevypln|ch[ýy]ba/i.test(t);
}

function jeDuplicita(msg: string): boolean {
  return /u[žz] je zaraden|neplatn[ée] pre akt[íi]vneho odberate[ľl]a|u[žz] existuje|duplicit|u[žz] je registrov/i.test(msg || '');
}

async function checkOkteChyba(page: Page, kde: string): Promise<void> {
  const text = await precitajDialog(page);
  if (text && jeChybovyText(text)) {
    await zavriDialog(page);
    const cisty = text.replace(/\b(close|OK|Zatvoriť|Zavrieť|Áno|Nie|×|✕|✖)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`OKTE odmietlo (${kde}): ${cisty.slice(0, 220)}`);
  }
}

function zapisReport(report: ZaznamReportu[], outDir: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pocet = (s: ZaznamReportu['stav']) => report.filter(r => r.stav === s).length;

  console.log('\n================ REPORT ================');
  console.log(`OK:          ${pocet('OK')}`);
  console.log(`Preskočení:  ${pocet('PRESKOČENÝ')}`);
  console.log(`Duplicity:   ${pocet('DUPLICITA')}`);
  console.log(`Chyby:       ${pocet('CHYBA')}`);
  console.table(report);

  fs.writeFileSync(path.join(outDir, `report-${stamp}.json`), JSON.stringify(report, null, 2));
  const txt = report.map(r => `[${r.stav}] ${r.meno}${r.dovod ? ' – ' + r.dovod : ''}`).join('\n');
  fs.writeFileSync(path.join(outDir, `report-${stamp}.txt`), txt);
}

async function vyplnHintid(page: Page, hintid: string, hodnota: string, index = 0): Promise<boolean> {
  const loc = page.locator(`[hintid="${hintid}"]`).nth(index);
  try {
    await loc.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return false;
  }
  if (!(await loc.isEditable().catch(() => false))) {
    return false;
  }
  await loc.fill('');
  await loc.fill(hodnota);
  return true;
}

async function zistiKrok(page: Page): Promise<number> {
  if (await page.locator('[hintid="participantCreateSimple_meno"]').isVisible().catch(() => false)) return 1;
  return 0;
}

async function nechajOtvorene(page: Page) {
  if (!KEEP_OPEN || page.isClosed()) return;
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

async function vyberNgSelect(page: Page, hintid: string, text: RegExp): Promise<boolean> {
  const sel = page.locator(`[hintid="${hintid}"]`);
  try {
    await sel.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return false;
  }
  await sel.click();
  await page.waitForTimeout(600);
  const options = page.locator('.ng-option, [role="option"]');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await options.first().waitFor({ state: 'visible', timeout: 4000 });
      const texts = await options.allInnerTexts();
      let bestIdx = -1, bestLen = Infinity;
      texts.forEach((t, i) => {
        const tt = t.trim();
        if (text.test(tt) && tt.length < bestLen) { bestLen = tt.length; bestIdx = i; }
      });
      if (bestIdx >= 0) {
        await options.nth(bestIdx).click();
        await page.waitForTimeout(300);
        return true;
      }
      await page.waitForTimeout(500);
    } catch {
      await page.waitForTimeout(500);
    }
  }
  return false;
}

async function zaskrtni(page: Page, hintid: string, chciZaskrtnute = true): Promise<boolean> {
  const cb = page.locator(`[hintid="${hintid}"]`);
  if (!(await cb.isVisible().catch(() => false))) return false;
  const je = await cb.isChecked().catch(() => false);
  if (je !== chciZaskrtnute) await cb.click({ force: true }).catch(() => {});
  return true;
}

async function citajPdfText(cesta: string | undefined, outDir: string, tag: string): Promise<string> {
  if (!cesta || !fs.existsSync(cesta)) return '';
  try {
    const res = await pdfParse(fs.readFileSync(cesta));
    const text: string = (res && res.text) || '';
    fs.writeFileSync(path.join(outDir, `pdftext-${tag}.txt`), text, 'utf-8');
    return text;
  } catch {
    return '';
  }
}

function jeDatum(s: string): boolean {
  return /^\d{1,2}\.\d{1,2}\.\d{4}$/.test((s || '').trim());
}

async function extrahujPdf(clovek: ProfilZakaznika, outDir: string): Promise<void> {
  const tag = bezpecneMeno(clovek.meno);
  const cv = await citajPdfText(clovek.subory.vyhlasenie, outDir, `cestne-${tag}`);
  const spl = await citajPdfText(clovek.subory.splnomocnenie, outDir, `splnom-${tag}`);

  const eics = cv.match(/24Z[0-9A-Z]{10,18}/gi) || [];
  const eicOdber = eics[0] || '';
  const eicDodavka = eics[1] || '';

  let datumZacatiaVyroby = '', kataster = '', parcela = '', adrRaw = '', datumCestne = '';
  if (eicDodavka) {
    const poEic = cv.slice(cv.lastIndexOf(eicDodavka) + eicDodavka.length);
    const r = poEic.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    datumZacatiaVyroby = (r[0] || '').replace(/\s/g, '');
    adrRaw = r[2] || '';
    kataster = r[3] || '';
    parcela = r[4] || '';
    datumCestne = (r[6] || '').replace(/\s/g, '');
  }

  const datumyCv = cv.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || [];
  if (!jeDatum(datumZacatiaVyroby) && datumyCv[0]) datumZacatiaVyroby = datumyCv[0];
  if (!jeDatum(datumCestne) && datumyCv.length) datumCestne = datumyCv[datumyCv.length - 1];

  const normD = (s: string) => (s || '').replace(/\s/g, '').split('.').map(x => String(parseInt(x, 10) || x)).join('.');
  const dnNarod = normD(clovek.datumNarodenia || '');
  const datumySpl = (spl.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || []).filter(d => !dnNarod || normD(d) !== dnNarod);
  const datumSplnomocnenie = datumySpl.length ? datumySpl[datumySpl.length - 1] : '';

  let adrVyrobne: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string } | undefined;
  if (adrRaw && /\d/.test(adrRaw)) {
    const a = rozdelAdresu(adrRaw);
    const p5 = a.psc.replace(/\s/g, '');
    adrVyrobne = { ulica: a.ulica, supisneCislo: a.supisneCislo, orientacneCislo: a.orientacneCislo, psc: p5.length === 5 ? p5.slice(0, 3) + ' ' + p5.slice(3) : a.psc, mesto: a.mesto };
  }

  clovek.pdf = { eicOdber, eicDodavka, datumZacatiaVyroby, kataster, parcela, datumCestne, datumSplnomocnenie, adrVyrobne };
}

async function klikniPrvyDatum(page: Page, hintid: string, outDir: string): Promise<boolean> {
  await page.locator(`[hintid="${hintid}"]`).click().catch(() => {});
  await page.waitForTimeout(700);

  const povolenyDen = page.locator('span[bsdatepickerdaydecorator]:not(.disabled):not(.week)');
  const nextBtn = page.locator('.bs-datepicker button.next, bs-datepicker-navigation-view button.next').first();
  const jeBs = (await page.locator('.bs-datepicker, bs-datepicker-container').count()) > 0;
  if (jeBs) {
    for (let m = 0; m < 18; m++) {
      if ((await povolenyDen.count()) > 0) {
        await povolenyDen.first().click().catch(() => {});
        await page.waitForTimeout(300);
        return true;
      }
      if (!(await nextBtn.isEnabled().catch(() => false))) break;
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }

  const kandidati = [
    '.p-datepicker-calendar td > span:not(.p-disabled):not(.p-ng-other-month)',
    '.mat-calendar-body-cell:not(.mat-calendar-body-disabled)',
    'td.day:not(.disabled):not(.old):not(.new)',
    '.flatpickr-day:not(.flatpickr-disabled):not(.prevMonthDay):not(.nextMonthDay)',
  ];
  for (const sel of kandidati) {
    const dni = page.locator(sel);
    if ((await dni.count()) > 0) {
      await dni.first().click().catch(() => {});
      return true;
    }
  }
  const html = await page.evaluate(() => {
    const panel = document.querySelector('.bs-datepicker, .p-datepicker, ngb-datepicker, .mat-calendar, .datepicker, .flatpickr-calendar, [class*="datepicker"], [class*="calendar"]');
    return panel ? (panel as HTMLElement).outerHTML.slice(0, 5000) : '';
  });
  const f = path.join(outDir, `kalendar-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  fs.writeFileSync(f, html, 'utf-8');
  return false;
}

test('Hromadná E2E automatizácia: DocuSeal -> UAT EDC OKTE', async ({ page }) => {
  test.setTimeout(0); 

  page.on('dialog', d => d.accept().catch(() => {}));

  const chybajuce = [
    !CONFIG.okte.username && 'OKTE_USER',
    !CONFIG.okte.password && 'OKTE_PASSWORD',
    !CONFIG.docuseal.email && 'DS_EMAIL',
    !CONFIG.docuseal.password && 'DS_PASSWORD',
  ].filter(Boolean);
  if (chybajuce.length) {
    throw new Error(`Chýbajú prihlasovacie údaje (${chybajuce.join(', ')}).`);
  }

  const downloadsDir = path.join(process.cwd(), 'downloads');
  const printDir = path.join(downloadsDir, 'print');
  const outDir = path.join(process.cwd(), 'reports');
  for (const dir of [downloadsDir, printDir, outDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const databaza = new Map<string, ProfilZakaznika>();
  const report: ZaznamReportu[] = [];

  await page.goto(CONFIG.docuseal.submissionsUrl);
  await page.waitForLoadState('networkidle').catch(() => {});

  const loginViditelny = await page.getByRole('textbox', { name: 'Email' })
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (loginViditelny || /sign_in/.test(page.url())) {
    if (!/sign_in/.test(page.url())) await page.goto(CONFIG.docuseal.loginUrl);
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.docuseal.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.docuseal.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(u => !u.href.includes('sign_in'), { timeout: 15000 }).catch(() => {});
    await page.goto(CONFIG.docuseal.submissionsUrl);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  const completedLink = page.getByRole('link', { name: 'Completed', exact: true });
  const maCompleted = await completedLink
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (maCompleted) {
    await completedLink.click();
    await page.waitForTimeout(2000);
  }

  const rozsahZoznamu = async (): Promise<string> => await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/\b\d+\s*[-–]\s*\d+\s*(?:of|z)\s*\d+\b/i);
    return m ? m[0] : '';
  }).catch(() => '');

  const vsetkyUrl: string[] = [];
  for (let strana = 1; strana <= 200; strana++) { 
    await page.keyboard.press('End').catch(() => {}); 
    await page.waitForTimeout(500).catch(() => {});
    const predPocet = vsetkyUrl.length;
    for (const a of await page.getByRole('link', { name: 'VIEW' }).all()) {
      const href = await a.getAttribute('href').catch(() => null);
      if (href) {
        const abs = new URL(href, page.url()).href;
        if (!vsetkyUrl.includes(abs)) vsetkyUrl.push(abs);
      }
    }
    const pribudlo = vsetkyUrl.length - predPocet;
    const rng = await rozsahZoznamu();

    const m = rng.match(/(\d+)\s*[-–]\s*(\d+)\s*(?:of|z)\s*(\d+)/i);
    if (m && +m[2] >= +m[3]) break;
    if (pribudlo === 0 && strana > 1) break;

    const next = page.getByRole('link', { name: '»' }).or(page.getByRole('button', { name: '»' })).first();
    if (!(await next.isVisible().catch(() => false))) break; 
    const predRng = rng;
    await next.click().catch(() => {});
    await page.waitForTimeout(1800).catch(() => {});
    if (predRng && (await rozsahZoznamu()) === predRng) break;
  }

  const dokyNaStiahnutie: { url: string; meno: string; typ: TypDokumentu }[] = [];

  for (const url of vsetkyUrl) {
    await page.goto(url);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);

    const text = await page.innerText('body');
    const riadky = text.split('\n').map(r => r.trim());
    const hodnota = (label: string): string => {
      const idx = riadky.findIndex(r => r.toLowerCase() === label.toLowerCase());
      return idx !== -1 && idx + 1 < riadky.length ? riadky[idx + 1] : '';
    };

    const meno = hodnota('FULLNAMEORCOMPANYNAME');
    if (!meno) { continue; }

    let typ: TypDokumentu = 'zmluva';
    if (text.includes('Čestné vyhlásenie')) typ = 'vyhlasenie';
    else if (text.includes('Splnomocnenie')) typ = 'splnomocnenie';

    if (!databaza.has(meno)) {
      databaza.set(meno, { meno, maSplnomocnenie: false, maVyhlasenie: false, maZmluva: false, subory: {} });
    }
    const clovek = databaza.get(meno)!;

    if (typ === 'splnomocnenie') clovek.maSplnomocnenie = true;
    if (typ === 'vyhlasenie') clovek.maVyhlasenie = true;
    if (typ === 'zmluva') clovek.maZmluva = true;

    const adresa = hodnota('RESIDENTIALADDRESS') || hodnota('LOCATIONADDRESS');
    if (adresa) clovek.rawAdresa = adresa;
    const vykonKw = hodnota('TOTALINSTALLEDPOWERKW');
    if (vykonKw) clovek.vykonKw = vykonKw;
    const datumZacatia = hodnota('PRODUCTIONSTARTDATE');
    if (datumZacatia) clovek.datumZacatia = datumZacatia;

    if (!clovek.emailZakaznika) {
      const emaily = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      for (const em of emaily) {
        if (!em.includes('wattiva') && !em.includes('okte')) { clovek.emailZakaznika = em; break; }
      }
    }
    if (!clovek.telefonZakaznika) {
      const tel = text.match(/(?:\+421|0)\s?9\d{2}\s?\d{3}\s?\d{3}/);
      if (tel) clovek.telefonZakaznika = tel[0];
    }
    if (!clovek.datumNarodenia) {
      const datumy = text.match(/\b\d{2}\.\d{2}\.\d{4}\b/g) || [];
      for (const dd of datumy) {
        if (!dd.includes('2026') && dd !== clovek.datumZacatia) { clovek.datumNarodenia = dd; break; }
      }
    }

    dokyNaStiahnutie.push({ url, meno, typ });
  }

  const kompletni = new Set<string>();
  for (const [m, c] of databaza) {
    if (c.maSplnomocnenie && c.maVyhlasenie && c.maZmluva) kompletni.add(m);
  }

  const naStiahnutie = dokyNaStiahnutie.filter(d => kompletni.has(d.meno));

  for (const d of naStiahnutie) {
    await page.goto(d.url);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);

    const clovek = databaza.get(d.meno)!;
    const safe = bezpecneMeno(d.meno);
    const nazov = `${safe} - ${NAZVY_SUBOROV[d.typ]}`;
    const raw = path.join(downloadsDir, `${nazov}.pdf`);
    const printed = path.join(printDir, `${nazov}.pdf`);
    if (await stiahniPdf(page, raw)) {
      const ok = await printniPdf(raw, printed);
      clovek.subory[d.typ] = ok ? printed : raw;
    }
  }

  const naZapis: ProfilZakaznika[] = [];
  for (const clovek of databaza.values()) {
    clovek.parsedMeno = rozdelMeno(clovek.meno);
    clovek.parsedAdresa = rozdelAdresu(clovek.rawAdresa);
    const { ok, dovody } = validuj(clovek);
    if (ok) {
      naZapis.push(clovek);
    } else {
      report.push({ meno: clovek.meno, stav: 'PRESKOČENÝ', dovod: dovody.join('; ') });
    }
  }

  if (naZapis.length === 0) {
    zapisReport(report, outDir);
    return;
  }

  const jePrihlaseny = (u: URL) => !u.href.includes('/public') && !u.href.includes('/auth/');

  await page.goto(CONFIG.okte.zmluvaUrl).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  if (!jePrihlaseny(new URL(page.url()))) {
    try {
      const prihlasitBtn = page.getByRole('button', { name: 'Prihlásiť sa' });
      if (await prihlasitBtn.isVisible().catch(() => false)) {
        await prihlasitBtn.click({ timeout: 8000 });
      }
      await page.getByLabel('Prihlasovacie meno').fill(CONFIG.okte.username, { timeout: 8000 });
      await page.getByLabel('Heslo', { exact: true }).fill(CONFIG.okte.password, { timeout: 8000 });
      await page.getByRole('button', { name: 'Prihlásenie' }).click({ timeout: 8000 });
    } catch {}
    await page.waitForURL(jePrihlaseny, { timeout: 300000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  page.setDefaultTimeout(20000);

  const subjektDropdown = page.locator('.ng-select.ng-invalid').first();
  const maSubjekt = await subjektDropdown
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (maSubjekt) {
    await subjektDropdown.click();
    await page.getByRole('option', { name: CONFIG.okte.subjekt }).click();
    const okBtn = page.getByRole('button', { name: 'OK', exact: true });
    if (await okBtn.isVisible().catch(() => false)) await okBtn.click();
  }

  for (const clovek of naZapis) {
    if (page.isClosed()) break;
    
    await extrahujPdf(clovek, outDir); 
    const { meno, priezvisko } = clovek.parsedMeno!;
    const { ulica, supisneCislo, orientacneCislo, psc, mesto } = clovek.parsedAdresa!;

    try {
      await page.goto(CONFIG.okte.zmluvaUrl);
      await page.getByRole('button', { name: 'Nový účastník' }).nth(1).click();
      await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
      await page.getByText('Fyzická osoba', { exact: true }).first().click();

      await page.waitForTimeout(1200);
      const krok = await zistiKrok(page);
      if (krok !== 1) throw new Error(`Wizard nie je na kroku 1 (zistené: ${krok || 'neznámy'})`);

      await page.locator('input[name="typUcastnika"][value="FO"]').check({ force: true }).catch(() => {});

      await vyplnHintid(page, 'participantCreateSimple_meno', meno);
      await vyplnHintid(page, 'participantCreateSimple_priezvisko', priezvisko);
      await vyplnHintid(page, 'participantCreateSimple_datumNarodenia', clovek.datumNarodenia!);

      await vyplnHintid(page, 'participantCreateSimple_sidloUlica', ulica);
      await vyplnHintid(page, 'participantCreateSimple_sidloPopisneCislo', supisneCislo);
      if (orientacneCislo) await vyplnHintid(page, 'participantCreateSimple_sidloOrientacneCislo', orientacneCislo);
      await vyplnHintid(page, 'participantCreateSimple_sidloPsc', psc);
      await vyplnHintid(page, 'participantCreateSimple_sidloMesto', mesto);

      await vyplnHintid(page, 'participantCreateSimple_kontakt_meno', CONFIG.firemnyKontakt.meno, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_priezvisko', CONFIG.firemnyKontakt.priezvisko, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_email', CONFIG.firemnyKontakt.email, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_telefon', CONFIG.firemnyKontakt.telefon, 0);

      const pocetKontaktov = await page.locator('[hintid="participantCreateSimple_kontakt_meno"]').count();
      if (pocetKontaktov < 2) {
        await page.getByRole('button', { name: 'Pridať kontakt' }).click();
        await page.waitForTimeout(600);
      }
      
      const ok2 = await vyplnHintid(page, 'participantCreateSimple_kontakt_meno', meno, 1);
      if (!ok2) throw new Error('2. kontakt sa nenašiel');
      await vyplnHintid(page, 'participantCreateSimple_kontakt_priezvisko', priezvisko, 1);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_email', clovek.emailZakaznika!, 1);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_telefon', clovek.telefonZakaznika!, 1);

      const ursoValue = CONFIG.cestneVyhlasenie.maPovolenieUrso ? 'YES' : 'NO';
      const ursoRadio = page.locator(`input[name="hasUrso"][value="${ursoValue}"]`);
      await ursoRadio.check({ force: true }).catch(async () => {
        await ursoRadio.click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(1200);

      if (CONFIG.cestneVyhlasenie.maPovolenieUrso) {
        const dokumenty: { nazov: string; typ: RegExp; subor?: string; datum: string }[] = [
          { nazov: 'Splnomocnenie', typ: /splnomoc/i, subor: clovek.subory.splnomocnenie, datum: clovek.pdf?.datumSplnomocnenie || CONFIG.cestneVyhlasenie.datumPodpisu },
          { nazov: 'Čestné vyhlásenie', typ: /(čestné|cestne|vyhlás|vyhlas)/i, subor: clovek.subory.vyhlasenie, datum: clovek.pdf?.datumCestne || CONFIG.cestneVyhlasenie.datumPodpisu },
        ];
        for (const dok of dokumenty) {
          if (!dok.subor) continue;
          
          await page.locator('[hintid="povoleniaPodnikania_grid_add"]').click();
          await page.waitForTimeout(800);
          
          const vybrane = await vyberNgSelect(page, 'povoleniaPodnikania_documentType', dok.typ);
          if (!vybrane) throw new Error(`Typ dokumentu nepodarilo vybrať`);
          await page.waitForTimeout(700);
          
          await page.locator('input[type="file"]').first().setInputFiles(dok.subor);
          await page.waitForTimeout(1200);
          
          await vyplnHintid(page, 'povoleniaPodnikania_platnostOdPovUrso', dok.datum);
          
          await page.locator('[hintid="povoleniaPodnikania_grid_submit"]').click();
          await page.waitForTimeout(1500);
        }
      } else {
        await page.locator('input[type="file"]').first().setInputFiles(clovek.subory.vyhlasenie!);
        await page.waitForTimeout(800);
        await vyplnHintid(page, 'participantCreateSimple_datumPodpisuCestnehoVyhlasenia', CONFIG.cestneVyhlasenie.datumPodpisu);
      }

      if (DRY_RUN) {
        report.push({ meno: clovek.meno, stav: 'OK', dovod: 'DRY-RUN (krok 1)' });
        continue;
      }

      await page.getByRole('button', { name: 'Uložiť a ďalej' }).click();
      await page.locator('[hintid="participantCreateSimple_meno"]')
        .waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});

      const stalePrvy = await zistiKrok(page); 
      if (stalePrvy === 1) {
        const errs: string[] = await page.evaluate(() => {
          const out: string[] = [];
          document.querySelectorAll('.invalid-feedback, .text-danger, mat-error, .field-error, .error-message').forEach((e) => {
            const t = (e as HTMLElement).innerText?.trim();
            if (t && t.length < 160) out.push(t);
          });
          return Array.from(new Set(out));
        });
        report.push({ meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 1 validácia neprešla: ' + (errs.join('; ') || 'neznáme') });
        break;
      }

      const nazovOk = await vyplnHintid(page, 'zmluvaFormZpu_nazovUt', clovek.meno);
      const datumOk = await klikniPrvyDatum(page, 'zmluvaFormZpu_pozadovanyDatumZacatia', outDir);
      if (CONFIG.krok2.poznamka) await vyplnHintid(page, 'zmluvaFormZpu_poznamka', CONFIG.krok2.poznamka);
      const g1 = await vyberNgSelect(page, 'zmluvaFormZpu_osobaPoverenaNaKomunikaciu', CONFIG.krok2.osoba);
      const g2 = await vyberNgSelect(page, 'zmluvaFormZpu_osobaPoverenaNaPodpis', CONFIG.krok2.osoba);
      await vyberNgSelect(page, 'zmluvaFormZpu_zmluvneVztahy', new RegExp(CONFIG.krok2.zmluvneVztahy, 'i'));

      await page.getByRole('button', { name: 'Uložiť a ďalej' }).click();
      await page.locator('[hintid="zmluvaFormZpu_nazovUt"]').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});

      const stalKrok2 = await page.locator('[hintid="zmluvaFormZpu_nazovUt"]').isVisible().catch(() => false);
      if (stalKrok2) {
        report.push({ meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 2 neprešiel' });
      } else {
        await page.waitForFunction(() => {
          const hint = Array.from(document.querySelectorAll('[hintid]')).some(
            (e) => (e as HTMLElement).getClientRects().length > 0 && !/^(participantCreateSimple|zmluvaFormZpu)/.test(e.getAttribute('hintid') || ''),
          );
          const btn = Array.from(document.querySelectorAll('button, span, a')).some(
            (e) => /zariaden|Prid[aá]ť/i.test((e as HTMLElement).innerText || ''),
          );
          return hint || btn;
        }, { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(1200);

        const okPopup = page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).first();
        await okPopup.click({ timeout: 8000 }).catch(() => {}); 
        await page.waitForTimeout(600);
        
        await page.getByText(/Prid[aá]ť.*zariaden/i).first().click().catch(() => {});
        await page.waitForTimeout(1200);
        
        if (await okPopup.isVisible().catch(() => false)) await okPopup.click().catch(() => {});
        await page.waitForTimeout(800);

        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_nazov', clovek.meno + CONFIG.krok3.nazovSuffix);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_generator_nazov', clovek.meno);
        
        if (clovek.vykonKw) {
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_generator_instalVykon', String(clovek.vykonKw).replace('.', ','));
        }
        
        const av = clovek.pdf?.adrVyrobne;
        if (av && av.ulica) {
          await zaskrtni(page, 'contractFinanceDataVyrobca11kw_apAddrSame', false);
          await page.waitForTimeout(700);
          await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_apIdStat', /Slovensk/i).catch(() => {});
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apUlica', av.ulica);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apPopisneCislo', av.supisneCislo);
          if (av.orientacneCislo) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apOrientacneCislo', av.orientacneCislo);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apPsc', av.psc);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apMesto', av.mesto);
        } else {
          await zaskrtni(page, 'contractFinanceDataVyrobca11kw_apAddrSame', CONFIG.krok3.apAddrSame);
        }
        
        await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_triedaTdve', CONFIG.krok3.triedaTdve);
        await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_stavZariadenia', CONFIG.krok3.stavZariadenia);
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoMeranieSvorky', CONFIG.krok3.meranieNaSvorkach);
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoLokalZdroj', CONFIG.krok3.lokalnyZdroj);
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoBezPodpory', true);

        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_intenzitaInvPodpory', CONFIG.krok3.investicnaPodpora.intenzita);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_poskytIvestPomoc', CONFIG.krok3.investicnaPodpora.pomoc);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_vyskaOpravNaklad', CONFIG.krok3.investicnaPodpora.naklady);

        const ddZoznam: [string, string, string][] = [
          ['contractFinanceDataVyrobca11kw_generator_typTechnologie', CONFIG.krok3.generatorTypTechnologie, 'typ technológie'],
          ['contractFinanceDataVyrobca11kw_generator_typPaliva', CONFIG.krok3.generatorTypPaliva, 'typ paliva'],
          ['contractFinanceDataVyrobca11kw_oom_typPripojenia', CONFIG.krok3.typPripojenia, 'typ pripojenia'],
        ];
        for (const [hid, val, nazov] of ddZoznam) {
          const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          const ok = await vyberNgSelect(page, hid, re);
        }

        if (clovek.pdf) {
          const p = clovek.pdf;
          if (p.kataster) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apKatastUzemie', p.kataster);
          if (p.parcela) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apCisloParcely', p.parcela);
          if (p.eicOdber) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_oom_ooEic', p.eicOdber);
          if (p.eicDodavka) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_oom_odEic', p.eicDodavka);
          if (p.datumZacatiaVyroby) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_datOd', p.datumZacatiaVyroby);
        }

        await page.waitForTimeout(600).catch(() => {});
        await checkOkteChyba(page, 'EIC/údaje zariadenia');

        const ulozeneZar = await page.locator('[hintid="contractFinanceDataVyrobca11kw_grid_kontakty_submit"]').click().then(() => true).catch(() => false);
        if (!ulozeneZar) await page.getByRole('button', { name: /Uložiť zariadenie/i }).click().catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
        await checkOkteChyba(page, 'uloženie zariadenia'); 

        if (!page.isClosed()) {
          await page.getByRole('button', { name: 'Uložiť a ďalej' }).click().catch(() => {});
          await page.waitForTimeout(2500).catch(() => {});
          await checkOkteChyba(page, 'prechod na krok 4');
        }

        let krok4Odoslany = false;
        if (!page.isClosed()) {
          const ulozitKrok4 = page.getByRole('button', { name: 'Uložiť a odoslať do OKTE' });
          await ulozitKrok4.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
          for (let pokus = 0; pokus < 3 && !krok4Odoslany; pokus++) {
            if (await okPopup.isVisible().catch(() => false)) { await okPopup.click().catch(() => {}); await page.waitForTimeout(400); }
            krok4Odoslany = await ulozitKrok4.click({ timeout: 7000 }).then(() => true).catch(() => false);
            if (!krok4Odoslany) await page.waitForTimeout(1000);
          }
          await page.waitForTimeout(3000).catch(() => {});
          await checkOkteChyba(page, 'odoslanie kroku 4');
        }

        report.push(page.isClosed()
          ? { meno: clovek.meno, stav: 'CHYBA', dovod: 'stránka sa zatvorila počas dokončovania' }
          : krok4Odoslany
            ? { meno: clovek.meno, stav: 'OK', dovod: 'kompletný zápis 1–4' }
            : { meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 4 – tlačidlo "Uložiť a odoslať do OKTE" sa nestlačilo' });
      }
    } catch (e: any) {
      const duplicita = jeDuplicita(e.message);
      report.push({ meno: clovek.meno, stav: duplicita ? 'DUPLICITA' : 'CHYBA', dovod: e.message });
      if (page.isClosed() || /has been closed/i.test(e.message)) {
        break;
      }
      await zrusProces(page);
    }
  }

  zapisReport(report, outDir);
  await nechajOtvorene(page);

  const chyby = report.filter(r => r.stav === 'CHYBA');
  if (chyby.length > 0) {
    throw new Error(`${chyby.length} zápis(ov) zlyhalo`);
  }
});