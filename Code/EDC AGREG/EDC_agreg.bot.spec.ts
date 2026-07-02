import { test as base, chromium, type Page, type BrowserContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
// @ts-ignore - csv-parse v5 sync API
import { parse } from 'csv-parse/sync';

// --- Načítanie .env (ak existuje) do process.env – bez externej závislosti. ---
// Prihlasovacie údaje daj do súboru .env (OKTE_USER, OKTE_PASSWORD). .env do gitu NEPATRÍ.
(() => {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignor */ }
})();

/**
 * ============================================================================
 * EDC – AGREGÁCIA FLEXIBILITY (hromadný zápis z CSV do ZMENY ZMLUVY)
 * ============================================================================
 * Proces je INÝ ako ZPÚ:
 * - ZPÚ  = zakladá NOVÉHO účastníka (4-krokový wizard, odošle sa PER zákazník).
 * - AGREGÁCIA = robí JEDNU "Zmenu zmluvy" nad existujúcou "Zmluvou o poskytovaní
 * údajov", v kroku 3 (sekcia Agregácia) pridá 1× agregačný blok a pre KAŽDÉHO
 * zákazníka technológiu + EIC. Celá zmena sa odosiela do OKTE RAZ na konci.
 *
 * Perzistentný Chrome profil: pri prvom behu klikneš "Povoliť" raz, ďalšie behy
 * sú plne automatické. Certifikát vyberá Windows policy (channel: 'chrome').
 * ============================================================================
 */

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

/* ------------------------------ PREPÍNAČE ------------------------------ */
// AUTO_SUBMIT=0  -> vyplní blok + všetkých zákazníkov, ale ZMENU NEODOŠLE (skontroluješ ručne).
// AUTO_SUBMIT!=0 -> po spracovaní klikne cez zvyšné kroky a odošle zmenu do OKTE.
// PRVÝ BEH ODPORÚČAM: AUTO_SUBMIT=0, pozri, či je všetko OK, až potom naostro.
const AUTO_SUBMIT = process.env.AUTO_SUBMIT !== '0';
const KEEP_OPEN = process.env.KEEP_OPEN !== '0';

const CONFIG = {
  okte: {
    publicUrl: 'https://edc.okte.sk/portal/ui/public',
    // Chránená URL použitá LEN na spustenie prihlásenia (ak nás profil pamätá, sme rovno dnu).
    zmluvaUrl: 'https://edc.okte.sk/portal/ui/zmluva/zalozenie-zmluvy',
    // Priama URL zoznamu zmlúv (Vyhľadanie zmlúv) – obchádza krehké klikanie v strome menu.
    mojeZmluvyUrl: 'https://edc.okte.sk/portal/ui/zmluva/vyhladanie',
    username: process.env.OKTE_USER || '',      // nastav v .env (OKTE_USER)
    password: process.env.OKTE_PASSWORD || '',  // nastav v .env (OKTE_PASSWORD)
    subjekt: 'Voltia Technologies s.r.o.',
    // Zmluvu identifikujeme PRIMÁRNE podľa ČÍSLA (unikátne), s fallbackom na názov.
    cisloZmluvy: '2026-15-5942',
    nazovZmluvy: /Zmluva o poskytovaní údajov/i,
  },
  agregacia: {
    bilancnaSkupina: '24YB-VOLTIATECHP',
    // DÁVKY: každý CSV súbor → svoj agregačný blok. Blok sa vytvorí raz (ak už je, preskočí sa).
    // Do data.csv daj ľudí pre SSE blok 1, do data_wattiva.csv "ostatok" pre WATTIVA blok 1.
    // Formát oboch súborov je rovnaký: hlavička "meno;eic" (alebo čiarka), jeden riadok = jedno OM.
    davky: [
      { csv: 'data.csv', blok: 'SSE blok 1' },
      { csv: 'data_wattiva.csv', blok: 'WATTIVA blok 1' },
    ] as { csv: string; blok: string }[],
    // Voľby v ng-select dropdownoch (regexy, case-insensitive).
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

/* ============================ POMOCNÉ FUNKCIE ============================ */
/* Prenesené z overeného ZPÚ bota (silnejšie verzie) + pár agregačných.       */

/** Escapuje reťazec do bezpečného RegExp fragmentu (názvy blokov/technológií). */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Vyplní pole cez hintid (+ index pri opakovaných). Vyčistí autofill, počká, vyplní.
 * Ak pole nie je / je disabled, nezhodí beh – vráti false. */
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

/** Vyberie možnosť v ng-select podľa hintid. Z viacerých zhôd berie NAJKRATŠIU
 * (základnú možnosť, nie dlhší podtyp). Skúsi 2× (prvý dropdown niekedy mešká). */
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

/** Otvorí kalendár (podľa hintid) a klikne PRVÝ povolený deň. bs-datepicker primárne,
 * s "next" prekliknutím (18 mes.) + fallback na iné datepickery. Dump HTML ak zlyhá. */
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
  console.warn(`  Neznámy/prázdny datepicker pre ${hintid} – diagnostika uložená.`);
  return false;
}

/** Nastaví checkbox na požadovaný stav. */
async function zaskrtni(page: Page, hintid: string, chciZaskrtnute = true): Promise<boolean> {
  const cb = page.locator(`[hintid="${hintid}"]`);
  if (!(await cb.isVisible().catch(() => false))) return false;
  const je = await cb.isChecked().catch(() => false);
  if (je !== chciZaskrtnute) await cb.click({ force: true }).catch(() => {});
  return true;
}

/** OBRANNÝ KLIK: skúsi po poradí hintid selektory, potom text/role. Loguje, čo zabralo.
 * Rieši neistotu okolo presných hintidov (technológia/EIC add/submit majú viac variantov). */
async function klikniDefensive(
  page: Page,
  opts: { hintids?: string[]; texty?: (string | RegExp)[]; ako?: 'button' | 'text'; popis: string },
): Promise<boolean> {
  // 1) hintids NORMÁLNY klik (ak je hintid na reálne klikateľnom prvku).
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (await loc.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
      console.log(`  ✓ ${opts.popis} [hintid=${h}]`);
      return true;
    }
  }
  // 2) texty: grid "add" je viditeľný odkaz/span (nie button) → skús button, link aj text.
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
      if (await loc.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
        console.log(`  ✓ ${opts.popis} [text=${t}]`);
        return true;
      }
    }
  }
  // 3) force-klik hintidu (0-rozmerný wrapper).
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    if (await loc.click({ force: true, timeout: 2500 }).then(() => true).catch(() => false)) {
      console.log(`  ✓ ${opts.popis} [hintid=${h}, force]`);
      return true;
    }
  }
  // 4) JS natívny .click() na prvok s hintidom (spustí Angular handler aj bez rozmeru/pozície).
  for (const h of opts.hintids || []) {
    const loc = page.locator(`[hintid="${h}"]`).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const ok = await loc.evaluate((el) => { (el as HTMLElement).click(); return true; }).catch(() => false);
    if (ok) {
      console.log(`  ✓ ${opts.popis} [hintid=${h}, js-click]`);
      return true;
    }
  }
  // 5) JS vyhľadanie VIDITEĽNÉHO odkazu/tlačidla podľa textu a natívny klik naň.
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
    if (ok) {
      console.log(`  ✓ ${opts.popis} [js-text=${t}]`);
      return true;
    }
  }
  console.warn(`  ✗ ${opts.popis} – žiadny selektor nesedel (hintids: ${(opts.hintids || []).join(', ') || '—'}; texty: ${(opts.texty || []).map(String).join(', ') || '—'})`);
  return false;
}

