import { test as base, chromium, type Page, type BrowserContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
// @ts-ignore
import { parse } from 'csv-parse/sync';

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

const AUTO_SUBMIT = process.env.AUTO_SUBMIT !== '0';
const KEEP_OPEN = process.env.KEEP_OPEN !== '0';

const CONFIG = {
  okte: {
    publicUrl: 'https://edc.okte.sk/portal/ui/public',
    zmluvaUrl: 'https://edc.okte.sk/portal/ui/zmluva/zalozenie-zmluvy',
    mojeZmluvyUrl: 'https://edc.okte.sk/portal/ui/zmluva/vyhladanie',
    username: process.env.OKTE_USER || '',
    password: process.env.OKTE_PASSWORD || '',
    subjekt: 'Voltia Technologies s.r.o.',
    cisloZmluvy: '2026-15-5942',
    nazovZmluvy: /Zmluva o poskytovaní údajov/i,
  },
  agregacia: {
    bilancnaSkupina: '24YB-VOLTIATECHP',
    davky: [
      { csv: 'data.csv', blok: 'SSE blok 1' },
      { csv: 'data_wattiva.csv', blok: 'WATTIVA blok 1' },
    ] as { csv: string; blok: string }[],
    technologiaTyp: /Odberné zariadenie/i,
    technologiaStav: /V prevádzke/i,
    eicStav: /V prevádzke/i,
    eicTypZdroja: /Odberné zariadenie/i,
    eicTypPoskytovatela: /Odberateľ/i,
    eicSmer: /Odber zo sústavy/i,
  },
};

interface ZakaznikFlexibility {
  meno: string;
  eic: string;
}

interface ZaznamReportu {
  blok: string;
  meno: string;
  eic: string;
  stav: 'OK' | 'PRESKOČENÝ' | 'DUPLICITA' | 'CHYBA';
  dovod?: string;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function vyplnHintid(page: Page, hintid: string, hodnota: string, index = 0): Promise<boolean> {
  const loc = page.locator(`[hintid="${hintid}"]`).nth(index);
  try {
    await loc.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return false;
  }
  if (!(await loc.isEditable().catch(() => false))) return false;
  await loc.fill('');
  await loc.fill(hodnota);
  return true;
}

async function vyberNgSelect(page: Page, hintid: string, text: RegExp): Promise<boolean> {
  const sel = page.locator(`[hintid="${hintid}"]`).first();
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
    if ((await dni.count()) > 0) { await dni.first().click().catch(() => {}); return true; }
  }
  await dumpDiagnostiku(page, outDir, `datepicker-${hintid}`);
  return false;
}

async function zaskrtni(page: Page, hintid: string, chciZaskrtnute = true): Promise<boolean> {
  const cb = page.locator(`[hintid="${hintid}"]`);
  if (!(await cb.isVisible().catch(() => false))) return false;
  const je = await cb.isChecked().catch(() => false);
  if (je !== chciZaskrtnute) await cb.click({ force: true }).catch(() => {});
  return true;
}

async function klikniDefensive(
  page: Page,
  opts: { hintids?: string[]; texty?: (string | RegExp)[]; ako?: 'button' | 'text'; popis: string },
): Promise<boolean> {
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (await loc.click({ timeout: 2500 }).then(() => true).catch(() => false)) return true;
  }
  for (const t of opts.texty || []) {
    const kandidati = opts.ako === 'text'
      ? [page.getByText(t as any).first()]
      : [
          page.getByRole('button', { name: t as any }).first(),
          page.getByRole('link', { name: t as any }).first(),
          page.getByText(t as any).first(),
        ];
    for (const loc of kandidati) {
      if (!(await loc.isVisible().catch(() => false))) continue;
      if (await loc.click({ timeout: 2500 }).then(() => true).catch(() => false)) return true;
    }
  }
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (await loc.click({ force: true, timeout: 2500 }).then(() => true).catch(() => false)) return true;
  }
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const ok = await loc.evaluate((el) => { (el as HTMLElement).click(); return true; }).catch(() => false);
    if (ok) return true;
  }
  for (const t of opts.texty || []) {
    const src = typeof t === 'string' ? t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : t.source;
    const ok = await page.evaluate((needle) => {
      const re = new RegExp(needle, 'i');
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      for (const sel of ['a', 'button', '[role="button"]', 'span', 'div']) {
        const el = Array.from(document.querySelectorAll(sel))
          .find((e) => re.test((e as HTMLElement).innerText || '') && vis(e));
        if (el) { (el as HTMLElement).click(); return true; }
      }
      return false;
    }, src).catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function dumpDiagnostiku(page: Page, outDir: string, tag: string): Promise<void> {
  try {
    if (page.isClosed()) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(outDir, `diag-${tag.replace(/[^\w.-]/g, '_')}-${stamp}`);
    await page.screenshot({ path: base + '.png', fullPage: true }).catch(() => {});
    fs.writeFileSync(base + '.html', await page.content().catch(() => ''), 'utf-8');
    const hinty = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[hintid]'))
        .filter((e) => (e as HTMLElement).getClientRects().length > 0)
        .map((e) => e.getAttribute('hintid')),
    ).catch(() => [] as (string | null)[]);
    fs.writeFileSync(base + '-hintids.txt', (hinty || []).join('\n'), 'utf-8');
  } catch {}
}

