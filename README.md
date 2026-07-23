# EDC Bot — automatizácia DocuSeal → OKTE EDC

Hromadná E2E automatizácia (Playwright \+ TypeScript), ktorá z **DocuSealu** pozbiera podpísané dokumenty výrobcov, stiahne kompletné trojice, vytiahne údaje z PDF a **zaregistruje výrobcov FVE do 11 kW** do portálu **OKTE EDC** cez 4-krokový wizard.

## Obsah repozitára

| Priečinok | Nástroj | Účel |
| :---- | :---- | :---- |
| `Code/EDC ZPÚ/` | `EDC_bot.spec.ts` | DocuSeal → OKTE EDC registrácia výrobcov (viď nižšie). |
| `Code/EDC AGREG/` | `EDC_agreg.bot.spec.ts` | Hromadné vkladanie agregácie flexibility do OKTE EDC (viď nižšie). |
| `Code/EIC Korekcia/` | `correct_eic.py` \+ `validate_eic_correction.py` | Opravuje uz podpísané PDF, v ktorých sa namiesto reálneho EIC kódu omylom zobrazuje interné Mongo `_id` (backend bug pred opravou) — bez týchto opráv `EDC_bot.spec.ts` na daných súboroch zlyhá/preskočí krok s EIC. Pozri `Code/EIC Korekcia/README.md`. |

---

## 1\. Čo to robí (v skratke)