/** Uloží screenshot + HTML + zoznam VIDITEĽNÝCH hintidov aktuálnej obrazovky.
 * Súbor "-hintids.txt" je kľúčový na ladenie: pošli mi ho a doladím presné selektory. */
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
    console.warn(`  📸 Diagnostika: ${base}.{png,html,-hintids.txt}`);
  } catch { /* ignor */ }
}

/** Vypíše do TERMINÁLU viditeľné hintidy (celé + filtrované na agregáciu). Terminál chodí
 * spoľahlivo aj tam, kde prílohy nie – slúži na doladenie názvov polí v podformulároch. */
async function vypisHintidy(page: Page, tag: string): Promise<void> {
  const hs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[hintid]'))
      .filter((e) => (e as HTMLElement).getClientRects().length > 0)
      .map((e) => e.getAttribute('hintid') || ''),
  ).catch(() => [] as string[]);
  const agr = hs.filter((h) => /agregac/i.test(h));
  console.log(`  [${tag}] agregačné polia (${agr.length}): ${agr.join(', ') || '—'}`);
}

/** Prečíta text otvoreného modálu (ak je), inak null. */
async function precitajDialog(page: Page): Promise<string | null> {
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.isVisible().catch(() => false))) return null;
  const t = (await dialog.innerText().catch(() => '')).trim();
  return t || '(prázdny dialóg)';
}

/** Zatvorí otvorený modál (OK/Zatvoriť/Áno…). Vráti true, ak nejaký zavrel. */
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

/** Vyzerá text dialógu ako chyba/odmietnutie? */
function jeChybovyText(t: string): boolean {
  return /neexist|nenájd|nenajd|nie je|nespr[áa]vn|chyb|zlyhal|nepodaril|mus[íi]te|povinn|neplatn|invalid|error|nemo[žz]no|u[žz] existuje|duplicit|nevypln|ch[ýy]ba/i.test(t);
}

/** Je odmietnutie iba DUPLICITA (už zaradené / už existuje), nie reálna chyba? */
function jeDuplicita(msg: string): boolean {
  return /u[žz] je zaraden|neplatn[ée] pre akt[íi]vneho odberate[ľl]a|u[žz] existuje|duplicit|u[žz] je registrov|u[žz] je prirad/i.test(msg || '');
}

/** Checkpoint: ak OKTE vyhodil chybový dialóg, zatvor ho a hoď výnimku. */
async function checkOkteChyba(page: Page, kde: string): Promise<void> {
  const text = await precitajDialog(page);
  if (text && jeChybovyText(text)) {
    await zavriDialog(page);
    const cisty = text.replace(/\b(close|OK|Zatvoriť|Zavrieť|Áno|Nie|×|✕|✖)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`OKTE odmietlo (${kde}): ${cisty.slice(0, 220)}`);
  }
}