async function vypisHintidy(page: Page, tag: string): Promise<void> {
  const hs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[hintid]'))
      .filter((e) => (e as HTMLElement).getClientRects().length > 0)
      .map((e) => e.getAttribute('hintid') || ''),
  ).catch(() => [] as string[]);
  const agr = hs.filter((h) => /agregac/i.test(h));
}

async function precitajDialog(page: Page): Promise<string | null> {
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.isVisible().catch(() => false))) return null;
  const t = (await dialog.innerText().catch(() => '')).trim();
  return t || '';
}

async function zavriDialog(page: Page): Promise<boolean> {
  const dialog = page.getByRole('dialog');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  for (const meno of ['OK', 'Zatvoriť', 'Zavrieť', 'Rozumiem', 'Áno', 'Pokračovať']) {
    const b = dialog.getByRole('button', { name: meno });
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(400); return true; }
  }
  await dialog.getByRole('button').first().click().catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

function jeChybovyText(t: string): boolean {
  return /neexist|nenájd|nenajd|nie je|nespr[áa]vn|chyb|zlyhal|nepodaril|mus[íi]te|povinn|neplatn|invalid|error|nemo[žz]no|u[žz] existuje|duplicit|nevypln|ch[ýy]ba/i.test(t);
}

function jeDuplicita(msg: string): boolean {
  return /u[žz] je zaraden|neplatn[ée] pre akt[íi]vneho odberate[ľl]a|u[žz] existuje|duplicit|u[žz] je registrov|u[žz] je prirad/i.test(msg || '');
}

async function checkOkteChyba(page: Page, kde: string): Promise<void> {
  const text = await precitajDialog(page);
  if (text && jeChybovyText(text)) {
    await zavriDialog(page);
    const cisty = text.replace(/\b(close|OK|Zatvoriť|Zavrieť|Áno|Nie|×|✕|✖)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`OKTE odmietlo (${kde}): ${cisty.slice(0, 220)}`);
  }
}

async function zrusPodformular(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await zavriDialog(page);
  const cancelHintids = [
    'contractFinanceData_agregacia_eic_grid_cancel',
    'contractFinanceData_agregacia_technologia_grid_cancel',
    'contractFinanceData_agregacia_agregacnyBlok_grid_cancel',
  ];
  for (const h of cancelHintids) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (await loc.isVisible().catch(() => false)) { await loc.click().catch(() => {}); await page.waitForTimeout(600); }
  }
  const zrus = page.getByRole('button', { name: /^(Zrušiť|Zavrieť|Späť|Storno)$/i }).first();
  if (await zrus.isVisible().catch(() => false)) { await zrus.click().catch(() => {}); await page.waitForTimeout(400); }
  await zavriDialog(page);
}