1. Prihlási sa do DocuSealu (alebo preskočí, ak si profil pamätá session).  
2. Prejde **všetky stránky** zoznamu „Completed" a pozbiera odkazy na dokumenty.  
3. Z každého dokumentu vytiahne **meno, typ a metadáta** (adresa, výkon, e-mail, telefón, dátum narodenia).  
4. Stiahne **iba kompletné trojice** (Splnomocnenie \+ Čestné vyhlásenie \+ Zmluva pre to isté meno) a „vytlačí" (flatten) PDF.  
5. Každého výrobcu **zvaliduje** (kompletné dáta, správny formát mena, výkon ≤ 11 kW…).  
6. Prihlási sa do OKTE a každého vyhovujúceho **zapíše** cez 4-krokový wizard.  
7. Pri **kroku 4** sa zastaví na manuálnu kontrolu (kým neklikneš „Pokračovať").  
8. Na konci vypíše **report** (konzola \+ JSON \+ TXT).

---

## 2\. Požiadavky

- **Node.js** (LTS) a **Playwright** (`@playwright/test`).  
- npm balíky: **`pdf-lib`**, **`pdf-parse@1.1.1`** (verzia je dôležitá — v2 má iné API).  
- **Reálny Chrome** (skript spúšťa `channel: 'chrome'`, nie Chromium).  
- **Windows certifikátová politika** pre prihlásenie do OKTE — certifikát Martina Gondu je neexportovateľný (token/karta), preto sa vyberá cez Windows policy `AutoSelectCertificateForUrls` (Chrome ho podá sám).  
- **Perzistentný Chrome profil** (`.chrome-profile-okte`) — pri **prvom** behu raz ručne klikneš „Povoliť" (popup prístupu) \+ sa prihlásiš; profil si to zapamätá a ďalšie behy sú už plne automatické.

---

## 3\. Inštalácia

```shell
# v priečinku projektu
npm install
npm install pdf-lib pdf-parse@1.1.1
npx playwright install chrome
```

---

## 4\. Konfigurácia

Všetko podstatné je v objekte **`CONFIG`** v hlavičke súboru. Citlivé veci sa dajú prepísať cez **premenné prostredia** (neukladať heslá natvrdo do gitu).

### 4.1 DocuSeal

| Pole | Popis | Env override |
| :---- | :---- | :---- |
| `loginUrl`, `submissionsUrl` | URL prihlásenia a zoznamu submissionov | — |
| `email`, `password` | prihlasovacie údaje | `DS_EMAIL`, `DS_PASSWORD` |

### 4.2 OKTE

| Pole | Popis | Env override |
| :---- | :---- | :---- |
| `zmluvaUrl` | **URL wizardu — určuje UAT vs. produkciu** (`uat-edc.okte.sk` \= test, `edc.okte.sk` \= produkcia) | — |
| `username`, `password` | prihlasovacie údaje | `OKTE_USER`, `OKTE_PASSWORD` |
| `subjekt` | aktívny subjekt (ak Gonda spravuje viacero) | — |

**Prepnutie UAT ↔ produkcia:** zmeň `zmluvaUrl` (a podľa potreby `publicUrl`). Na UAT reálne EIC kódy zvyčajne neexistujú, takže zápis tam padá na overení EIC — to je očakávané.

### 4.3 Údaje zápisu

- **`firemnyKontakt`** — kontakt 1 (Martin Gonda: meno, priezvisko, e-mail, telefón). Kontakt 2 sa berie z údajov výrobcu.  
- **`cestneVyhlasenie.maPovolenieUrso`** — `true` \= „Mám povolenie URSO" (nahrá Splnomocnenie \+ Čestné vyhlásenie ako rozsah povolenia); `false` \= „Nemám".  
- **`krok2`** — `osoba` / `zmluvneVztahy` \= Martin Gonda (komunikácia aj podpis).  
- **`krok3`** — predvolené hodnoty výrobného zariadenia:  
  - `nazovSuffix: ' FVE'`, `triedaTdve: FVE`, `stavZariadenia: V prevádzke`,  
  - `podpora: bez podpory`, `investicnaPodpora: { 0 % / 0 € / 9000 € }` (povinné polia, nie sú v zmluvách),  
  - `generatorTypTechnologie`, `generatorTypPaliva`, `typPripojenia`.  
- **`maxVykonKw: 11`** — horný limit výkonu (nad to sa výrobca preskočí).

### 4.4 Premenné prostredia (režimy behu)

| Premenná | Default | Účinok |
| :---- | :---- | :---- |
| `PAUZA` | zap. | `PAUZA=0` → plne automaticky, **bez pauzy** pri kroku 4\. |
| `DRY_RUN` | vyp. | `DRY_RUN=1` → vyplní krok 1, ale **neklikne** „Uložiť a ďalej". |
| `KEEP_OPEN` | zap. | `KEEP_OPEN=0` → po dobehnutí nenecháva prehliadač otvorený. |
| `DS_EMAIL` / `DS_PASSWORD` | — | prihlásenie DocuSeal. |
| `OKTE_USER` / `OKTE_PASSWORD` | — | prihlásenie OKTE. |

---

## 5\. Spustenie

Štandardne (Windows PowerShell, headed):

```
npx playwright test EDC_bot.spec.ts
```

S premennými (príklad — plne automaticky, vlastné heslá):

```
$env:PAUZA="0"; $env:OKTE_PASSWORD="..."; npx playwright test EDC_bot.spec.ts
```

**Tip:** pri prepínaní režimov vyčisti staré premenné, napr. `$env:DRY_RUN=""`, `$env:PAUZA=""`, inak ostanú nastavené z minula.

---

## 6\. Pauza pri kroku 4 (manuálna kontrola)

Pri každom výrobcovi sa na **kroku 4** zápis zastaví a **hore v stránke sa objaví fialová lišta** s tlačidlom **„POKRAČOVAŤ ▶"**:

1. Skontroluješ zadané údaje priamo v prehliadači (bez časového limitu).  
2. Klikneš **„POKRAČOVAŤ ▶"** → bot finálne odošle krok 4 a pokračuje ďalším výrobcom.

Nepotrebuje Playwright Inspector ani `--debug`. Pauzu vypneš cez `PAUZA=0` (vtedy odošle krok 4 automaticky).

---

## 7\. Tok spracovania (detail)

### Fáza 1 — DocuSeal

- **1.1 Stránkovanie:** kliká „»" a pozbiera odkazy zo všetkých stránok. Koniec spozná podľa textu „X-Y of Z" (Y ≥ Z), podľa toho, že nepribudli nové odkazy, alebo že „»" už nie je. Žiadny počet stránok nie je natvrdo (poistka 200 strán).  
- **1.1b Metadáta:** otvorí každý dokument cez jeho URL a vytiahne meno (`FULLNAMEORCOMPANYNAME`), typ (Splnomocnenie / Čestné vyhlásenie / Zmluva), adresu, výkon, e-mail, telefón, dátum narodenia.  
- **1.2 Sťahovanie:** stiahne **iba kompletné trojice**; nekompletné sa nesťahujú vôbec.

### Fáza 1.5 — Validácia

Výrobca postúpi do OKTE len ak má: kompletnú a stiahnutú trojicu, meno \+ priezvisko \+ dátum narodenia, **správny formát mena**, ulicu/súpisné/PSČ/mesto, e-mail, telefón a výkon ≤ 11 kW.

### Fáza 2 — OKTE wizard (per výrobca)

- **Krok 1 — Účastník trhu:** FO, identita, adresa sídla, 2 kontakty (Gonda \+ výrobca), „Mám povolenie URSO" → do tabuľky rozsahu povolenia nahrá Splnomocnenie a Čestné vyhlásenie; **dátum vystavenia \= „DŇA" z konkrétneho PDF** (nie dnešok).  
- **Krok 2 — Zmluvné údaje:** dátum začatia (prvý voľný deň), osoba na komunikáciu/podpis \= Gonda.  
- **Krok 3 — Výrobné zariadenie:** názov \= `meno + FVE`, generátor \= meno, výkon z DocuSealu, **adresa prevádzky \= adresa výrobne z čestného vyhlásenia** (odškrtne „Zhodná s adresou sídla"), Trieda TDVE \= FVE, V prevádzke, bez podpory, investičná podpora 0/0/9000, dropdowny (technológia/palivo/pripojenie) a z PDF: **EIC odber/dodávka, katastrálne územie, číslo parcely, dátum začatia výroby**. Potom **„Uložiť zariadenie na výrobu elektriny"**.  
- **Krok 4 — Kontrola a potvrdenie:** pauza na kontrolu → „Uložiť a ďalej" \= dokončenie.

### Fáza 3 — Report

Konzolová tabuľka \+ `report-{stamp}.json` a `.txt`.

---

## 8\. Čítanie údajov z PDF

Z **čestného vyhlásenia** sa čítajú: **EIC odber a dodávka** (tokeny `24Z…`), **dátum začatia výroby, adresa výrobne, katastrálne územie, číslo parcely**. Zo **splnomocnenia** aj **čestného vyhlásenia** sa číta **dátum vyhotovenia („DŇA")** — každý zvlášť.

Dôležité: `pdf-parse` vracia najprv všetky **názvy** polí a až na konci všetky **hodnoty** (dvojstĺpcová tabuľka), preto sa hodnoty čítajú **podľa poradia** (za druhým EIC), nie podľa názvov.

---

## 9\. Koho bot preskočí (a prečo)

| Stav v reporte | Dôvod |
| :---- | :---- |
| `PRESKOČENÝ` | **Nekompletná trojica** dokumentov → vôbec sa nesťahuje. |
| `PRESKOČENÝ` | **Nesprávny formát mena** (malé písmená / bez diakritiky, napr. „tomas brinza") → OKTE neprijme; treba opraviť pri zdroji. |
| `PRESKOČENÝ` | Chýba ulica/PSČ/mesto/e-mail/telefón/dátum narodenia, alebo výkon \> 11 kW. |
| `CHYBA` | OKTE pri zápise niečo odmietlo (napr. **EIC ešte v systéme neexistuje**) — bot proces zruší a ide ďalej. |

**Pozn. k formátu mena:** spoľahlivo sa deteguje malé písmeno na začiatku slova. Meno správne s veľkými písmenami, ktorému chýba len diakritika (napr. „Tomas Brinza"), sa nedá automaticky odlíšiť od legitímneho mena bez diakritiky (napr. „Pavol Kraic") — také prípadne odmietne až OKTE a bot ich označí ako CHYBA.

---

## 10\. Odolnosť voči chybám

- **Chybový dialóg OKTE** (napr. „EIC neexistuje") sa zachytí na checkpointoch (po zadaní EIC, po uložení zariadenia, pri oboch „Uložiť a ďalej"). Bot **zatvorí dialóg**, na kroku 3 **zruší podformulár zariadenia** („Zrušiť"), potom **zruší celý proces** („Zrušiť proces"), zapíše dôvod do reportu a **pokračuje ďalším výrobcom**.  
- **Zatvorený prehliadač** → loop sa korektne ukončí (zvyšok neodoslaný).  
- Plnenie polí je odolné: ak pole nie je prítomné alebo je disabled, beh nepadne (preskočí ho).

---

## 11\. Výstupy

| Priečinok / súbor | Obsah |
| :---- | :---- |
| `downloads/` | stiahnuté podpísané PDF (len kompletné trojice). |
| `downloads/print/` | „vytlačené" (flatten) PDF, ktoré sa nahrávajú do OKTE. |
| `reports/report-*.json` / `.txt` | záverečný report (OK / Preskočení / Chyby). |
| `reports/pdftext-*.txt` | extrahovaný text z PDF (na kontrolu parsera). |
| `reports/kalendar-dump-*.html` | HTML kalendára, ak by datepicker zlyhal (fallback). |

---

## 12\. Riešenie problémov

- **Prvý beh OKTE** vyžaduje raz ručne: „Povoliť" (popup) → prihlásenie. Profil si to zapamätá.  
- **Pruh „--no-sandbox"** sa nezobrazuje (zapnutý `chromiumSandbox: true`); je to len informačný pruh Chromu, nie chyba.  
- **`pdf-parse` musí byť nainštalovaný** (`pdf-parse@1.1.1`), inak skript spadne pri importe.  
- **Bot vidí len prvú stránku DocuSealu** → ak sa „»" volá inak, treba upraviť selektor stránkovania; v logu sleduj riadky `📑 Stránka …`.  
- **EIC chyby na UAT** sú očakávané (testovacie EIC nie sú v registri OKTE).  
- **Zmena prostredia (UAT/produkcia)** \= `zmluvaUrl` v `CONFIG.okte`.

---

## 13\. Mapa hlavných funkcií (kód)

| Funkcia | Účel |
| :---- | :---- |
| `stiahniPdf`, `printniPdf` | stiahnutie a flatten PDF. |
| `rozdelMeno`, `rozdelAdresu`, `bezpecneMeno`, `vykonNaCislo` | parsovanie mena/adresy/výkonu. |
| `menoZleNaformatovane`, `slovoZacinaMalym` | detekcia nesprávneho formátu mena. |
| `validuj` | validačná brána pred zápisom. |
| `extrahujPdf`, `citajPdfText`, `jeDatum` | čítanie údajov z PDF (EIC, kataster, parcela, dátumy). |
| `vyplnHintid`, `vyberNgSelect`, `zaskrtni`, `klikniPrvyDatum` | spoľahlivé plnenie polí wizardu. |
| `precitajDialog`, `jeChybovyText`, `checkOkteChyba`, `zavriDialog`, `zrusProces` | detekcia chýb a správne zrušenie procesu. |
| `pauzaNaKontrolu`, `nechajOtvorene` | pauza pri kroku 4 a držanie prehliadača otvoreného. |
| `zistiKrok` | poistka proti preskočeniu kroku wizardu. |
| `zapisReport` | záverečný report. |

# Automatizácia EDC — Agregácia flexibility (Wattiva)

**Súbor:** `EDC_agreg.bot.spec.ts` · **Nástroj:** Playwright (headed Chrome) · **Cieľ:** OKTE EDC portál (`edc.okte.sk`)

Táto automatizácia hromadne vkladá dáta o agregácii flexibility (agregačné bloky, technológie a odberné miesta / EIC) do OKTE EDC. Robí to tak, že v prehliadači prejde procesom **„Zmena zmluvy"** nad existujúcou **Zmluvou o poskytovaní údajov** a v kroku *Prílohy zmluvy* vyplní agregačnú sekciu podľa údajov z CSV súborov.

---

## 1\. Čo automatizácia robí (dátový model)

Vstupom sú CSV súbory so stĺpcami **`meno`** a **`eic`**. Každý riadok \= jedno odberné miesto (OM/EIC).

Pravidlá spracovania:

- **Jeden agregačný blok na dávku.** Každý CSV súbor patrí k jednému bloku. Blok sa vytvorí raz; ak už na zmluve existuje, preskočí sa (idempotentné).  
- **Jedno „auto" (technológia) na osobu.** Pre každé unikátne meno vznikne jedna technológia s názvom `{meno} auto`.  
- **Odberné miesta podľa výskytu mena.** Koľkokrát sa meno v CSV vyskytne, toľko OM daná osoba dostane. Názov OM sa **čísluje iba pri opakovaní** mena:  
  - meno 1× → OM \= `Tomáš Brinza`  
  - meno 2×+ → OM \= `Tomáš Brinza 1`, `Tomáš Brinza 2`, … (všetky pod tým istým autom)  
- Všetky OM danej dávky sa naviažu na **blok tejto dávky** (pole *Agregačné bloky*) a na **auto danej osoby** (pole *Technológie*).  
- Celá zmena sa do OKTE **odosiela raz na konci** (nie po každom zázname).

Aktuálne rozdelenie dávok:

| CSV súbor | Agregačný blok |
| :---- | :---- |
| `data.csv` | SSE blok 1 |
| `data_wattiva.csv` | WATTIVA blok 1 |

---

## 2\. Predpoklady

- **Node.js** \+ **Playwright** (`npm i -D @playwright/test`, `npx playwright install chromium`) a balík `csv-parse`.  
- **Google Chrome** (bot beží cez `channel: 'chrome'`, aby výber certifikátu riešila politika Windowsu).  
- Prístup do OKTE EDC pre subjekt **Voltia Technologies s.r.o.** a platný certifikát.  
- Perzistentný profil prehliadača v priečinku `.chrome-profile-okte` (vytvorí sa automaticky). **Pri prvom behu treba raz ručne dokončiť prihlásenie** (kliknúť „Povoliť" / vybrať certifikát); ďalšie behy sú plne automatické, lebo profil si prihlásenie zapamätá.

---

## 3\. Štruktúra súborov (pracovný priečinok)

```
EDC AGREG\
├─ EDC_agreg.bot.spec.ts     ← samotná automatizácia
├─ data.csv                  ← dávka pre SSE blok 1  (meno,eic)
├─ data_wattiva.csv          ← dávka pre WATTIVA blok 1 (meno,eic)
├─ reports\                  ← report + diagnostika (vytvorí sa automaticky)
└─ .chrome-profile-okte\     ← perzistentný profil prehliadača
```

**Dôležité:** názvy súborov musia presne sedieť. Test sa spúšťa ako `EDC_agreg.bot.spec.ts` (s bodkami), CSV pre WATTIVA musí byť presne `data_wattiva.csv` (malé písmená, podčiarkovník). Súbory musia ležať priamo v pracovnom priečinku, nie v podpriečinku.

---

## 4\. Konfigurácia (objekt `CONFIG` v kóde)

**`CONFIG.okte`**

- `mojeZmluvyUrl` — priama URL zoznamu zmlúv: `https://edc.okte.sk/portal/ui/zmluva/vyhladanie` (obchádza neklikateľné stromové menu)  
- `zmluvaUrl` — produkčná URL zakladania zmluvy (používa sa len ako spúšťač prihlásenia)  
- `username` / `password` — prihlasovacie údaje. **Odporúčanie:** nastaviť ich cez premenné prostredia `OKTE_USER` a `OKTE_PASSWORD`, nie natvrdo v kóde.  
- `subjekt` — `Voltia Technologies s.r.o.`  
- `cisloZmluvy` — `2026-15-5942` (zmluva sa hľadá primárne podľa čísla, unikátne)

**`CONFIG.agregacia`**

- `davky` — pole `{ csv, blok }` (viď tabuľka vyššie); ľahko rozšíriteľné o ďalšie bloky  
- `bilancnaSkupina` — `24YB-VOLTIATECHP`  
- prednastavené voľby rozbaľovačiek: typ zariadenia *Odberné zariadenie*, stav *V prevádzke*, typ poskytovateľa flexibility *Odberateľ*, smer *Odber zo sústavy*

Ak niektorý CSV súbor neexistuje, príslušná dávka sa iba preskočí (beh nespadne) — dá sa teda spustiť aj keď je pripravený len jeden zo súborov.

---

## 5\. Formát CSV

- Hlavička: `meno,eic` (oddeľovač čiarka aj bodkočiarka je akceptovaný).  
- Jeden riadok \= jedno odberné miesto.  
- Kódovanie ideálne **UTF-8**.  
- Opakované meno \= viac OM tej istej osoby (očísluje sa automaticky).

Príklad:

```
meno,eic
Ondrej Jantolák,24ZSS7506002000D
Adriana Pažitná,24ZZS40000716902
Adriana Pažitná,24ZSS30277680003
```

**Pozor na kódovanie doplnených súborov.** Keď sa CSV upravuje vo viacerých nástrojoch, môže vzniknúť mix UTF-8/Windows-1250 a mená s diakritikou sa „rozbijú". Pred behom sa oplatí súbor prečistiť (per-riadkové dekódovanie). Rovnako pozor, aby Poznámkový blok nepridal príponu `.txt` (`data_wattiva.csv.txt`).

---

## 6\. Priebeh automatizácie

1. **Načítanie a validácia CSV** všetkých dávok (nevalidné/prázdne riadky idú do reportu).  
2. **Prihlásenie** do OKTE (alebo preskočenie, ak profil pamätá session).  
3. **Výber subjektu** Voltia Technologies s.r.o.  
4. **Navigácia** na zoznam zmlúv → otvorenie zmluvy `2026-15-5942` → tlačidlo **Zmena zmluvy**.  
5. **Dosiahnutie kroku „Prílohy zmluvy"** (krok 3 zo 4). Wizard sa ovláda **iba tlačidlom „Uložiť a ďalej"** — stepper hore je neklikateľný. Po každom kroku bot počká, kým sa obrazovka reálne zmení a vykreslí, aby krok 3 nepreskočil.  
6. **Pre každú dávku:** zabezpečí blok (vytvorí alebo preskočí), zoskupí ľudí podľa mena a pridá technológie \+ odberné miesta naviazané na správny blok.  
7. **Finálne odoslanie** zmeny do OKTE (ak je zapnuté `AUTO_SUBMIT`).  
8. **Report** \+ ponechanie okna otvoreného na kontrolu.

Kroky wizardu: *Účastník trhu → Zmluvné údaje → **Prílohy zmluvy** (agregácia) → Kontrola a potvrdenie.*

---

## 7\. Spustenie (PowerShell)

Premenné prostredia sa v PowerShelli nastavujú cez `$env:` (nie `VAR=hodnota`).

**Nasucho** (vyplní všetko, ale **neodošle** — na kontrolu):

```
$env:DEBUG_NAV=1; $env:AUTO_SUBMIT=0; npx playwright test EDC_agreg.bot.spec.ts --headed *> run.log; Select-String -Path run.log -Pattern 'DÁVKA|OK:|CHYBA' | ForEach-Object { $_.Line }
```

**Naostro** (odošle zmenu do OKTE):

```
Remove-Item Env:AUTO_SUBMIT -ErrorAction SilentlyContinue
$env:DEBUG_NAV=0; npx playwright test EDC_agreg.bot.spec.ts --headed
```

`$env:` premenné platia po celý zvyšok relácie PowerShellu. Pre „naostro" buď otvor nové okno, alebo premennú `AUTO_SUBMIT` odstráň.

---

## 8\. Prepínače (premenné prostredia)

| Premenná | Význam |
| :---- | :---- |
| `AUTO_SUBMIT=0` | Vyplní blok, technológie aj OM, ale **zmenu neodošle** (nechá okno otvorené na kontrolu). Odporúčané pre prvý beh. |
| `AUTO_SUBMIT` (nenastavené/≠0) | Po spracovaní preklikne zvyšné kroky a **odošle** zmenu do OKTE. |
| `DEBUG_NAV=1` | Zapne podrobnú diagnostiku — screenshoty, HTML a zoznam viditeľných `hintid` pri každom kroku a podformulári. |
| `KEEP_OPEN` (≠0, default) | Po dobehnutí ponechá prehliadač otvorený (max 20 min) na vizuálnu kontrolu. |
| `OKTE_USER`, `OKTE_PASSWORD` | Prihlasovacie údaje (bezpečnejšie než v kóde). |

---

## 9\. Report a diagnostika

Po každom behu vzniknú v priečinku `reports\`:

- **`agreg-report-*.json`** a **`agreg-report-*.txt`** — zoznam všetkých záznamov so stavom **OK / DUPLICITA / CHYBA / PRESKOČENÝ**, rozpad aj po blokoch. Príklad riadku: `[OK] [SSE blok 1] Ondrej Jantolák (24ZSS…) – OM "Ondrej Jantolák" → auto "Ondrej Jantolák auto"`.  
- **`diag-*.png` / `.html` / `-*-hintids.txt`** — pri zlyhaní alebo v režime `DEBUG_NAV`. Súbor `*-hintids.txt` obsahuje zoznam viditeľných `hintid` na danej obrazovke a je kľúčový na doladenie selektorov.

Rýchly súhrn z logu:

```
Get-ChildItem reports\agreg-report-*.txt | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content
```

---

## 10\. Riešenie problémov (overené prípady)

- **„Do Moje zmluvy som sa nedostal" / navigácia zlyhá.** Ľavé stromové menu je neklikateľné/rozbaľovacie. Rieši sa priamou URL `mojeZmluvyUrl` (`…/zmluva/vyhladanie`) a hľadaním zmluvy podľa čísla.  
- **Bot preskočí krok 3 a skončí na Kontrole.** Wizard sa dá posúvať iba cez „Uložiť a ďalej"; ak sa krok skontroluje počas načítavania (prázdna stránka), preskočí sa. Riešené čakaním na **zmenu a vykreslenie kroku** pred ďalším klikom \+ poistkou „Krok späť".  
- **„Pridať agregačný blok" sa nenájde.** `hintid` tlačidla je na 0-rozmernom wrapperi, viditeľný odkaz je typu *link*, nie *button*. Klikanie skúša: normálny klik na hintid → viditeľný text/odkaz → force-klik → natívny `.click()` cez JavaScript.  
- **Zmeny v kóde „nezaberajú".** Overte, že spúšťate ten správny súbor. Vygenerovaný súbor má názov s podčiarkovníkmi (`EDC_agreg_bot_spec.ts`), no test beží ako `EDC_agreg.bot.spec.ts` (s bodkami) — treba prepísať obsah správneho súboru. Kontrola prítomnosti novej verzie napr.:

```
Select-String -Path EDC_agreg.bot.spec.ts -Pattern 'pockajNaZmenuKroku' -Quiet
```

- **`Test-Path .\data_wattiva.csv` vráti `False`.** To netestuje kód, ale či CSV fyzicky leží v pracovnom priečinku. Súbor tam skopírujte (často ostane v `Downloads`).  
- **Rozbitá diakritika v menách.** CSV je v mixe kódovaní — pred behom prečistiť na UTF-8.  
- **Prázdne meno v CSV.** Riadok bez mena bot preskočí (nezlúči ho s inými); doplňte meno, ak ho chcete zapísať.

---

## 11\. Známe obmedzenia a nápady do budúcna

- **Zoskupovanie podľa mena.** Dvaja rôzni ľudia s rovnakým **plným** menom by sa spracovali ako jedna osoba (jedno auto, očíslované OM). Pri krstných menách je to riziko výrazne väčšie — preto používame plné mená.  
- **Veľké dávky.** Pri stovkách OM v jednej zmene je beh dlhý a krehkejší; v prípade potreby sa dá rozdeliť na viac samostatných behov/zmien.  
- **Hromadný import EIC.** V kroku agregácie existuje funkcia `TEMPLATES_IMPORT_EIC` (import cez šablónu). Pri veľkých počtoch by mohla byť výrazne rýchlejšia a spoľahlivejšia než pridávanie OM po jednom — kandidát na budúce vylepšenie.

---

*Poznámka: prihlasovacie heslo nie je v tejto dokumentácii uvedené zámerne. Uchovávajte ho v premenných prostredia (`OKTE_USER` / `OKTE_PASSWORD`), nie v zdieľaných dokumentoch.*  