/** Zruší otvorený podformulár (EIC/technológia/blok) a prípadný dialóg – nech ďalší začne čisto. */
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

/** Necháva prehliadač OTVORENÝ na kontrolu (timeout 0 = žiadny časovač). */
async function nechajOtvorene(page: Page) {
  if (!KEEP_OPEN || page.isClosed()) return;
  console.log('\nPrehliadač nechávam OTVORENÝ na kontrolu. Zavri ho ručne krížikom, keď budeš chcieť (žiadny časovač).');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

/** Zapíše report do konzoly + na disk (JSON + TXT). */
function zapisReport(report: ZaznamReportu[], outDir: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pocet = (s: ZaznamReportu['stav']) => report.filter(r => r.stav === s).length;
  console.log('\n================ REPORT (AGREGÁCIA) ================');
  console.log(`OK:          ${pocet('OK')}`);
  console.log(`Preskočení:  ${pocet('PRESKOČENÝ')}`);
  console.log(`Duplicity:   ${pocet('DUPLICITA')}`);
  console.log(`Chyby:       ${pocet('CHYBA')}`);
  // Rozpad podľa blokov (koľko OK/chýb išlo do ktorého bloku).
  const bloky = Array.from(new Set(report.map(r => r.blok)));
  for (const b of bloky) {
    const vBloku = report.filter(r => r.blok === b);
    const c = (s: ZaznamReportu['stav']) => vBloku.filter(r => r.stav === s).length;
    console.log(`  · ${b}: OK ${c('OK')}, duplicity ${c('DUPLICITA')}, chyby ${c('CHYBA')}, preskočené ${c('PRESKOČENÝ')}`);
  }
  console.table(report);
  fs.writeFileSync(path.join(outDir, `agreg-report-${stamp}.json`), JSON.stringify(report, null, 2));
  const txt = report.map(r => `[${r.stav}] [${r.blok}] ${r.meno} (${r.eic})${r.dovod ? ' – ' + r.dovod : ''}`).join('\n');
  fs.writeFileSync(path.join(outDir, `agreg-report-${stamp}.txt`), txt);
  console.log(`Report uložený do: ${outDir}`);
}

/** Klik v ľavom menu. Prijíma zoznam ALIASOV (menu môže byť "Moje zmluvy" aj "Zoznam zmlúv"...).
 * Poradie: menuitem -> link -> button -> exact text -> partial text. Dump na disk, ak nič nesedí. */
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
        console.log(`  ✓ menu: ${popis}`);
        return true;
      }
    }
  }
  console.warn(`  ✗ menu: ${popis} – žiadny alias sa nenašiel (${labely.map(String).join(' | ')})`);
  await dumpDiagnostiku(page, outDir, `menu-${popis}`);
  return false;
}

/** Otvorí riadok zmluvy a overí, že sa dostaneme k akcii "Zmena zmluvy".
 * Skúša: dvojklik na riadok -> (fallback) jednoklik -> (fallback) dvojklik na bunku s textom.
 * Ak lazy tabuľka ešte nemá riadok, skúsi scroll (End). Vráti true, ak je "Zmena zmluvy" dostupná. */
async function otvorZmluvu(page: Page, nazov: RegExp, outDir: string): Promise<boolean> {
  const jeZmena = async () =>
    (await page.getByRole('button', { name: /Zmena zmluvy/i }).isVisible().catch(() => false)) ||
    (await page.getByText(/Zmena zmluvy/i).first().isVisible().catch(() => false));

  const riadok = page.getByRole('row', { name: nazov }).first();
  let mam = await riadok.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!mam) { // lazy/paginovaná tabuľka – skús donačítať
    await page.keyboard.press('End').catch(() => {});
    await page.waitForTimeout(1200);
    mam = await riadok.isVisible().catch(() => false);
  }

  if (mam) {
    await riadok.dblclick().catch(() => {});
    await page.waitForTimeout(2000);
    if (await jeZmena()) return true;
    await riadok.click().catch(() => {}); // dvojklik neotvoril detail → skús jednoklik + akcie
    await page.waitForTimeout(1000);
    if (await jeZmena()) return true;
  } else {
    const bunka = page.getByText(nazov).first(); // úplný fallback: bunka s textom
    if (await bunka.isVisible().catch(() => false)) {
      await bunka.dblclick().catch(() => {});
      await page.waitForTimeout(2000);
      if (await jeZmena()) return true;
    }
  }

  await dumpDiagnostiku(page, outDir, 'otvorenie-zmluvy');
  return await jeZmena();
}

/** Počká, kým sa editačný proces ("Zmena zmluvy") načíta: zmizne gui-blocker overlay
 * a objaví sa buď cieľový agregačný grid, alebo tlačidlo "Uložiť a ďalej". */