async function nechajOtvorene(page: Page) {
  if (!KEEP_OPEN || page.isClosed()) return;
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

function zapisReport(report: ZaznamReportu[], outDir: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pocet = (s: ZaznamReportu['stav']) => report.filter(r => r.stav === s).length;
  const bloky = Array.from(new Set(report.map(r => r.blok)));
  
  console.log('\n================ REPORT (AGREGÁCIA) ================');
  console.log(`OK:          ${pocet('OK')}`);
  console.log(`Preskočení:  ${pocet('PRESKOČENÝ')}`);
  console.log(`Duplicity:   ${pocet('DUPLICITA')}`);
  console.log(`Chyby:       ${pocet('CHYBA')}`);

  for (const b of bloky) {
    const vBloku = report.filter(r => r.blok === b);
    const c = (s: ZaznamReportu['stav']) => vBloku.filter(r => r.stav === s).length;
  }
  console.table(report);
  
  fs.writeFileSync(path.join(outDir, `agreg-report-${stamp}.json`), JSON.stringify(report, null, 2));
  const txt = report.map(r => `[${r.stav}] [${r.blok}] ${r.meno} (${r.eic})${r.dovod ? ' – ' + r.dovod : ''}`).join('\n');
  fs.writeFileSync(path.join(outDir, `agreg-report-${stamp}.txt`), txt);
}

async function klikniMenu(page: Page, labely: (string | RegExp)[], outDir: string, popis: string): Promise<boolean> {
  for (const label of labely) {
    const kand = [
      page.getByRole('menuitem', { name: label }).first(),
      page.getByRole('link', { name: label }).first(),
      page.getByRole('button', { name: label }).first(),
      typeof label === 'string'
        ? page.getByText(label, { exact: true }).first()
        : page.getByText(label).first(),
    ];
    for (const loc of kand) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click().catch(() => {});
        return true;
      }
    }
  }
  await dumpDiagnostiku(page, outDir, `menu-${popis}`);
  return false;
}

async function otvorZmluvu(page: Page, nazov: RegExp, outDir: string): Promise<boolean> {
  const jeZmena = async () =>
    (await page.getByRole('button', { name: /Zmena zmluvy/i }).isVisible().catch(() => false)) ||
    (await page.getByText(/Zmena zmluvy/i).first().isVisible().catch(() => false));

  const riadok = page.getByRole('row', { name: nazov }).first();
  let mam = await riadok.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!mam) { 
    await page.keyboard.press('End').catch(() => {});
    await page.waitForTimeout(1200);
    mam = await riadok.isVisible().catch(() => false);
  }

  if (mam) {
    await riadok.dblclick().catch(() => {});
    await page.waitForTimeout(2000);
    if (await jeZmena()) return true;
    await riadok.click().catch(() => {});
    await page.waitForTimeout(1000);
    if (await jeZmena()) return true;
  } else {
    const bunka = page.getByText(nazov).first();
    if (await bunka.isVisible().catch(() => false)) {
      await bunka.dblclick().catch(() => {});
      await page.waitForTimeout(2000);
      if (await jeZmena()) return true;
    }
  }

  await dumpDiagnostiku(page, outDir, 'otvorenie-zmluvy');
  return await jeZmena();
}

