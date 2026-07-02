import { test as base, chromium, type Page, type BrowserContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { PDFDocument } from 'pdf-lib';
// @ts-ignore - pdf-parse v1 nemá typy; import cez lib (bez test kódu v index.js)
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * Perzistentný Chrome profil – kľúč k tomu, aby popup "Prístup k iným aplikáciám"
 * neotravoval každý beh. Pri PRVOM spustení klikneš Povoliť raz; profil si to zapamätá
 * a každý ďalší beh je už plne automatický. Cert vyberá Windows policy (channel: 'chrome').
 */
const PROFILE_DIR = path.join(process.cwd(), '.chrome-profile-okte');

const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      chromiumSandbox: true, // reálny Chrome na Windowse → sandbox funguje, zmizne pruh "--no-sandbox"
    });
    await use(context);
    await context.close().catch(() => {});
  },
  page: async ({ context }, use) => {
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

/**
 * KONFIGURÁCIA
 * OKTE = 4-krokový wizard (participant-create-simple): Účastník trhu, Zmluvné údaje,
 * Výrobné zariadenie (EIC), Kontrola. Heslo k OKTE: CONFIG.okte.password.
 * Certifikát (neexportovateľný, na tokene) vyberá Windows policy AutoSelectCertificateForUrls
 * + reálny Chrome (channel: 'chrome'). Prihlásenie do OKTE preto nerieši .pfx.
 */
const DRY_RUN = process.env.DRY_RUN === '1';        // vyplní krok 1, ale neodošle ("Uložiť a ďalej")
const KEEP_OPEN = process.env.KEEP_OPEN !== '0';    // po dobehnutí necháva prehliadač otvorený

const _dnes = new Date();
const DATUM_DNES = `${String(_dnes.getDate()).padStart(2, '0')}.${String(_dnes.getMonth() + 1).padStart(2, '0')}.${_dnes.getFullYear()}`;

const CONFIG = {
  docuseal: {
    loginUrl: 'https://sign.wattiva.eu/sign_in',
    submissionsUrl: 'https://sign.wattiva.eu/submissions',
    email: process.env.DS_EMAIL || 'agreements@wattiva.com',
    password: process.env.DS_PASSWORD || '5BBv91aKay5uRv',
  },
  okte: {
    publicUrl: 'https://edc.okte.sk/portal/ui/public',
    zmluvaUrl: 'https://edc.okte.sk/portal/ui/zmluva/zalozenie-zmluvy',
    username: process.env.OKTE_USER || 'martin.gonda@wattiva.eu',
    password: process.env.OKTE_PASSWORD || 'VoltiaTechno2026/',
    subjekt: 'Voltia Technologies s.r.o.',
  },
  // Kontakt 1 = firemný (Martin Gonda). Kontakt 2 = údaje výrobcu.
  firemnyKontakt: {
    meno: 'Martin',
    priezvisko: 'Gonda',
    email: 'edc@wattiva.eu',
    telefon: '+421 948 297 937',
  },
  cestneVyhlasenie: {
    // true = "Mám povolenie URSO" (value=YES); false = "Nemám" (value=NO).
    maPovolenieUrso: true,
    datumPodpisu: DATUM_DNES, // default = dnešok; uprav ak treba reálny dátum
  },
  // KROK 2 – Zmluvné údaje.
  krok2: {
    poznamka: '', // voliteľné
    zmluvneVztahy: 'gonda', // "Zmluvné vzťahy" = Martin Gonda (možnosti sú osoby; všetky kontakty = Gonda)
    osoba: /gonda/i, // Osoba poverená na komunikáciu aj na podpis = Martin Gonda
  },
  // KROK 3 – Výrobné zariadenie (FVE do 11 kW).
  krok3: {
    nazovSuffix: ' FVE', // názov zariadenia = meno + " FVE"; generátor = meno
    triedaTdve: /fve/i, // Trieda TDVE = FVE
    stavZariadenia: /prev[aá]dzke/i, // Stav = V prevádzke
    meranieNaSvorkach: true,
    lokalnyZdroj: false,
    apAddrSame: true, // adresa prevádzky = adresa sídla
    podpora: 'anoBezPodpory', // Priznaná podpora = Bez podpory
    // Investičná podpora (povinné polia, nie sú v zmluvách) – natívne hodnoty.
    investicnaPodpora: { intenzita: '0', pomoc: '0', naklady: '9000' }, // % / EUR / EUR
    // Dropdowny generátora/pripojenia:
    generatorTypTechnologie: 'Slnečná - Fotovoltika', // všeobecná FVE (alebo "...Klasický kremík")
    generatorTypPaliva: 'OZE - Teplo - Slnečné', // jediná možnosť
    typPripojenia: 'Rozhranie zariadenia na výrobu elektriny a sústavy', // prvá možnosť
  },
  maxVykonKw: 11,
};

type TypDokumentu = 'vyhlasenie' | 'splnomocnenie' | 'zmluva';

/** Profil jedného zákazníka poskladaný z viacerých DocuSeal submissionov. */
interface ProfilZakaznika {
  meno: string;
  rawAdresa?: string;
  vykonKw?: string;
  datumZacatia?: string; // len pre vylúčenie z heuristiky dátumu narodenia
  emailZakaznika?: string;
  telefonZakaznika?: string;
  datumNarodenia?: string;
  maSplnomocnenie: boolean;
  maVyhlasenie: boolean;
  maZmluva: boolean;
  // Stiahnuté + vytlačené súbory (všetky 3).
  subory: { vyhlasenie?: string; splnomocnenie?: string; zmluva?: string };
  parsedMeno?: { titul: string; meno: string; priezvisko: string };
  parsedAdresa?: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string };
  // Údaje vytiahnuté z PDF (čestné vyhlásenie + splnomocnenie) pre krok 1 a 3.
  pdf?: {
    eicOdber: string; eicDodavka: string; datumZacatiaVyroby: string;
    kataster: string; parcela: string;
    datumCestne: string; datumSplnomocnenie: string;
    adrVyrobne?: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string };
  };
}

/** Záznam do záverečného reportu. */
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

/* ----------------------------- POMOCNÉ FUNKCIE ----------------------------- */

/** "Vytlačí" PDF – flatten formulárových polí. POZOR: re-save zruší kryptografický podpis. */
async function printniPdf(vstup: string, vystup: string): Promise<boolean> {
  try {
    const bytes = fs.readFileSync(vstup);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    try {
      pdf.getForm().flatten();
    } catch {
      /* dokument nemá formulárové polia */
    }
    fs.writeFileSync(vystup, await pdf.save());
    return true;
  } catch {
    return false;
  }
}

/** Stiahne aktuálne otvorený dokument cez tlačidlo DOWNLOAD. 2 pokusy, ŽIADNE fake PDF. */
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