async function pockajNaEditProces(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction(() => {
    // gui-blocker overlay viditeľný => ešte sa načítava
    const ov = document.querySelector('ngui-overlay') as HTMLElement | null;
    const loading = !!ov && ov.offsetParent !== null;
    const grid = document.querySelector('[hintid="contractFinanceData_agregacia_agregacnyBlok_grid_add"]');
    const nextBtn = Array.from(document.querySelectorAll('button'))
      .some((b) => /Uložiť a ďalej/i.test((b as HTMLElement).innerText || ''));
    return !loading && (grid || nextBtn);
  }, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Dostane sa do sekcie Agregácia v editačnom procese "Zmena zmluvy".
 * Krok Agregácia rozpozná IBA podľa viditeľného hintidu s "agregac" (text zo steppera je
 * na každom kroku, preto sa naň nedá spoľahnúť). Prechádza krokmi a na KAŽDOM vypíše do
 * terminálu prefixy + zaujímavé hintidy – z toho vieme presne pomenovať agregačné polia. */
async function dojdiNaAgregaciu(page: Page, outDir: string): Promise<boolean> {
  const jeAgregacia = async (): Promise<boolean> => await page.evaluate(() =>
    Array.from(document.querySelectorAll('[hintid]'))
      .some((e) => /agregac/i.test(e.getAttribute('hintid') || '') && (e as HTMLElement).getClientRects().length > 0),
  ).catch(() => false);

  const vypisKrok = async (i: number): Promise<void> => {
    const info = await page.evaluate(() => {
      const vis = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
      const hs = Array.from(document.querySelectorAll('[hintid]'))
        .filter(vis).map((e) => e.getAttribute('hintid') || '');
      const prefixy = Array.from(new Set(hs.map((h) => h.split('_')[0])));
      const zaujimave = hs.filter((h) => /agregac|technolog|grid_add|grid_submit|_eic|flexib|blok/i.test(h));
      return { prefixy, zaujimave };
    }).catch(() => ({ prefixy: [] as string[], zaujimave: [] as string[] }));
    console.log(`  pokus ${i}: prefixy = ${info.prefixy.join(', ') || '—'}`);
    if (info.zaujimave.length) console.log(`  pokus ${i}: agregačné hintidy = ${info.zaujimave.join(', ')}`);
  };

  // Počká, kým sa aktuálny krok NAOZAJ vykreslí (gui-blocker preč + sú viditeľné hintidy).
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

  // Signatúra aktuálneho kroku = zoradené prefixy viditeľných hintidov. Slúži na detekciu ZMENY kroku.
  const prefixSig = async (): Promise<string> => await page.evaluate(() => {
    const hs = Array.from(document.querySelectorAll('[hintid]'))
      .filter((e) => (e as HTMLElement).getClientRects().length > 0)
      .map((e) => (e.getAttribute('hintid') || '').split('_')[0]);
    return Array.from(new Set(hs)).sort().join(',');
  }).catch(() => '');

  // Počká, kým sa signatúra kroku ZMENÍ oproti "pred" (t.j. reálne sme na novom, vykreslenom kroku).
  const pockajNaZmenuKroku = async (pred: string): Promise<void> => {
    for (let t = 0; t < 30; t++) {
      const teraz = await prefixSig();
      if (teraz && teraz !== pred) { await page.waitForTimeout(1300); return; } // nový krok → ustáľ
      await page.waitForTimeout(700);
    }
  };

  // 1) Počkaj na načítanie editačného procesu.
  await pockajNaEditProces(page);
  if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'edit-proces-nacitany');

  // 2) Krokuj wizardom LEN cez "Uložiť a ďalej" (stepper je neklikateľný). Po každom klik-u POČKAJ,
  //    kým sa krok naozaj zmení a vykreslí – inak by sa agregácia (krok 3) checkla prázdna a preskočila.
  //    Ak aj tak preletíme na Kontrolu, vrátime sa "Krok späť" (mal by byť práve krok 3 = agregácia).
  for (let i = 1; i <= 10; i++) {
    await pockajNaVykreslenie();
    await vypisKrok(i);
    if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, `pokus-${i}`);
    if (await jeAgregacia()) {
      await dumpDiagnostiku(page, outDir, 'agregacia-najdena');
      console.log('  ✓ Agregácia (krok "Prílohy zmluvy") rozpoznaná – zastavujem sa tu.');
      return true;
    }

    // Preleteli sme na Kontrolu (krok 4)? → "Krok späť" na krok 3 (agregácia).
    if (await jeSuhrn()) {
      const spat = page.getByRole('button', { name: 'Krok späť' });
      if (await spat.isVisible().catch(() => false)) {
        console.log('  Som na Kontrole – vraciam sa "Krok späť" na agregáciu.');
        const pred = await prefixSig();
        await spat.click().catch(() => {});
        await pockajNaZmenuKroku(pred);
        continue;
      }
      console.log('  Som na Kontrole a "Krok späť" nie je – končím hľadanie.');
      break;
    }

    // Sme na kroku 1/2 → klikni "Uložiť a ďalej" a POČKAJ na zmenu kroku.
    const dalej = page.getByRole('button', { name: 'Uložiť a ďalej' });
    if (!(await dalej.isVisible().catch(() => false))) { await page.waitForTimeout(1500); continue; }
    const predSig = await prefixSig();
    await dalej.click().catch(() => {});
    await page.waitForTimeout(700);
    const dtext = await precitajDialog(page); // mäkký info/potvrdzovací popup pri prechode
    if (dtext) {
      console.log(`  (dialóg pri prechode, pokus ${i}: ${dtext.slice(0, 140).replace(/\s+/g, ' ')})`);
      await zavriDialog(page);
    }
    await pockajNaZmenuKroku(predSig);
  }

  await dumpDiagnostiku(page, outDir, 'nedosiahnuta-agregacia');
  return await jeAgregacia();
}