async function pockajNaEditProces(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction(() => {
    const ov = document.querySelector('ngui-overlay') as HTMLElement | null;
    const loading = !!ov && ov.offsetParent !== null;
    const grid = document.querySelector('[hintid="contractFinanceData_agregacia_agregacnyBlok_grid_add"]');
    const nextBtn = Array.from(document.querySelectorAll('button'))
      .some((b) => /Uložiť a ďalej/i.test((b as HTMLElement).innerText || ''));
    return !loading && (grid || nextBtn);
  }, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function dojdiNaAgregaciu(page: Page, outDir: string): Promise<boolean> {
  const jeAgregacia = async (): Promise<boolean> => await page.evaluate(() =>
    Array.from(document.querySelectorAll('[hintid]'))
      .some((e) => /agregac/i.test(e.getAttribute('hintid') || '') && (e as HTMLElement).getClientRects().length > 0),
  ).catch(() => false);

  const pockajNaVykreslenie = async (): Promise<void> => {
    await page.waitForFunction(() => {
      const ov = document.querySelector('ngui-overlay') as HTMLElement | null;
      const loading = !!ov && ov.offsetParent !== null;
      const pocetVis = Array.from(document.querySelectorAll('[hintid]'))
        .filter((e) => (e as HTMLElement).getClientRects().length > 0).length;
      return !loading && pocetVis > 0;
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
  };

  const jeSuhrn = async (): Promise<boolean> => await page.evaluate(() =>
    Array.from(document.querySelectorAll('[hintid]'))
      .some((e) => /contractSummary|dmsEditor|kontrola/i.test(e.getAttribute('hintid') || '') && (e as HTMLElement).getClientRects().length > 0),
  ).catch(() => false);

  const prefixSig = async (): Promise<string> => await page.evaluate(() => {
    const hs = Array.from(document.querySelectorAll('[hintid]'))
      .filter((e) => (e as HTMLElement).getClientRects().length > 0)
      .map((e) => (e.getAttribute('hintid') || '').split('_')[0]);
    return Array.from(new Set(hs)).sort().join(',');
  }).catch(() => '');

  const pockajNaZmenuKroku = async (pred: string): Promise<void> => {
    for (let t = 0; t < 30; t++) {
      const teraz = await prefixSig();
      if (teraz && teraz !== pred) { await page.waitForTimeout(1300); return; }
      await page.waitForTimeout(700);
    }
  };

  await pockajNaEditProces(page);

  for (let i = 1; i <= 10; i++) {
    await pockajNaVykreslenie();
    
    if (await jeAgregacia()) {
      return true;
    }

    if (await jeSuhrn()) {
      const spat = page.getByRole('button', { name: 'Krok späť' });
      if (await spat.isVisible().catch(() => false)) {
        const pred = await prefixSig();
        await spat.click().catch(() => {});
        await pockajNaZmenuKroku(pred);
        continue;
      }
      break;
    }

    const dalej = page.getByRole('button', { name: 'Uložiť a ďalej' });
    if (!(await dalej.isVisible().catch(() => false))) { await page.waitForTimeout(1500); continue; }
    const predSig = await prefixSig();
    await dalej.click().catch(() => {});
    await page.waitForTimeout(700);
    
    const dtext = await precitajDialog(page); 
    if (dtext) {
      await zavriDialog(page);
    }
    await pockajNaZmenuKroku(predSig);
  }

  await dumpDiagnostiku(page, outDir, 'nedosiahnuta-agregacia');
  return await jeAgregacia();
}

async function odosliZmenu(page: Page, outDir: string): Promise<boolean> {
  const finalneMena = [
    'Uložiť a odoslať do OKTE', 'Uložiť a odoslať', 'Odoslať do OKTE',
    'Odoslať', 'Podať zmenu', 'Uložiť a podať', 'Podať',
  ];
  for (let i = 0; i < 6; i++) {
    for (const m of finalneMena) {
      const b = page.getByRole('button', { name: m });
      if (await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {});
        await page.waitForTimeout(2500);
        await checkOkteChyba(page, `finálne odoslanie (${m})`);
        return true;
      }
    }
    const dalej = page.getByRole('button', { name: 'Uložiť a ďalej' });
    if (await dalej.isVisible().catch(() => false)) {
      await dalej.click().catch(() => {});
      await page.waitForTimeout(2200);
      await checkOkteChyba(page, `prechod pred odoslaním (pokus ${i + 1})`);
      await zavriDialog(page);
    } else {
      break;
    }
  }
  await dumpDiagnostiku(page, outDir, 'final-submit-nenajdene');
  return false;
}

async function pridajTechnologiu(page: Page, nazovAuto: string, outDir: string): Promise<void> {
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_technologia_grid_add'],
    texty: [/Pridať technológiu/i, /Pridať technolog/i],
    popis: 'Pridať technológiu',
  });
  await page.waitForTimeout(1200);
  
  await vyplnHintid(page, 'contractFinanceData_agregacia_technologia_nazov', nazovAuto);
  await klikniPrvyDatum(page, 'contractFinanceData_agregacia_technologia_datOd', outDir);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_technologia_typ', CONFIG.agregacia.technologiaTyp);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_technologia_stavZariadenia', CONFIG.agregacia.technologiaStav);
  
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_technologia_grid_submit'],
    texty: [/Uložiť technológiu/i, /^Uložiť$/i],
    popis: 'Uložiť technológiu',
  });
  await page.waitForTimeout(1500);
  await checkOkteChyba(page, 'uloženie technológie');
}