/** Rozdelí "Ing. Mgr. Ján Novák" na titul / meno / priezvisko. */
function rozdelMeno(cele: string) {
  const casti = cele.trim().split(/\s+/);
  const tituly: string[] = [];
  let i = 0;
  while (i < casti.length && casti[i].includes('.')) tituly.push(casti[i++]);
  return { titul: tituly.join(' '), meno: casti[i] || '', priezvisko: casti.slice(i + 1).join(' ') };
}

/** Rozdelí "Družstevná 1953/63, 952 01 Vráble, SK" na ulicu / súpisné / orientačné / PSČ / mesto. */
function rozdelAdresu(raw?: string) {
  const out = { ulica: '', supisneCislo: '', orientacneCislo: '', psc: '', mesto: '' };
  if (!raw) return out;
  const ignoruj = ['SK', 'SLOVAKIA', 'SLOVENSKO'];
  const casti = raw.split(',').map(c => c.trim()).filter(c => c && !ignoruj.includes(c.toUpperCase()));
  if (casti[0]) {
    const tokeny = casti[0].split(/\s+/);
    const cislo = tokeny.pop() || '';
    out.ulica = tokeny.join(' ');
    const [sup, orient] = cislo.split('/'); // "1953/63" -> súpisné 1953, orientačné 63
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

/** Bezpečný názov súboru z mena zákazníka. */
function bezpecneMeno(meno: string): string {
  return meno.replace(/[\\/:*?"<>|]/g, '').trim();
}

/** Výkon v kW ako číslo (zvládne "5,4 kW" aj "5.4"). */
function vykonNaCislo(v?: string): number | null {
  if (!v) return null;
  const n = parseFloat(v.replace(',', '.').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

/** Slovo začína malým písmenom? (signál nesprávne zadaného mena – malé písmená/bez diakritiky) */
function slovoZacinaMalym(w?: string): boolean {
  const p = (w || '').trim()[0] || '';
  return p !== '' && p === p.toLocaleLowerCase('sk') && p !== p.toLocaleUpperCase('sk');
}

/** Je meno zle naformátované? (napr. "tomas brinza" – malé písmená/bez diakritiky → OKTE neprijme)
 * Spoľahlivo deteguje malé písmená na začiatku slov. Chýbajúcu diakritiku na inak správne
 * napísanom mene (napr. "Tomas Brinza") odhaliť nevieme – to treba opraviť pri zdroji. */
function menoZleNaformatovane(clovek: ProfilZakaznika): boolean {
  const slova = [clovek.parsedMeno?.meno, clovek.parsedMeno?.priezvisko].filter(Boolean) as string[];
  if (!slova.length) return false; // chýbajúce meno rieši iná kontrola
  return slova.some(slovoZacinaMalym);
}

function validuj(clovek: ProfilZakaznika): { ok: boolean; dovody: string[] } {
  const d: string[] = [];

  // Trojica dokumentov v DocuSeale – ak nie je kompletná, vôbec sa nesťahuje.
  const maTrojicu = clovek.maSplnomocnenie && clovek.maVyhlasenie && clovek.maZmluva;
  if (!maTrojicu) {
    const chyba: string[] = [];
    if (!clovek.maSplnomocnenie) chyba.push('Splnomocnenie');
    if (!clovek.maVyhlasenie) chyba.push('Čestné vyhlásenie');
    if (!clovek.maZmluva) chyba.push('Zmluva');
    d.push(`nekompletná trojica dokumentov (chýba: ${chyba.join(', ')}) – nesťahujem`);
  } else {
    // Trojica je kompletná → over, že sa všetky 3 aj stiahli.
    if (!clovek.subory.vyhlasenie) d.push('nestiahnuté: Čestné vyhlásenie');
    if (!clovek.subory.splnomocnenie) d.push('nestiahnuté: Splnomocnenie');
    if (!clovek.subory.zmluva) d.push('nestiahnuté: Zmluva');
  }

  if (!clovek.parsedMeno?.meno) d.push('chýba meno');
  if (!clovek.parsedMeno?.priezvisko) d.push('chýba priezvisko');
  if (!clovek.datumNarodenia) d.push('chýba dátum narodenia');

  // Nesprávny formát mena (malé písmená/bez diakritiky) → OKTE neprijme, radšej preskočiť.
  if (menoZleNaformatovane(clovek)) {
    d.push(`nesprávny formát mena (malé písmená/bez diakritiky): "${clovek.meno}" – OKTE neprijme, oprav pri zdroji`);
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

/** Správne zrušenie rozpracovaného zápisu – funguje na ktoromkoľvek kroku:
 * 1) zatvorí prípadný chybový/info dialóg,
 * 2) krok 3: zruší otvorený podformulár zariadenia jeho vlastným „Zrušiť" (grid_kontakty_cancel),
 * 3) zruší celý proces ZPU tlačidlom „Zrušiť proces" (+ potvrdí). */
async function zrusProces(page: Page) {
  try {
    if (page.isClosed()) return;
    // 1) Zatvor prípadný chybový/info dialóg, nech sa dá klikať na tlačidlá.
    await zavriDialog(page);

    // 2) Krok 3: ak je otvorený podformulár zariadenia, najprv ho zruš jeho „Zrušiť".
    const zrusZar = page.locator('[hintid="contractFinanceDataVyrobca11kw_grid_kontakty_cancel"]');
    if (await zrusZar.isVisible().catch(() => false)) {
      await zrusZar.click().catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
      await zavriDialog(page); // prípadný potvrdzovací dialóg podformulára
      console.log('  Zrušený podformulár zariadenia (krok 3).');
    }

    // 3) Zruš celý proces ZPU (na ktoromkoľvek kroku) + potvrď.
    const zrusProc = page.getByRole('button', { name: 'Zrušiť proces' });
    if (await zrusProc.isVisible().catch(() => false)) {
      await zrusProc.click().catch(() => {});
      await page.waitForTimeout(700).catch(() => {});
      const dialog = page.getByRole('dialog');
      if (await dialog.isVisible().catch(() => false)) {
        await dialog.getByRole('button', { name: /OK|Áno|Potvrd|Zrušiť/i }).first().click().catch(() => {});
      }
      await page.waitForTimeout(1000).catch(() => {});
      console.log('  Zrušený proces ZPU.');
    }
  } catch {
    /* ignor */
  }
}

/** Ak je otvorený nejaký modálny dialóg, zatvorí ho (OK/Zatvoriť/Áno…). Vráti true, ak nejaký zavrel. */
async function zavriDialog(page: Page): Promise<boolean> {
  const dialog = page.getByRole('dialog');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  for (const meno of ['OK', 'Zatvoriť', 'Zavrieť', 'Rozumiem', 'Áno', 'Pokračovať']) {
    const b = dialog.getByRole('button', { name: meno });
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(400).catch(() => {}); return true; }
  }
  await dialog.getByRole('button').first().click().catch(() => {}); // fallback: prvé tlačidlo
  await page.waitForTimeout(400).catch(() => {});
  return true;
}

/** Prečíta text otvoreného modálu (ak nejaký je), inak null. */
async function precitajDialog(page: Page): Promise<string | null> {
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.isVisible().catch(() => false))) return null;
  const t = (await dialog.innerText().catch(() => '')).trim();
  return t || '(prázdny dialóg)';
}

/** Vyzerá text dialógu ako chyba/odmietnutie? */
function jeChybovyText(t: string): boolean {
  return /neexist|nenájd|nenajd|nie je|nespr[áa]vn|chyb|zlyhal|nepodaril|mus[íi]te|povinn|neplatn|invalid|error|nemo[žz]no|u[žz] existuje|duplicit|nevypln|ch[ýy]ba/i.test(t);
}

/** Je odmietnutie OKTE iba DUPLICITA (EIC/zariadenie už v systéme existuje), nie reálna chyba?
 * Typické hlášky: „už je zaradené v aktívnom odberateľovi", „neplatné pre aktívneho odberateľa",
 * „už existuje". Takýto záznam ide do reportu ako DUPLICITA a NEzhodí test (červenú). */
function jeDuplicita(msg: string): boolean {
  return /u[žz] je zaraden|neplatn[ée] pre akt[íi]vneho odberate[ľl]a|u[žz] existuje|duplicit|u[žz] je registrov/i.test(msg || '');
}

/** Checkpoint: ak OKTE vyhodil chybový dialóg (napr. „EIC neexistuje"), zatvor ho a hoď výnimku
 * (per-user catch ju zachytí → zruší proces → pokračuje ďalším užívateľom). */
async function checkOkteChyba(page: Page, kde: string): Promise<void> {
  const text = await precitajDialog(page);
  if (text && jeChybovyText(text)) {
    await zavriDialog(page); // klikni OK, nech sa dá zrušiť proces
    // vyčisti text dialógu od popiskov tlačidiel (close/OK/Zatvoriť...)
    const cisty = text.replace(/\b(close|OK|Zatvoriť|Zavrieť|Áno|Nie|×|✕|✖)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`OKTE odmietlo (${kde}): ${cisty.slice(0, 220)}`);
  }
}

/** Zapíše report do konzoly (tabuľka) aj na disk (JSON + TXT). */
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
  console.log(`\nReport uložený do: ${outDir}`);
}

/**
 * POISTKA pri plnení polí: pole zacieli cez hintid (+ index pri opakovaných),
 * krátko počká, VYČISTÍ ho (zruší autofill) a vyplní. Ak pole NIE JE prítomné
 * (napr. krok bol preskočený / iný layout), nezhodí beh – vráti false.
 */
async function vyplnHintid(
  page: Page,
  hintid: string,
  hodnota: string,
  index = 0,
): Promise<boolean> {
  const loc = page.locator(`[hintid="${hintid}"]`).nth(index);
  try {
    await loc.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return false; // pole tu nie je
  }
  // Disabled/readonly pole sa zvyčajne dopĺňa automaticky -> preskoč (nebúchaj doň fill).
  if (!(await loc.isEditable().catch(() => false))) {
    return false;
  }
  await loc.fill(''); // zmaž prípadný autofill / draft
  await loc.fill(hodnota);
  return true;
}

/** Poistka proti preskočeniu kroku: krok 1 spoznáme podľa poľa "meno" (vráti 1),
 * inak 0 (iný/neznámy krok). */
async function zistiKrok(page: Page): Promise<number> {
  if (await page.locator('[hintid="participantCreateSimple_meno"]').isVisible().catch(() => false)) return 1;
  return 0;
}

/** Necháva prehliadač OTVORENÝ na kontrolu, ručne vypínané (timeout 0) */
async function nechajOtvorene(page: Page) {
  if (!KEEP_OPEN || page.isClosed()) return;
  console.log('\nPrehliadač nechávam OTVORENÝ na kontrolu. Zavri ho ručne krížikom, keď budeš chcieť (žiadny časovač).');
  // timeout: 0 znamená nekonečno - bude čakať kým používateľ ručne nezavrie prehliadač
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
}

/** Vyberie možnosť v ng-select (podľa hintid). Z viacerých zhôd vyberie NAJKRATŠIU
 * (základnú možnosť, nie dlhší podtyp). Skúsi 2× (prvý dropdown niekedy mešká). */
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

/** Nastaví checkbox (podľa hintid) na požadovaný stav. */
async function zaskrtni(page: Page, hintid: string, chciZaskrtnute = true): Promise<boolean> {
  const cb = page.locator(`[hintid="${hintid}"]`);
  if (!(await cb.isVisible().catch(() => false))) return false;
  const je = await cb.isChecked().catch(() => false);
  if (je !== chciZaskrtnute) await cb.click({ force: true }).catch(() => {});
  return true;
}

/** Prečíta text z PDF (a uloží ho do .txt pre kontrolu). Prázdny string ak zlyhá. */
async function citajPdfText(cesta: string | undefined, outDir: string, tag: string): Promise<string> {
  if (!cesta || !fs.existsSync(cesta)) return '';
  try {
    const res = await pdfParse(fs.readFileSync(cesta));
    const text: string = (res && res.text) || '';
    fs.writeFileSync(path.join(outDir, `pdftext-${tag}.txt`), text, 'utf-8');
    return text;
  } catch (e: any) {
    console.warn(`  PDF parse zlyhal (${tag}): ${e.message}`);
    return '';
  }
}

/** Je reťazec vo formáte dátumu DD.MM.YYYY? */
function jeDatum(s: string): boolean {
  return /^\d{1,2}\.\d{1,2}\.\d{4}$/.test((s || '').trim());
}

/** Vytiahne údaje z PDF čestného vyhlásenia (+ dátum DŇA zo splnomocnenia).
 * POZOR: pdf-parse vráti najprv VŠETKY názvy polí a až na konci VŠETKY hodnoty
 * (dvojstĺpcová tabuľka) – preto hodnoty čítame podľa PORADIA, nie podľa názvov.
 * Poradie hodnôt hneď za druhým EIC (čestné vyhlásenie):
 * [0]=dátum začatia, [1]=výkon, [2]=adresa výrobne, [3]=kataster, [4]=parcela, [5]=miesto, [6]=DŇA …
 */
async function extrahujPdf(clovek: ProfilZakaznika, outDir: string): Promise<void> {
  const tag = bezpecneMeno(clovek.meno);
  const cv = await citajPdfText(clovek.subory.vyhlasenie, outDir, `cestne-${tag}`);
  const spl = await citajPdfText(clovek.subory.splnomocnenie, outDir, `splnom-${tag}`);

  // EIC tokeny (24Z…) – v PDF len ako hodnoty, v poradí odber, dodávka.
  const eics = cv.match(/24Z[0-9A-Z]{10,18}/gi) || [];
  const eicOdber = eics[0] || '';
  const eicDodavka = eics[1] || '';

  // Hodnoty za DRUHÝM EIC, čítané podľa poradia.
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

  // Poistky cez globálne dátumy, ak by poradie zlyhalo (prvý = začatie, posledný = DŇA).
  const datumyCv = cv.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || [];
  if (!jeDatum(datumZacatiaVyroby) && datumyCv[0]) datumZacatiaVyroby = datumyCv[0];
  if (!jeDatum(datumCestne) && datumyCv.length) datumCestne = datumyCv[datumyCv.length - 1];

  // Splnomocnenie: DŇA = posledný dátum, ALE vylúč dátum narodenia (poznáme ho z DocuSealu).
  const normD = (s: string) => (s || '').replace(/\s/g, '').split('.').map(x => String(parseInt(x, 10) || x)).join('.');
  const dnNarod = normD(clovek.datumNarodenia || '');
  const datumySpl = (spl.match(/\d{1,2}\.\d{1,2}\.\d{4}/g) || []).filter(d => !dnNarod || normD(d) !== dnNarod);
  const datumSplnomocnenie = datumySpl.length ? datumySpl[datumySpl.length - 1] : '';

  // Adresa výrobne → rozložiť + normalizovať PSČ na "977 01".
  let adrVyrobne: { ulica: string; supisneCislo: string; orientacneCislo: string; psc: string; mesto: string } | undefined;
  if (adrRaw && /\d/.test(adrRaw)) {
    const a = rozdelAdresu(adrRaw);
    const p5 = a.psc.replace(/\s/g, '');
    adrVyrobne = { ulica: a.ulica, supisneCislo: a.supisneCislo, orientacneCislo: a.orientacneCislo, psc: p5.length === 5 ? p5.slice(0, 3) + ' ' + p5.slice(3) : a.psc, mesto: a.mesto };
  }

  clovek.pdf = { eicOdber, eicDodavka, datumZacatiaVyroby, kataster, parcela, datumCestne, datumSplnomocnenie, adrVyrobne };
  console.log(`  PDF: EIC ${eicOdber || '-'}/${eicDodavka || '-'} | začatie ${datumZacatiaVyroby || '-'} | kataster ${kataster || '-'} | parcela ${parcela || '-'} | DŇA čestné ${datumCestne || '-'} | DŇA splnom ${datumSplnomocnenie || '-'} | adr.výrobne ${adrVyrobne ? `${adrVyrobne.ulica} ${adrVyrobne.supisneCislo}, ${adrVyrobne.psc} ${adrVyrobne.mesto}` : '-'}`);
}

/** Otvorí dátumový kalendár (podľa hintid) a klikne PRVÝ klikateľný (povolený) deň.
 * Primárne bs-datepicker (ngx-bootstrap) – ak je mesiac celý disabled, klikne "next"
 * až kým nenájde povolený deň. Fallback na iné datepickery; inak uloží HTML a vráti false. */
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

  // Fallback: iné datepickery.
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
    return panel ? (panel as HTMLElement).outerHTML.slice(0, 5000) : '(kalendár sa nenašiel v DOM)';
  });
  const f = path.join(outDir, `kalendar-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
  fs.writeFileSync(f, html, 'utf-8');
  console.warn('  Neznámy datepicker – HTML kalendára uložené: ' + f);
  return false;
}

/* ================================ TEST ================================ */

test('Hromadná E2E automatizácia: DocuSeal -> UAT EDC OKTE', async ({ page }) => {
  // Zmenené na 0 – test nezlyhá na globálny časovač a počká koľko treba
  test.setTimeout(0); 

  page.on('dialog', d => d.accept().catch(() => {}));

  const downloadsDir = path.join(process.cwd(), 'downloads');
  const printDir = path.join(downloadsDir, 'print');
  const outDir = path.join(process.cwd(), 'reports');
  for (const dir of [downloadsDir, printDir, outDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const databaza = new Map<string, ProfilZakaznika>();
  const report: ZaznamReportu[] = [];

  if (DRY_RUN) console.log('DRY-RUN režim: krok 1 sa vyplní, ale neklikne "Uložiť a ďalej".\n');

  /* ========== FÁZA 1: DOCUSEAL – ZBER, DOWNLOAD, PRINT (3 súbory) ========== */
  // POISTKA: ak si profil pamätá prihlásenie, login formulár sa nezobrazí ->
  // preskoč prihlasovanie. Inak sa prihlás. (Rovnaká logika ako pri OKTE.)
  await page.goto(CONFIG.docuseal.submissionsUrl);
  await page.waitForLoadState('networkidle').catch(() => {});

  const loginViditelny = await page.getByRole('textbox', { name: 'Email' })
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (loginViditelny || /sign_in/.test(page.url())) {
    console.log('DocuSeal: prihlasujem sa...');
    if (!/sign_in/.test(page.url())) await page.goto(CONFIG.docuseal.loginUrl);
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.docuseal.email);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.docuseal.password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(u => !u.href.includes('sign_in'), { timeout: 15000 }).catch(() => {});
    await page.goto(CONFIG.docuseal.submissionsUrl);
    await page.waitForLoadState('networkidle').catch(() => {});
  } else {
    console.log('DocuSeal: už prihlásený (profil) – preskakujem login.');
  }

  // Filter "Completed" (ak je odkaz prítomný; inak ber aktuálne zobrazenie).
  const completedLink = page.getByRole('link', { name: 'Completed', exact: true });
  const maCompleted = await completedLink
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (maCompleted) {
    await completedLink.click();
    await page.waitForTimeout(2000);
  } else {
    console.warn('  Odkaz "Completed" nenájdený – pokračujem s aktuálnym zobrazením.');
  }

  /* ---------- FÁZA 1.1: pozbieraj odkazy zo VŠETKÝCH stránok („«  PAGE n  »") ---------- */
  const rozsahZoznamu = async (): Promise<string> => await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/\b\d+\s*[-–]\s*\d+\s*(?:of|z)\s*\d+\b/i);
    return m ? m[0] : '';
  }).catch(() => '');

  const vsetkyUrl: string[] = [];
  for (let strana = 1; strana <= 200; strana++) { // poistka: max 200 strán
    await page.keyboard.press('End').catch(() => {}); // ak by stránka donačítavala
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
    console.log(`  Stránka ${strana}${rng ? ` (${rng})` : ''}: +${pribudlo}, spolu ${vsetkyUrl.length} odkazov.`);

    // Koniec 1: rozsah „X-Y of Z" hovorí, že Y >= Z (posledná stránka).
    const m = rng.match(/(\d+)\s*[-–]\s*(\d+)\s*(?:of|z)\s*(\d+)/i);
    if (m && +m[2] >= +m[3]) break;
    // Koniec 2: ďalšia stránka nepribudla žiadne nové odkazy (chýba rozsah / koniec / cyklus).
    if (pribudlo === 0 && strana > 1) break;

    const next = page.getByRole('link', { name: '»' }).or(page.getByRole('button', { name: '»' })).first();
    if (!(await next.isVisible().catch(() => false))) break; // Koniec 3: žiadne „»".
    const predRng = rng;
    await next.click().catch(() => {});
    await page.waitForTimeout(1800).catch(() => {});
    // Koniec 4: po kliknutí sa rozsah nezmenil (a nejaký bol) → sme na konci.
    if (predRng && (await rozsahZoznamu()) === predRng) break;
  }
  console.log(`DocuSeal: cez všetky stránky som našiel ${vsetkyUrl.length} podpísaných dokumentov. Spájam podľa mena...`);

  // Zaznačíme si každý dokument (URL + meno + typ). Sťahovať budeme až KOMPLETNÉ trojice.
  const dokyNaStiahnutie: { url: string; meno: string; typ: TypDokumentu }[] = [];

  /* ---------- FÁZA 1.1b: otvor každý dokument (cez URL) a vytiahni metadáta ---------- */
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
    if (!meno) { console.warn('  Bez mena (FULLNAMEORCOMPANYNAME) – preskakujem dokument.'); continue; }

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
    console.log(`  Nájdené: ${NAZVY_SUBOROV[typ]} – ${meno}`);
  }

  console.log(`\nZber dokončený: ${databaza.size} unikátnych zákazníkov.`);

  /* ========== FÁZA 1.2: STIAHNUTIE LEN KOMPLETNÝCH TROJÍC ========== */
  const kompletni = new Set<string>();
  for (const [m, c] of databaza) {
    if (c.maSplnomocnenie && c.maVyhlasenie && c.maZmluva) kompletni.add(m);
  }
  const neuplni = [...databaza.keys()].filter(m => !kompletni.has(m));
  if (neuplni.length) console.log(`  Bez kompletnej trojice – NESŤAHUJEM: ${neuplni.join(', ')}`);

  const naStiahnutie = dokyNaStiahnutie.filter(d => kompletni.has(d.meno));
  console.log(`Sťahujem len kompletné trojice: ${kompletni.size} ľudí, ${naStiahnutie.length} dokumentov.`);

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
      if (!ok) console.warn(`  Print zlyhal pre ${nazov} – použijem stiahnutý originál.`);
      console.log(`  ${NAZVY_SUBOROV[d.typ]} stiahnuté: ${d.meno}`);
    } else {
      console.error(`  Stiahnutie zlyhalo: ${nazov} – súbor NEpriradený.`);
    }
  }

  /* ========== FÁZA 1.5: VALIDÁCIA + FILTER ========== */
  const naZapis: ProfilZakaznika[] = [];
  for (const clovek of databaza.values()) {
    clovek.parsedMeno = rozdelMeno(clovek.meno);
    clovek.parsedAdresa = rozdelAdresu(clovek.rawAdresa);
    const { ok, dovody } = validuj(clovek);
    if (ok) {
      naZapis.push(clovek);
    } else {
      report.push({ meno: clovek.meno, stav: 'PRESKOČENÝ', dovod: dovody.join('; ') });
      console.warn(`  PRESKOČENÝ ${clovek.meno}: ${dovody.join('; ')}`);
    }
  }
  console.log(`\nNa zápis do OKTE pripravených: ${naZapis.length} (preskočených: ${report.length})`);

  if (naZapis.length === 0) {
    console.log('\nŽiadny kompletný výrobca – OKTE fázu preskakujem.');
    zapisReport(report, outDir);
    return;
  }

  /* ========== FÁZA 2: OKTE – PRIHLÁSENIE + ZÁPIS ========== */
  const jePrihlaseny = (u: URL) => !u.href.includes('/public') && !u.href.includes('/auth/');

  // POISTKA: skús rovno chránenú stránku. Ak nás profil pamätá prihlásených,
  // login ÚPLNE PRESKOČÍME (žiadne klikanie). Inak sa prihlásime.
  await page.goto(CONFIG.okte.zmluvaUrl).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});

  if (jePrihlaseny(new URL(page.url()))) {
    console.log('OKTE: už prihlásený (profil) – preskakujem login.');
  } else {
    console.log('OKTE: prihlasujem sa...');
    try {
      // Ak sme na /public, treba kliknúť "Prihlásiť sa". Ak sme už na Keycloaku, preskočí sa.
      const prihlasitBtn = page.getByRole('button', { name: 'Prihlásiť sa' });
      if (await prihlasitBtn.isVisible().catch(() => false)) {
        await prihlasitBtn.click({ timeout: 8000 });
      }
      await page.getByLabel('Prihlasovacie meno').fill(CONFIG.okte.username, { timeout: 8000 });
      await page.getByLabel('Heslo', { exact: true }).fill(CONFIG.okte.password, { timeout: 8000 });
      await page.getByRole('button', { name: 'Prihlásenie' }).click({ timeout: 8000 });
    } catch {
      console.log('\nDokonči prihlásenie RAZ ručne: Povoliť (popup vľavo hore) → Prihlásiť sa → meno+heslo → Prihlásenie.');
      console.log('   Po úspešnom prihlásení si profil session zapamätá -> ďalší beh už login preskočí.');
    }
    await page.waitForURL(jePrihlaseny, { timeout: 300000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // Od teraz nech kroky formulára zlyhajú RÝCHLO (20s -> do reportu), nie že visia.
  page.setDefaultTimeout(20000);

  // Výber subjektu (ak Martin Gonda spravuje viac subjektov). Guard: ak sa neobjaví, pokračuj.
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
    console.log(`Aktívny subjekt: ${CONFIG.okte.subjekt}`);
  } else {
    console.warn('  Subjektový dropdown sa neobjavil – pokračujem (možno je už nastavený).');
  }

  for (const clovek of naZapis) {
    if (page.isClosed()) {
      console.error('  Prehliadač zatvorený – ukončujem loop, zvyšok neodoslaný.');
      break;
    }
    console.log(`\nOKTE zápis: ${clovek.meno}`);
    await extrahujPdf(clovek, outDir); // vytiahni EIC/kataster/parcela/dátumy z PDF
    const { meno, priezvisko } = clovek.parsedMeno!;
    const { ulica, supisneCislo, orientacneCislo, psc, mesto } = clovek.parsedAdresa!;

    try {
      await page.goto(CONFIG.okte.zmluvaUrl);
      await page.getByRole('button', { name: 'Nový účastník' }).nth(1).click();
      await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
      await page.getByText('Fyzická osoba', { exact: true }).first().click();

      /* ---------- KROK 1: ÚČASTNÍK TRHU ---------- */

      // Poistka: over, že wizard je naozaj na kroku 1 (nepreskočil sa).
      await page.waitForTimeout(1200);
      const krok = await zistiKrok(page);
      if (krok !== 1) throw new Error(`Wizard nie je na kroku 1 (zistené: ${krok || 'neznámy'}) – krok sa asi preskočil.`);

      // Istota: typ účastníka = Fyzická osoba (FO). Ak validácia pýta výber, toto ho zabezpečí.
      await page.locator('input[name="typUcastnika"][value="FO"]').check({ force: true }).catch(() => {});

      // Identita (titul je voliteľný). vyplnHintid čistí pole proti autofillu.
      await vyplnHintid(page, 'participantCreateSimple_meno', meno);
      await vyplnHintid(page, 'participantCreateSimple_priezvisko', priezvisko);
      await vyplnHintid(page, 'participantCreateSimple_datumNarodenia', clovek.datumNarodenia!);

      // Adresa sídla (súpisné + orientačné zvlášť).
      await vyplnHintid(page, 'participantCreateSimple_sidloUlica', ulica);
      await vyplnHintid(page, 'participantCreateSimple_sidloPopisneCislo', supisneCislo);
      if (orientacneCislo) await vyplnHintid(page, 'participantCreateSimple_sidloOrientacneCislo', orientacneCislo);
      await vyplnHintid(page, 'participantCreateSimple_sidloPsc', psc);
      await vyplnHintid(page, 'participantCreateSimple_sidloMesto', mesto);

      // KONTAKT 1 = Martin Gonda (firemný).
      await vyplnHintid(page, 'participantCreateSimple_kontakt_meno', CONFIG.firemnyKontakt.meno, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_priezvisko', CONFIG.firemnyKontakt.priezvisko, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_email', CONFIG.firemnyKontakt.email, 0);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_telefon', CONFIG.firemnyKontakt.telefon, 0);

      // KONTAKT 2 = výrobca. Pridaj len ak ešte neexistuje (idempotentné pri re-behu).
      const pocetKontaktov = await page.locator('[hintid="participantCreateSimple_kontakt_meno"]').count();
      if (pocetKontaktov < 2) {
        await page.getByRole('button', { name: 'Pridať kontakt' }).click();
        await page.waitForTimeout(600);
      }
      // 2. kontakt = 2. výskyt rovnakého hintid (.nth(1)).
      const ok2 = await vyplnHintid(page, 'participantCreateSimple_kontakt_meno', meno, 1);
      if (!ok2) throw new Error('2. kontakt (meno) sa nenašiel cez .nth(1) – má asi vlastný hintid.');
      await vyplnHintid(page, 'participantCreateSimple_kontakt_priezvisko', priezvisko, 1);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_email', clovek.emailZakaznika!, 1);
      await vyplnHintid(page, 'participantCreateSimple_kontakt_telefon', clovek.telefonZakaznika!, 1);

      // Rozsah povolenia: "Mám" (YES) alebo "Nemám" (NO) povolenie URSO.
      const ursoValue = CONFIG.cestneVyhlasenie.maPovolenieUrso ? 'YES' : 'NO';
      const ursoRadio = page.locator(`input[name="hasUrso"][value="${ursoValue}"]`);
      await ursoRadio.check({ force: true }).catch(async () => {
        await ursoRadio.click({ force: true }).catch(() => {});
      });
      await page.waitForTimeout(1200);

      if (CONFIG.cestneVyhlasenie.maPovolenieUrso) {
        // "Mám povolenie URSO": pre KAŽDÝ dokument pridaj riadok do tabuľky "Rozsah povolenia".
        // Poradie: Splnomocnenie, potom Čestné vyhlásenie. Číslo povolenia sa po výbere typu doplní samo.
        const dokumenty: { nazov: string; typ: RegExp; subor?: string; datum: string }[] = [
          { nazov: 'Splnomocnenie', typ: /splnomoc/i, subor: clovek.subory.splnomocnenie, datum: clovek.pdf?.datumSplnomocnenie || CONFIG.cestneVyhlasenie.datumPodpisu },
          { nazov: 'Čestné vyhlásenie', typ: /(čestné|cestne|vyhlás|vyhlas)/i, subor: clovek.subory.vyhlasenie, datum: clovek.pdf?.datumCestne || CONFIG.cestneVyhlasenie.datumPodpisu },
        ];
        for (const dok of dokumenty) {
          if (!dok.subor) { console.warn(`  Chýba súbor pre ${dok.nazov} – preskakujem riadok.`); continue; }
          // 1) Pridať rozsah povolenia (otvorí podformulár)
          await page.locator('[hintid="povoleniaPodnikania_grid_add"]').click();
          await page.waitForTimeout(800);
          // 2) Typ dokumentu (po výbere sa číslo povolenia URSO doplní automaticky)
          const vybrane = await vyberNgSelect(page, 'povoleniaPodnikania_documentType', dok.typ);
          if (!vybrane) throw new Error(`Typ dokumentu "${dok.nazov}" sa nepodarilo vybrať v dropdowne.`);
          await page.waitForTimeout(700);
          // 3) Nahrať súbor (fileName/fileSize sa doplnia samy)
          await page.locator('input[type="file"]').first().setInputFiles(dok.subor);
          await page.waitForTimeout(1200);
          // 4) Dátum vystavenia dokumentu = dátum z TOHTO PDF (DŇA), nie dnešok.
          await vyplnHintid(page, 'povoleniaPodnikania_platnostOdPovUrso', dok.datum);
          // 5) Uložiť rozsah povolenia (riadok sa pridá do tabuľky, podformulár sa zavrie)
          await page.locator('[hintid="povoleniaPodnikania_grid_submit"]').click();
          await page.waitForTimeout(1500);
          console.log(`  Rozsah povolenia pridaný: ${dok.nazov}`);
        }
      } else {
        // "Nemám povolenie URSO": jeden upload = čestné vyhlásenie + dátum podpisu.
        await page.locator('input[type="file"]').first().setInputFiles(clovek.subory.vyhlasenie!);
        await page.waitForTimeout(800);
        await vyplnHintid(page, 'participantCreateSimple_datumPodpisuCestnehoVyhlasenia', CONFIG.cestneVyhlasenie.datumPodpisu);
      }

      if (DRY_RUN) {
        console.log(`  DRY-RUN: krok 1 vyplnený, neodoslané (${clovek.meno}, výkon ${clovek.vykonKw} kW)`);
        report.push({ meno: clovek.meno, stav: 'OK', dovod: 'DRY-RUN (krok 1)' });
        continue;
      }

      // Prejsť na krok 2 – klik a počkaj, kým ZMIZNE krok 1 (meno), nie fixný čas.
      await page.getByRole('button', { name: 'Uložiť a ďalej' }).click();
      await page.locator('[hintid="participantCreateSimple_meno"]')
        .waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});

      // Kroky 2–4
      const stalePrvy = await zistiKrok(page); // 1 = stále krok 1 (validácia neprešla)
      if (stalePrvy === 1) {
        const errs: string[] = await page.evaluate(() => {
          const out: string[] = [];
          document.querySelectorAll('.invalid-feedback, .text-danger, mat-error, .field-error, .error-message').forEach((e) => {
            const t = (e as HTMLElement).innerText?.trim();
            if (t && t.length < 160) out.push(t);
          });
          return Array.from(new Set(out));
        });
        console.warn('  Stále na kroku 1 – validácia neprešla. Hlášky: ' + JSON.stringify(errs));
        report.push({ meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 1 validácia neprešla: ' + (errs.join('; ') || 'neznáme') });
        break;
      }

      /* ---------- KROK 2: ZMLUVNÉ ÚDAJE ---------- */
      console.log('  Krok 2 (Zmluvné údaje).');
      // Názov UT je často disabled/auto – ak sa nedá vyplniť, dopĺňa sa sám.
      const nazovOk = await vyplnHintid(page, 'zmluvaFormZpu_nazovUt', clovek.meno);
      if (!nazovOk) console.log('  Názov UT je disabled/auto – nevypĺňam.');
      // Požadovaný dátum začatia = prvý klikateľný deň v kalendári.
      const datumOk = await klikniPrvyDatum(page, 'zmluvaFormZpu_pozadovanyDatumZacatia', outDir);
      console.log(`  Dátum začatia (prvý klikateľný): ${datumOk ? 'vybraný' : 'NEvybraný'}`);
      if (CONFIG.krok2.poznamka) await vyplnHintid(page, 'zmluvaFormZpu_poznamka', CONFIG.krok2.poznamka);
      // Osoba na komunikáciu + podpis = Martin Gonda.
      const g1 = await vyberNgSelect(page, 'zmluvaFormZpu_osobaPoverenaNaKomunikaciu', CONFIG.krok2.osoba);
      const g2 = await vyberNgSelect(page, 'zmluvaFormZpu_osobaPoverenaNaPodpis', CONFIG.krok2.osoba);
      console.log(`  Osoba komunikácia/podpis (Gonda): ${g1}/${g2}`);
      // Zmluvné vzťahy = Gonda.
      await vyberNgSelect(page, 'zmluvaFormZpu_zmluvneVztahy', new RegExp(CONFIG.krok2.zmluvneVztahy, 'i'));

      // Prejsť na krok 3.
      await page.getByRole('button', { name: 'Uložiť a ďalej' }).click();
      await page.locator('[hintid="zmluvaFormZpu_nazovUt"]').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});

      const stalKrok2 = await page.locator('[hintid="zmluvaFormZpu_nazovUt"]').isVisible().catch(() => false);
      if (stalKrok2) {
        console.warn('  Stále na kroku 2 (asi treba doplniť "Zmluvné vzťahy").');
        report.push({ meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 2 neprešiel – treba zmluvné vzťahy' });
      } else {
        console.log('  Krok 2 odoslaný. Čakám na obsah kroku 3...');
        // Krok 3 sa načítava lazy – počkaj na jeho obsah.
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

        /* ---------- KROK 3: VÝROBNÉ ZARIADENIE (FVE) ---------- */
        // Hneď po vstupe do kroku 3 vyskočí informačný popup – NAJPRV klikni jeho OK,
        // až potom otváraj zariadenie (inak ten modál blokuje klik na "Pridať zariadenie").
        const okPopup = page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).first();
        await okPopup.click({ timeout: 8000 }).catch(() => {}); // počká na vstupný popup a klikne OK
        await page.waitForTimeout(600);
        // Otvor pridanie zariadenia.
        await page.getByText(/Prid[aá]ť.*zariaden/i).first().click().catch(() => {});
        await page.waitForTimeout(1200);
        // Ak po otvorení podformulára vyskočí ešte jeden info popup, klikni aj jeho OK (ak je).
        if (await okPopup.isVisible().catch(() => false)) await okPopup.click().catch(() => {});
        await page.waitForTimeout(800);

        console.log('  Krok 3 (Výrobné zariadenie).');
        // Názov zariadenia = meno + " FVE", generátor = meno.
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_nazov', clovek.meno + CONFIG.krok3.nazovSuffix);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_generator_nazov', clovek.meno);
        // Inštalovaný výkon = výkon z DocuSealu (desatinná čiarka).
        if (clovek.vykonKw) {
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_generator_instalVykon', String(clovek.vykonKw).replace('.', ','));
        }
        // Adresa prevádzky zariadenia = ADRESA VÝROBNE z čestného vyhlásenia (NIE adresa sídla!).
        // Ak ju z PDF máme, odškrtneme "Zhodná s adresou sídla" a vyplníme ju ručne.
        const av = clovek.pdf?.adrVyrobne;
        if (av && av.ulica) {
          await zaskrtni(page, 'contractFinanceDataVyrobca11kw_apAddrSame', false);
          await page.waitForTimeout(700); // polia sa odomknú
          // Štát = Slovenská republika (po odškrtnutí môže byť potrebné nastaviť znova).
          await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_apIdStat', /Slovensk/i).catch(() => {});
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apUlica', av.ulica);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apPopisneCislo', av.supisneCislo);
          if (av.orientacneCislo) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apOrientacneCislo', av.orientacneCislo);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apPsc', av.psc);
          await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apMesto', av.mesto);
          console.log(`  Adresa výrobne (z PDF): ${av.ulica} ${av.supisneCislo}${av.orientacneCislo ? '/' + av.orientacneCislo : ''}, ${av.psc} ${av.mesto}`);
        } else {
          // Fallback: ak sa adresa výrobne nevytiahla, ostaň na "zhodná s adresou sídla".
          await zaskrtni(page, 'contractFinanceDataVyrobca11kw_apAddrSame', CONFIG.krok3.apAddrSame);
          console.warn('  Adresa výrobne sa z PDF nevytiahla – použila sa adresa sídla (skontroluj!).');
        }
        // Trieda TDVE = FVE, Stav = V prevádzke.
        await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_triedaTdve', CONFIG.krok3.triedaTdve);
        await vyberNgSelect(page, 'contractFinanceDataVyrobca11kw_stavZariadenia', CONFIG.krok3.stavZariadenia);
        // Meranie na svorkách / lokálny zdroj.
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoMeranieSvorky', CONFIG.krok3.meranieNaSvorkach);
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoLokalZdroj', CONFIG.krok3.lokalnyZdroj);
        // Priznaná podpora = Bez podpory.
        await zaskrtni(page, 'contractFinanceDataVyrobca11kw_anoBezPodpory', true);

        // Investičná podpora – povinné polia (nie sú v zmluvách) → natívne 0 / 0 / 9000.
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_intenzitaInvPodpory', CONFIG.krok3.investicnaPodpora.intenzita);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_poskytIvestPomoc', CONFIG.krok3.investicnaPodpora.pomoc);
        await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_vyskaOpravNaklad', CONFIG.krok3.investicnaPodpora.naklady);
        console.log(`  Investičná podpora: intenzita ${CONFIG.krok3.investicnaPodpora.intenzita} %, pomoc ${CONFIG.krok3.investicnaPodpora.pomoc} €, náklady ${CONFIG.krok3.investicnaPodpora.naklady} €`);

        // Generátor: typ technológie + typ paliva; typ pripojenia.
        const ddZoznam: [string, string, string][] = [
          ['contractFinanceDataVyrobca11kw_generator_typTechnologie', CONFIG.krok3.generatorTypTechnologie, 'typ technológie'],
          ['contractFinanceDataVyrobca11kw_generator_typPaliva', CONFIG.krok3.generatorTypPaliva, 'typ paliva'],
          ['contractFinanceDataVyrobca11kw_oom_typPripojenia', CONFIG.krok3.typPripojenia, 'typ pripojenia'],
        ];
        for (const [hid, val, nazov] of ddZoznam) {
          const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          const ok = await vyberNgSelect(page, hid, re);
          console.log(`  ${nazov}: ${ok ? 'vybraté' : 'NEvybraté'}`);
        }

        // Z PDF čestného vyhlásenia: EIC, katastrálne územie, číslo parcely, dátum začatia výroby.
        if (clovek.pdf) {
          const p = clovek.pdf;
          if (p.kataster) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apKatastUzemie', p.kataster);
          if (p.parcela) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_apCisloParcely', p.parcela);
          if (p.eicOdber) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_oom_ooEic', p.eicOdber);
          if (p.eicDodavka) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_oom_odEic', p.eicDodavka);
          if (p.datumZacatiaVyroby) await vyplnHintid(page, 'contractFinanceDataVyrobca11kw_datOd', p.datumZacatiaVyroby); // typovaný, nie kalendár
          console.log(`  Z PDF doplnené: EIC ${p.eicOdber || '-'}/${p.eicDodavka || '-'}, kataster ${p.kataster || '-'}, parcela ${p.parcela || '-'}, začatie ${p.datumZacatiaVyroby || '-'}`);
        } else {
          console.warn('  Žiadne PDF dáta – EIC/kataster/parcela/dátum začatia ostali prázdne.');
        }

        // Checkpoint: EIC sa môže overiť hneď po zadaní (napr. "EIC neexistuje") -> ak chyba, zruš a ďalší.
        await page.waitForTimeout(600).catch(() => {});
        await checkOkteChyba(page, 'EIC/údaje zariadenia');

        // Uložiť zariadenie (pridá ho do tabuľky).
        const ulozeneZar = await page.locator('[hintid="contractFinanceDataVyrobca11kw_grid_kontakty_submit"]').click().then(() => true).catch(() => false);
        if (!ulozeneZar) await page.getByRole('button', { name: /Uložiť zariadenie/i }).click().catch(() => {});
        await page.waitForTimeout(2500).catch(() => {});
        await checkOkteChyba(page, 'uloženie zariadenia'); // tu OKTE validuje EIC + povinné polia
        console.log('  Zariadenie uložené.');

        // Krok 3 -> 4 (poradie: najprv "Uložiť zariadenie", až potom "Uložiť a ďalej").
        if (!page.isClosed()) {
          await page.getByRole('button', { name: 'Uložiť a ďalej' }).click().catch(() => {});
          await page.waitForTimeout(2500).catch(() => {});
          await checkOkteChyba(page, 'prechod na krok 4');
        }

        // Krok 4: dokončenie zápisu. Krok 4 sa občas dorenderuje s oneskorením a/alebo ho
        // prekrýva info popup (ako v kroku 3) – preto najprv zavri popup, počkaj na tlačidlo,
        // a klik zopakuj. krok4Odoslany = či sa klik naozaj podaril (nie iba "skúsili sme").
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
          console.log(krok4Odoslany ? '  Krok 4 odoslaný.' : '  POZOR: tlačidlo "Uložiť a odoslať do OKTE" v kroku 4 sa nepodarilo stlačiť!');
        }

        report.push(page.isClosed()
          ? { meno: clovek.meno, stav: 'CHYBA', dovod: 'stránka sa zatvorila počas dokončovania' }
          : krok4Odoslany
            ? { meno: clovek.meno, stav: 'OK', dovod: 'kompletný zápis 1–4' }
            : { meno: clovek.meno, stav: 'CHYBA', dovod: 'krok 4 – tlačidlo "Uložiť a odoslať do OKTE" sa nestlačilo (skontroluj ručne)' });
      }
      // žiadny break – pokračujeme ďalším používateľom
    } catch (e: any) {
      // Ak OKTE odmietlo preto, že EIC/zariadenie už existuje, je to DUPLICITA, nie chyba.
      const duplicita = jeDuplicita(e.message);
      console.error(`  ${duplicita ? 'DUPLICITA' : 'CHYBA'} pri ${clovek.meno}: ${e.message}`);
      report.push({ meno: clovek.meno, stav: duplicita ? 'DUPLICITA' : 'CHYBA', dovod: e.message });
      if (page.isClosed() || /has been closed/i.test(e.message)) {
        console.error('  Stránka/prehliadač zatvorené – ukončujem loop.');
        break;
      }
      await zrusProces(page); // zruš rozpracovaný proces, nech ďalší začne čisto
    }
  }

  /* ========== FÁZA 3: REPORT ========== */
  zapisReport(report, outDir);
  console.log('\nHOTOVO.');

  // Nechaj prehliadač otvorený na kontrolu PRED finálnym vyhodnotením
  // (nech vidíš vyplnený/odoslaný stav skôr, než sa test ukončí).
  await nechajOtvorene(page);

  // Test zhodí (červený) len reálna CHYBA. PRESKOČENÝ (nekompletné dáta) aj
  // DUPLICITA (EIC už v OKTE existuje) sú očakávané stavy – tie červenú nerobia.
  const chyby = report.filter(r => r.stav === 'CHYBA');
  if (chyby.length > 0) {
    throw new Error(`${chyby.length} zápis(ov) zlyhalo (detaily v reporte): ${chyby.map(c => c.meno).join(', ')}`);
  }
});