/** Finálne odoslanie ZMENY zmluvy: preklikaj zvyšné kroky a stlač odosielacie tlačidlo. */
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
        console.log(`  Zmena odoslaná tlačidlom "${m}".`);
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

/** Pridá technológiu (auto) do agregácie. Hodí výnimku pri chybe/odmietnutí OKTE. */
async function pridajTechnologiu(page: Page, nazovAuto: string, outDir: string): Promise<void> {
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_technologia_grid_add'],
    texty: [/Pridať technológiu/i, /Pridať technolog/i],
    popis: 'Pridať technológiu',
  });
  await page.waitForTimeout(1200);
  await vypisHintidy(page, 'podformulár TECHNOLÓGIA');
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

/** Pridá jedno odberné miesto (EIC) naviazané na blok + technológiu (auto).
 * nazovOm = názov OM (číslovaný pri opakujúcich sa menách). Hodí výnimku pri chybe OKTE. */
async function pridajEic(page: Page, eic: string, nazovOm: string, nazovAuto: string, blok: string, outDir: string): Promise<void> {
  await klikniDefensive(page, {
    hintids: ['contractFinanceData_agregacia_eic_grid_add'],
    texty: [/Pridať EIC/i, /Pridať odberné/i, /Pridať OOM/i, /Pridať OM/i, /Pridať miesto/i],
    popis: 'Pridať EIC',
  });
  await page.waitForTimeout(1200);
  if (!(global as any).__eicPoliaVypisane) { await vypisHintidy(page, 'podformulár EIC'); (global as any).__eicPoliaVypisane = true; }
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_eic', eic);
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_nazovOm', nazovOm);
  await vyplnHintid(page, 'contractFinanceData_agregacia_eic_bilancnaSkupina', CONFIG.agregacia.bilancnaSkupina);
  await klikniPrvyDatum(page, 'contractFinanceData_agregacia_eic_datOd', outDir);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_stavZariadenia', CONFIG.agregacia.eicStav);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_typZdrojaFlex', CONFIG.agregacia.eicTypZdroja);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_typPoskytovatelaFlex', CONFIG.agregacia.eicTypPoskytovatela);
  await vyberNgSelect(page, 'contractFinanceData_agregacia_eic_smerFlexibility', CONFIG.agregacia.eicSmer);
  // Väzba na SPRÁVNY blok (podľa dávky) + na TO ISTÉ auto (technológiu) – escapované názvy.
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

/** Načíta a zvaliduje jeden CSV súbor pre danú dávku. Nevalidné riadky ide do reportu. */
function nacitajCsv(cesta: string, blok: string, report: ZaznamReportu[]): ZakaznikFlexibility[] {
  const obsah = fs.readFileSync(cesta, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
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
    if (!meno) { report.push({ blok, meno: '(prázdne)', eic, stav: 'PRESKOČENÝ', dovod: 'chýba meno' }); continue; }
    if (!eic) { report.push({ blok, meno, eic: '', stav: 'PRESKOČENÝ', dovod: 'chýba EIC' }); continue; }
    if (!/^24[A-Z][0-9A-Z]{10,}$/i.test(eic)) console.warn(`  ⚠️ ${meno}: EIC "${eic}" nevyzerá štandardne (24X…).`);
    out.push({ meno, eic });
  }
  return out;
}

/** Zabezpečí agregačný blok (idempotentne): ak riadok v tabuľke existuje, preskočí; inak vytvorí.
 * Vráti true, ak je blok k dispozícii (existujúci alebo vytvorený). */
async function zabezpecBlok(page: Page, blok: string, outDir: string): Promise<boolean> {
  const existuje = await page.getByRole('row', { name: new RegExp(escRe(blok), 'i') }).first().isVisible().catch(() => false);
  if (existuje) { console.log(`Blok "${blok}" už existuje – preskakujem vytvorenie.`); return true; }
  try {
    console.log(`\n==== Vytváram agregačný blok: ${blok} ====`);
    const otvorene = await klikniDefensive(page, {
      hintids: ['contractFinanceData_agregacia_agregacnyBlok_grid_add'],
      texty: [/Pridať agregačný blok/i, /Pridať blok/i],
      popis: 'Pridať agregačný blok',
    });
    if (!otvorene) { await dumpDiagnostiku(page, outDir, 'blok-add-nenajdene'); throw new Error('Tlačidlo "Pridať agregačný blok" sa nenašlo.'); }
    await page.waitForTimeout(1200);
    await vypisHintidy(page, 'podformulár BLOK');
    if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'subform-blok');
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
    console.log(`Agregačný blok "${blok}" vytvorený.`);
    return true;
  } catch (e: any) {
    if (jeDuplicita(e.message)) { console.log(`Blok "${blok}" už existuje (${e.message}).`); await zrusPodformular(page); return true; }
    await dumpDiagnostiku(page, outDir, 'blok-chyba');
    await zrusPodformular(page);
    return false;
  }
}