async function pridajEic(page: Page, eic: string, nazovOm: string, nazovAuto: string, blok: string, outDir: string): Promise<void> {
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_eic_grid_add'],
    texty: [/Pridať EIC/i, /Pridať odberné/i, /Pridať OOM/i, /Pridať OM/i, /Pridať miesto/i],
    popis: 'Pridať EIC',
  });
  await page.waitForTimeout(1200);
  
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_eic', eic);
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_nazovOm', nazovOm);
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_bilancnaSkupina', CONFIG.agregacia.bilancnaSkupina);
  await klikniPrvyDatum(page, 'contractFinanceData_agregacia_eic_datOd', outDir);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_stavZariadenia', CONFIG.agregacia.eicStav);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_typZdrojaFlex', CONFIG.agregacia.eicTypZdroja);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_typPoskytovatelaFlex', CONFIG.agregacia.eicTypPoskytovatela);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_smerFlexibility', CONFIG.agregacia.eicSmer);
  
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_codesAgregacneBloky', new RegExp(escRe(blok), 'i'));
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_codesTechnologie', new RegExp(escRe(nazovAuto), 'i'));
  
  await page.waitForTimeout(500);
  await checkOkteChyba(page, 'validácia EIC');
  
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_eic_grid_submit'],
    texty: ['Uložiť EIC', /^Uložiť$/i],
    popis: 'Uložiť EIC',
  });
  await page.waitForTimeout(2000);
  await checkOkteChyba(page, 'uloženie EIC');
}

function nacitajCsv(cesta: string, blok: string, report: ZaznamReportu[]): ZakaznikFlexibility[] {
  const obsah = fs.readFileSync(cesta, 'utf-8').replace(/^\uFEFF/, ''); 
  const raw: ZakaznikFlexibility[] = parse(obsah, {
    columns: (hdr: string[]) => hdr.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    delimiter: [';', ','],
  });
  const out: ZakaznikFlexibility[] = [];
  for (const r of raw) {
    const meno = (r.meno || '').trim();
    const eic = (r.eic || '').trim().toUpperCase();
    if (!meno) { 
      console.warn(`  ⚠️ PRESKOČENÝ (prázdne meno): chýba meno pre EIC ${eic}`);
      report.push({ blok, meno: '(prázdne)', eic, stav: 'PRESKOČENÝ', dovod: 'chýba meno' }); 
      continue; 
    }
    if (!eic) { 
      console.warn(`  ⚠️ PRESKOČENÝ ${meno}: chýba EIC kód`);
      report.push({ blok, meno, eic: '', stav: 'PRESKOČENÝ', dovod: 'chýba EIC' }); 
      continue; 
    }
    if (!eic.startsWith('24')) { 
      console.warn(`  ⚠️ PRESKOČENÝ ${meno}: neplatné EIC (${eic} nezačína na 24)`);
      report.push({ blok, meno, eic, stav: 'PRESKOČENÝ', dovod: 'neplatné EIC (nezačína na 24)' }); 
      continue; 
    }
    out.push({ meno, eic });
  }
  return out;
}