/** Spracuje jednu dávku (jeden blok): zoskupí ľudí podľa mena (JEDNO auto/osoba, číslované OM pri
 * opakovaní) a naviaže ich EIC na daný blok. Chyby idú do reportu, beh nezhadzujú. */
async function spracujDavku(page: Page, blok: string, riadky: ZakaznikFlexibility[], outDir: string, report: ZaznamReportu[]): Promise<void> {
  const skupiny = new Map<string, string[]>();
  for (const { meno, eic } of riadky) {
    if (!skupiny.has(meno)) skupiny.set(meno, []);
    const arr = skupiny.get(meno)!;
    if (arr.includes(eic)) { report.push({ blok, meno, eic, stav: 'PRESKOČENÝ', dovod: 'duplicitný riadok (rovnaké meno+EIC) v CSV' }); continue; }
    arr.push(eic);
  }
  const opakovane = [...skupiny.values()].filter((a) => a.length > 1).length;
  console.log(`\nDávka "${blok}": ${skupiny.size} osôb (z toho ${opakovane} s viacerými OM).`);

  for (const [meno, eics] of skupiny) {
    if (page.isClosed()) { console.error('  Prehliadač zatvorený – končím dávku.'); break; }
    const nazovAuto = `${meno} auto`;
    const viacOM = eics.length > 1;
    console.log(`\n=== [${blok}] ${meno} — ${eics.length} OM, auto "${nazovAuto}" ===`);

    // TECHNOLÓGIA (raz na osobu). Duplicita → pokračuj na OM.
    try {
      console.log('  1) Technológia (auto)...');
      await pridajTechnologiu(page, nazovAuto, outDir);
      console.log(`     Technológia "${nazovAuto}" uložená.`);
    } catch (e: any) {
      if (jeDuplicita(e.message)) { console.log(`     Auto "${nazovAuto}" už existuje – pokračujem na OM.`); await zrusPodformular(page); }
      else {
        console.error(`     CHYBA technológie (${meno}): ${e.message}`);
        await dumpDiagnostiku(page, outDir, `technologia-${meno}`);
        await zrusPodformular(page);
        for (const eic of eics) report.push({ blok, meno, eic, stav: 'CHYBA', dovod: `technológia zlyhala: ${e.message}` });
        if (page.isClosed() || /has been closed/i.test(e.message)) break;
        continue;
      }
    }

    // ODBERNÉ MIESTA (EIC) – jedno na každý riadok osoby, naviazané na blok tejto dávky.
    for (let i = 0; i < eics.length; i++) {
      if (page.isClosed()) break;
      const eic = eics[i];
      const nazovOm = viacOM ? `${meno} ${i + 1}` : meno;
      try {
        console.log(`  2.${i + 1}) EIC ${eic} → OM "${nazovOm}"...`);
        await pridajEic(page, eic, nazovOm, nazovAuto, blok, outDir);
        console.log(`      Uložené: EIC "${eic}" (OM "${nazovOm}").`);
        report.push({ blok, meno, eic, stav: 'OK', dovod: `OM "${nazovOm}" → auto "${nazovAuto}"` });
      } catch (e: any) {
        const dup = jeDuplicita(e.message);
        console.error(`      ${dup ? 'DUPLICITA' : 'CHYBA'} EIC ${eic}: ${e.message}`);
        report.push({ blok, meno, eic, stav: dup ? 'DUPLICITA' : 'CHYBA', dovod: `OM "${nazovOm}": ${e.message}` });
        if (!dup) await dumpDiagnostiku(page, outDir, `eic-${meno}-${i + 1}`);
        if (page.isClosed() || /has been closed/i.test(e.message)) { console.error('  Prehliadač zatvorený – končím.'); break; }
        await zrusPodformular(page);
      }
    }
  }
}

/* ================================ TEST ================================ */

test('Agregácia flexibility – hromadný zápis z CSV (jedna Zmena zmluvy)', async ({ page }) => {
  test.setTimeout(0); // Odstránený časovač celého skriptu
  page.on('dialog', d => d.accept().catch(() => {})); // natívne prompty (napr. "opustiť stránku?")

  // Prihlasovacie údaje sa čítajú z .env / premenných prostredia (nie z kódu).
  if (!CONFIG.okte.username || !CONFIG.okte.password) {
    throw new Error('Chýbajú OKTE prihlasovacie údaje. Vytvor súbor .env s OKTE_USER a OKTE_PASSWORD (pozri .env.example) alebo ich nastav cez $env:. Súbor .env do gitu NEDÁVAJ.');
  }

  const outDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const report: ZaznamReportu[] = [];

  /* ---------- 1. NAČÍTANIE VŠETKÝCH DÁVOK (CSV → blok) ---------- */
  const davky: { blok: string; riadky: ZakaznikFlexibility[] }[] = [];
  for (const d of CONFIG.agregacia.davky) {
    const cesta = path.join(process.cwd(), d.csv);
    if (!fs.existsSync(cesta)) {
      console.warn(`  ⚠️ CSV "${d.csv}" (blok "${d.blok}") neexistuje – dávku preskakujem.`);
      continue;
    }
    const riadky = nacitajCsv(cesta, d.blok, report);
    console.log(`Dávka "${d.blok}" (${d.csv}): ${riadky.length} riadkov na zápis.`);
    if (riadky.length > 0) davky.push({ blok: d.blok, riadky });
  }
  const totalNaZapis = davky.reduce((s, d) => s + d.riadky.length, 0);
  console.log(`Spolu na zápis: ${totalNaZapis} riadkov v ${davky.length} dávk(e/ach). Preskočených z CSV: ${report.length}.`);
  if (totalNaZapis === 0) {
    console.log('Žiadne platné riadky na zápis – končím.');
    zapisReport(report, outDir);
    return;
  }

  /* ---------- 2. PRIHLÁSENIE (rovnaká logika ako ZPÚ) ---------- */
  const jePrihlaseny = (u: URL) => !u.href.includes('/public') && !u.href.includes('/auth/');

  const vstupnaUrl = CONFIG.okte.mojeZmluvyUrl || CONFIG.okte.zmluvaUrl;
  await page.goto(vstupnaUrl).catch(() => {}); // chránená stránka = spustí login, ak treba
  await page.waitForLoadState('networkidle').catch(() => {});

  if (jePrihlaseny(new URL(page.url()))) {
    console.log('OKTE: už prihlásený (profil) – preskakujem login.');
  } else {
    console.log('OKTE: prihlasujem sa...');
    try {
      const prihlasitBtn = page.getByRole('button', { name: 'Prihlásiť sa' });
      if (await prihlasitBtn.isVisible().catch(() => false)) await prihlasitBtn.click({ timeout: 8000 });
      await page.getByLabel('Prihlasovacie meno').fill(CONFIG.okte.username, { timeout: 8000 });
      await page.getByLabel('Heslo', { exact: true }).fill(CONFIG.okte.password, { timeout: 8000 });
      await page.getByRole('button', { name: 'Prihlásenie' }).click({ timeout: 8000 });
    } catch {
      console.log('\nDokonči prihlásenie RAZ ručne (Povoliť → meno+heslo → Prihlásenie). Profil si to zapamätá.');
    }
    await page.waitForURL(jePrihlaseny, { timeout: 300000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  page.setDefaultTimeout(20000);

  /* ---------- 3. VÝBER SUBJEKTU ---------- */
  const subjektDropdown = page.locator('.ng-select.ng-invalid').first();
  if (await subjektDropdown.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)) {
    await subjektDropdown.click();
    await page.getByRole('option', { name: CONFIG.okte.subjekt }).click();
    const okBtn = page.getByRole('button', { name: 'OK', exact: true });
    if (await okBtn.isVisible().catch(() => false)) await okBtn.click();
    console.log(`Aktívny subjekt: ${CONFIG.okte.subjekt}`);
  } else {
    console.log('  Subjektový dropdown sa neobjavil – pokračujem (asi je už nastavený).');
  }

  // DEBUG_NAV=1 → po prihlásení odfotí menu (n: som prihlásený? ako sa volajú položky?).
  // Pošli mi diag-po-prihlaseni-hintids.txt + .png a doladím navigáciu presne.
  if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'po-prihlaseni');

  /* ---------- 4. OTVORENIE ZMLUVY + "ZMENA ZMLUVY" ---------- */
  console.log('Prechádzam na zoznam zmlúv...');
  await page.waitForTimeout(1500);

  if (CONFIG.okte.mojeZmluvyUrl) {
    await page.goto(CONFIG.okte.mojeZmluvyUrl).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  } else {
    // Fallback (ak nie je URL): "Zmluvy" je v strome iba <span> (rozbaľovací uzol), nie link.
    // Klik naň ho rozbalí, potom klik na podpoložku so zoznamom zmlúv.
    const mojeVidno = await page.getByText(/Moje zmluvy|Zoznam zml/i).first().isVisible().catch(() => false);
    if (!mojeVidno) {
      await page.locator('span.app-left-menu-item.contract', { hasText: /^Zmluvy$/ }).first()
        .click().catch(() => klikniMenu(page, ['Zmluvy', /^Zmluvy$/i], outDir, 'Zmluvy (rozbalenie)'));
      await page.waitForTimeout(1000);
    }
    if (!(await klikniMenu(page, ['Moje zmluvy', /Moje zmluvy/i, /Zoznam zml[úu]v/i, /Vyhľadanie zml/i], outDir, 'Zoznam zmlúv'))) {
      throw new Error('Do zoznamu zmlúv som sa nedostal (pozri diag-menu-*). Nastav CONFIG.okte.mojeZmluvyUrl.');
    }
  }
  await page.waitForTimeout(3000);
  if (process.env.DEBUG_NAV === '1') await dumpDiagnostiku(page, outDir, 'zoznam-zmluv');

  // Zmluvu identifikuj podľa čísla (unikátne), inak podľa názvu.
  const cielRe = CONFIG.okte.cisloZmluvy
    ? new RegExp(escRe(CONFIG.okte.cisloZmluvy), 'i')
    : CONFIG.okte.nazovZmluvy;
  console.log(`Hľadám zmluvu ${CONFIG.okte.cisloZmluvy || CONFIG.okte.nazovZmluvy}...`);

  // Vyhľadávacia stránka niekedy naplní grid až po kliknutí na "Vyhľadať".
  const zmluvaRiadok = page.getByRole('row', { name: cielRe }).first();
  if (!(await zmluvaRiadok.isVisible().catch(() => false))) {
    const hladat = page.getByRole('button', { name: /Vyhľadať|Hľadať|Filtrovať|Zobraziť/i }).first();
    if (await hladat.isVisible().catch(() => false)) {
      console.log('  Grid prázdny – klikám "Vyhľadať".');
      await hladat.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }

  console.log('Otváram zmluvu a hľadám "Zmena zmluvy"...');
  if (!(await otvorZmluvu(page, cielRe, outDir))) {
    // "Zmena zmluvy" nie je priamo → skús kontextové (pravý klik) alebo kebab/akcie menu riadku.
    console.log('  "Zmena zmluvy" nie je priamo viditeľná – skúšam kontextové/akcie menu...');
    if (await zmluvaRiadok.isVisible().catch(() => false)) {
      await zmluvaRiadok.click({ button: 'right' }).catch(() => {});
      await page.waitForTimeout(700);
    }
    if (!(await klikniDefensive(page, { texty: ['Zmena zmluvy', /Zmena zmluvy/i], popis: 'Zmena zmluvy (kontext. menu)' }))) {
      await klikniDefensive(page, { texty: [/Akcie/i, /Možnosti/i, '⋮', '…', '...'], popis: 'Akcie/kebab' });
      await page.waitForTimeout(700);
      if (!(await klikniDefensive(page, { texty: ['Zmena zmluvy', /Zmena zmluvy/i], popis: 'Zmena zmluvy (po akciách)' }))) {
        await dumpDiagnostiku(page, outDir, 'zmena-zmluvy-nenajdena');
        throw new Error('Tlačidlo/akcia "Zmena zmluvy" sa nenašla (pozri diag-zmena-zmluvy-nenajdena*).');
      }
    }
  } else {
    if (!(await klikniDefensive(page, {
      hintids: ['zmluvaDetail_startEditProcess_PORTAL'],
      texty: ['Zmena zmluvy', /Zmena zmluvy/i],
      popis: 'Zmena zmluvy',
    }))) {
      await dumpDiagnostiku(page, outDir, 'zmena-zmluvy-nenajdena');
      throw new Error('Tlačidlo "Zmena zmluvy" sa nenašlo (pozri diagnostiku).');
    }
  }
  await page.waitForTimeout(1500);
  await zavriDialog(page); // prípadný potvrdzovací dialóg "Naozaj začať zmenu zmluvy?"
  await checkOkteChyba(page, 'otvorenie Zmeny zmluvy');

  /* ---------- 5. DOSIAHNUTIE SEKCIE AGREGÁCIA (editačný proces) ---------- */
  if (!(await dojdiNaAgregaciu(page, outDir))) {
    throw new Error('Nepodarilo sa dostať do sekcie Agregácia. Pozri diag-nedosiahnuta-agregacia* (najmä -hintids.txt).');
  }
  console.log('Som v sekcii Agregácia.');

  /* ---------- 6+7. SPRACOVANIE DÁVOK (každá dávka = svoj blok) ---------- */
  for (const d of davky) {
    if (page.isClosed()) { console.error('Prehliadač zatvorený – končím.'); break; }
    console.log(`\n########## DÁVKA: ${d.blok} (${d.riadky.length} riadkov) ##########`);
    const blokOk = await zabezpecBlok(page, d.blok, outDir);
    if (!blokOk) {
      console.error(`  Blok "${d.blok}" sa nepodarilo zabezpečiť – dávku preskakujem.`);
      for (const r of d.riadky) report.push({ blok: d.blok, meno: r.meno, eic: r.eic, stav: 'CHYBA', dovod: 'blok sa nepodarilo vytvoriť' });
      continue;
    }
    await spracujDavku(page, d.blok, d.riadky, outDir, report);
  }

  const uspesne = report.filter(r => r.stav === 'OK').length;
  if (AUTO_SUBMIT && uspesne > 0 && !page.isClosed()) {
    console.log(`\n==== Odosielam ZMENU zmluvy (${uspesne} nových EIC) ====`);
    const odoslane = await odosliZmenu(page, outDir);
    if (!odoslane) {
      console.warn('  POZOR: odosielacie tlačidlo sa nenašlo – zmenu dokonči/odošli ručne (pozri diagnostiku).');
    }
  } else if (!AUTO_SUBMIT) {
    console.log('\nAUTO_SUBMIT=0 → zmena NIE JE odoslaná. Skontroluj a odošli ručne ("Uložiť a ďalej" → odoslať).');
  } else {
    console.log('\nŽiadny úspešný zápis – zmenu neodosielam.');
  }

  /* ---------- 9. REPORT + kontrola ---------- */
  zapisReport(report, outDir);
  await nechajOtvorene(page);

  const chyby = report.filter(r => r.stav === 'CHYBA');
  if (chyby.length > 0) {
    throw new Error(`${chyby.length} zápis(ov) zlyhalo: ${chyby.map(c => `${c.meno} (${c.eic})`).join(', ')}`);
  }
});