async function zabezpecBlok(page: Page, blok: string, outDir: string): Promise<boolean> {
  const existuje = await page.getByRole('row', { name: new RegExp(escRe(blok), 'i') }).first().isVisible().catch(() => false);
  if (existuje) { return true; }
  try {
    const otvorene = await klikniDefensive(page, {
      hintids: ['contractFinanceData_agregacia_agregacnyBlok_grid_add'],
      texty: [/Pridať agregačný blok/i, /Pridať blok/i],
      popis: 'Pridať agregačný blok',
    });
    if (!otvorene) { await dumpDiagnostiku(page, outDir, 'blok-add-nenajdene'); throw new Error('Tlačidlo sa nenašlo.'); }
    
    await page.waitForTimeout(1200);
    
    await vyplnHintid(page, 'contractFinanceData_agregacia_agregacnyBlok_nazov', blok);
    await klikniPrvyDatum(page, 'contractFinanceData_agregacia_agregacnyBlok_datOd', outDir);
    await vyplnHintid(page, 'contractFinanceData_agregacia_agregacnyBlok_bilancnaSkupina', CONFIG.agregacia.bilancnaSkupina);
    
    await klikniDefensive(page, {
      hintids: ['contractFinanceData_agregacia_agregacnyBlok_grid_submit'],
      texty: [/Uložiť agregačný blok/i, /Uložiť blok/i, /^Uložiť$/i],
      popis: 'Uložiť agregačný blok',
    });
    await page.waitForTimeout(1500);
    await checkOkteChyba(page, 'uloženie agregačného bloku');
    return true;
  } catch (e: any) {
    if (jeDuplicita(e.message)) { await zrusPodformular(page); return true; }
    await dumpDiagnostiku(page, outDir, 'blok-chyba');
    await zrusPodformular(page);
    return false;
  }
}

async function spracujDavku(page: Page, blok: string, riadky: ZakaznikFlexibility[], outDir: string, report: ZaznamReportu[]): Promise<void> {
  const skupiny = new Map<string, string[]>();
  for (const { meno, eic } of riadky) {
    if (!skupiny.has(meno)) skupiny.set(meno, []);
    const arr = skupiny.get(meno)!;
    if (arr.includes(eic)) { 
      console.warn(`  ⚠️ PRESKOČENÝ ${meno}: duplicitný riadok v CSV pre EIC ${eic}`);
      report.push({ blok, meno, eic, stav: 'PRESKOČENÝ', dovod: 'duplicitný riadok v CSV' }); 
      continue; 
    }
    arr.push(eic);
  }

  for (const [meno, eics] of skupiny) {
    if (page.isClosed()) { break; }
    const nazovAuto = `${meno} auto`;
    const viacOM = eics.length > 1;

    try {
      await pridajTechnologiu(page, nazovAuto, outDir);
    } catch (e: any) {
      if (jeDuplicita(e.message)) { await zrusPodformular(page); }
      else {
        await dumpDiagnostiku(page, outDir, `technologia-${meno}`);
        await zrusPodformular(page);
        for (const eic of eics) report.push({ blok, meno, eic, stav: 'CHYBA', dovod: `technológia zlyhala: ${e.message}` });
        if (page.isClosed() || /has been closed/i.test(e.message)) break;
        continue;
      }
    }

    for (let i = 0; i < eics.length; i++) {
      if (page.isClosed()) break;
      const eic = eics[i];
      const nazovOm = viacOM ? `${meno} ${i + 1}` : meno;
      try {
        await pridajEic(page, eic, nazovOm, nazovAuto, blok, outDir);
        report.push({ blok, meno, eic, stav: 'OK', dovod: `OM "${nazovOm}" → auto "${nazovAuto}"` });
      } catch (e: any) {
        const dup = jeDuplicita(e.message);
        report.push({ blok, meno, eic, stav: dup ? 'DUPLICITA' : 'CHYBA', dovod: `OM "${nazovOm}": ${e.message}` });
        if (!dup) await dumpDiagnostiku(page, outDir, `eic-${meno}-${i + 1}`);
        if (page.isClosed() || /has been closed/i.test(e.message)) { break; }
        await zrusPodformular(page);
      }
    }
  }
}

/* ================================ TEST ================================ */

test('Agregácia flexibility – hromadný zápis z CSV', async ({ page }) => {
  test.setTimeout(0);
  page.on('dialog', d => d.accept().catch(() => {})); 

  if (!CONFIG.okte.username || !CONFIG.okte.password) {
    throw new Error('Chýbajú OKTE prihlasovacie údaje.');
  }

  const outDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const report: ZaznamReportu[] = [];

  const davky: { blok: string; riadky: ZakaznikFlexibility[] }[] = [];
  for (const d of CONFIG.agregacia.davky) {
    const cesta = path.join(process.cwd(), d.csv);
    if (!fs.existsSync(cesta)) {
      continue;
    }
    const riadky = nacitajCsv(cesta, d.blok, report);
    if (riadky.length > 0) davky.push({ blok: d.blok, riadky });
  }
  const totalNaZapis = davky.reduce((s, d) => s + d.riadky.length, 0);
  if (totalNaZapis === 0) {
    zapisReport(report, outDir);
    return;
  }

  const jePrihlaseny = (u: URL) => !u.href.includes('/public') && !u.href.includes('/auth/');

  const vstupnaUrl = CONFIG.okte.mojeZmluvyUrl || CONFIG.okte.zmluvaUrl;
  await page.goto(vstupnaUrl).catch(() => {}); 
  await page.waitForLoadState('networkidle').catch(() => {});

  if (!jePrihlaseny(new URL(page.url()))) {
    try {
      const prihlasitBtn = page.getByRole('button', { name: 'Prihlásiť sa' });
      if (await prihlasitBtn.isVisible().catch(() => false)) await prihlasitBtn.click({ timeout: 8000 });
      await page.getByLabel('Prihlasovacie meno').fill(CONFIG.okte.username, { timeout: 8000 });
      await page.getByLabel('Heslo', { exact: true }).fill(CONFIG.okte.password, { timeout: 8000 });
      await page.getByRole('button', { name: 'Prihlásenie' }).click({ timeout: 8000 });
    } catch {}
    await page.waitForURL(jePrihlaseny, { timeout: 300000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  page.setDefaultTimeout(20000);

  const subjektDropdown = page.locator('.ng-select.ng-invalid').first();
  if (await subjektDropdown.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    await subjektDropdown.click();
    await page.getByRole('option', { name: CONFIG.okte.subjekt }).click();
    const okBtn = page.getByRole('button', { name: 'OK', exact: true });
    if (await okBtn.isVisible().catch(() => false)) await okBtn.click();
  }

  if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'po-prihlaseni');

  await page.waitForTimeout(1500);

  if (CONFIG.okte.mojeZmluvyUrl) {
    await page.goto(CONFIG.okte.mojeZmluvyUrl).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  } else {
    const mojeVidno = await page.getByText(/Moje zmluvy|Zoznam zml/i).first().isVisible().catch(() => false);
    if (!mojeVidno) {
      await page.locator('span.app-left-menu-item.contract', { hasText: /^Zmluvy$/ }).first()
        .click().catch(() => klikniMenu(page, ['Zmluvy', /^Zmluvy$/i], outDir, 'Zmluvy (rozbalenie)'));
      await page.waitForTimeout(1000);
    }
    if (!(await klikniMenu(page, ['Moje zmluvy', /Moje zmluvy/i, /Zoznam zml[úu]v/i, /Vyhľadanie zml/i], outDir, 'Zoznam zmlúv'))) {
      throw new Error('Do zoznamu zmlúv som sa nedostal.');
    }
  }
  await page.waitForTimeout(3000);
  if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'zoznam-zmluv');

  const cielRe = CONFIG.okte.cisloZmluvy
    ? new RegExp(escRe(CONFIG.okte.cisloZmluvy), 'i')
    : CONFIG.okte.nazovZmluvy;

  const zmluvaRiadok = page.getByRole('row', { name: cielRe }).first();
  if (!(await zmluvaRiadok.isVisible().catch(() => false))) {
    const hladat = page.getByRole('button', { name: /Vyhľadať|Hľadať|Filtrovať|Zobraziť/i }).first();
    if (await hladat.isVisible().catch(() => false)) {
      await hladat.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  if (!(await otvorZmluvu(page, cielRe, outDir))) {
    if (await zmluvaRiadok.isVisible().catch(() => false)) {
      await zmluvaRiadok.click({ button: 'right' }).catch(() => {});
      await page.waitForTimeout(700);
    }
    if (!(await klikniDefensive(page, { texty: ['Zmena zmluvy', /Zmena zmluvy/i], popis: 'Zmena zmluvy (kontext. menu)' }))) {
      await klikniDefensive(page, { texty: [/Akcie/i, /Možnosti/i, '⋮', '…', '...'], popis: 'Akcie/kebab' });
      await page.waitForTimeout(700);
      if (!(await klikniDefensive(page, { texty: ['Zmena zmluvy', /Zmena zmluvy/i], popis: 'Zmena zmluvy (po akciách)' }))) {
        await dumpDiagnostiku(page, outDir, 'zmena-zmluvy-nenajdena');
        throw new Error('Tlačidlo/akcia "Zmena zmluvy" sa nenašla.');
      }
    }
  } else {
    if (!(await klikniDefensive(page, {
      hintids: ['zmluvaDetail_startEditProcess_PORTAL'],
      texty: ['Zmena zmluvy', /Zmena zmluvy/i],
      popis: 'Zmena zmluvy',
    }))) {
      await dumpDiagnostiku(page, outDir, 'zmena-zmluvy-nenajdena');
      throw new Error('Tlačidlo "Zmena zmluvy" sa nenašlo.');
    }
  }
  await page.waitForTimeout(1500);
  await zavriDialog(page); 
  await checkOkteChyba(page, 'otvorenie Zmeny zmluvy');

  if (!(await dojdiNaAgregaciu(page, outDir))) {
    throw new Error('Nepodarilo sa dostať do sekcie Agregácia.');
  }

  for (const d of davky) {
    if (page.isClosed()) { break; }
    const blokOk = await zabezpecBlok(page, d.blok, outDir);
    if (!blokOk) {
      for (const r of d.riadky) report.push({ blok: d.blok, meno: r.meno, eic: r.eic, stav: 'CHYBA', dovod: 'blok sa nepodarilo vytvoriť' });
      continue;
    }
    await spracujDavku(page, d.blok, d.riadky, outDir, report);
  }

  const uspesne = report.filter(r => r.stav === 'OK').length;
  if (AUTO_SUBMIT && uspesne > 0 && !page.isClosed()) {
    const odoslane = await odosliZmenu(page, outDir);
  }

  zapisReport(report, outDir);
  await nechajOtvorene(page);

  const chyby = report.filter(r => r.stav === 'CHYBA');
  if (chyby.length > 0) {
    throw new Error(`${chyby.length} zápis(ov) zlyhalo`);
  }
});