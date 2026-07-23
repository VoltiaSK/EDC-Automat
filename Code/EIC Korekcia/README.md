# EIC Korekcia — oprava internych ID v podpisanych PDF (EIC internal-ID correction)

Python nastroj (`correct_eic.py` + `validate_eic_correction.py`, PyMuPDF/`fitz`),
ktory opravuje uz **podpisane** "Cestne vyhlasenie" PDF dokumenty, v ktorych sa
namiesto skutocneho EIC kodu omylom zobrazuje interne Mongo `_id`. Toto NIE JE
oprava backendu ani zasah do DocuSealu — pozri sekciu 2 nizsie predtym, ako
tento nastroj pouzijete.

Pisane pre noveho clena timu (alebo AI agenta), ktory tuto session nezazil —
vysvetluje cely kontext od zaciatku.

---

## 1. Preco tento nastroj existuje (root cause)

`wattiva-backend`-u patri metoda `DocumentSigningMapper.resolveEicCode()`,
ktora ma pred odoslanim dokumentu do DocuSealu previest interny odkaz na
lokalitu (Mongo `_id`, 24-znakovy hex, napr. `000000000000000000000000`) na jej
skutocny EIC kod (format `24Z...`, napr. `24ZXX0000000000X`). Nasadena verzia
backendu, ktora tieto dokumenty generovala, tuto opravu **este nemala** — takze
niektore uz podpisane "Cestne vyhlasenie" PDF maju v policiach
**"EIC KOD — ODBER"** / **"EIC KOD — DODAVKA"** namiesto realneho EIC kodu
surovy interny id.

To priamo rozbija tento repozitar: `Code/EDC ZPÚ/EDC_bot.spec.ts` cita EIC
hodnoty z tych istych PDF cez regex `/24Z[0-9A-Z]{10,18}/gi` — interny id
nikdy nesedi na tento format, takze postihnuty vyrobca v tom bote **zlyha
alebo sa preskoci** (v jeho reporte ako `CHYBA` / `PRESKOČENÝ`).

## 2. Co tento nastroj robi — a co NErobi

**Robi:**
- Najde postihnute PDF (obsahuju interny-id-tvarovany token).
- Dohlada spravny EIC kod v exporte mapovania (CSV).
- Vytvori **opravenu kopiu** so spravnym EIC na tom istom mieste na strane.
- Napise report (JSON + TXT) — ktore subory boli opravene, ktore uz boli v
  poriadku, ktore zostavaju nevyriesene.

**NErobi (zamerne):**
- **Neopravuje backend.** `resolveEicCode()` bug musi opravit
  `wattiva-backend` sam — tento skript je len docasna nahrada za uz podpisane
  dokumenty, ktore vznikli pred tou opravou.
- **Nemodifikuje original v DocuSeal.** Skript nikdy nezapisuje do vstupneho
  suboru — vzdy tvori novu kopiu v `--output`. Podpisany PDF v DocuSeal
  zostava presne taky, aky bol v momente podpisu.
- **Znovu nepodpisuje nic.** Opravena kopia nie je novy podpisany dokument —
  je to referencny/doplnkovy subor. Pozri integritnu politiku v sekcii 6.

## 3. Dva zapisove kanaly — a preco su oba potrebne

EIC hodnota sa v roznych sablonach PDF vykresluje dvoma odlisnymi sposobmi a
kazdy vyzaduje ine riesenie:

- **Text path** (overene — puvodna davka 30 "Cestne vyhlasenie" suborov): EIC
  je vykresleny priamo do obsahoveho streamu strany ako plocha text. Skript
  danu presnu oblast zredaguje (biele vyplnenie) a znova vlozi spravny EIC,
  s rovnakou velkostou pisma.
- **Widget path** (napr. sablona s "recap" stranou, ktora pouziva zdielane
  nazvy poli ako AcroForm widgety): EIC sa vykresluje z hodnoty formularoveho
  policka (`/V`) cez jeho vzhladovy stream (`/AP`). **Samotna redakcia
  obsahoveho streamu toto NEOPRAVI** — `/V` by ostalo nespravne a render by sa
  poskodil. Skript preto v tomto pripade priamo nastavi hodnotu widgetu a
  prekresli jeho appearance.

Ktory kanal sa pouzije, sa urcuje **automaticky za kazdu hodnotu zvlast**
(jedna PDF moze mat obe). Vystup aj report ukazuju rozpad
`files via text path` / `files via widget path` — nenulovy pocet widget-path
suborov si zaslu manualnu vizualnu kontrolu (viac v sekcii 5).

**Nebezpecenstvo, na ktore si dat pozor:** naivny redact-only pristup (bez
kontroly widgetov) tichoako "uspesne" nahlasi opravu widget-backed hodnoty, v
skutocnosti ju vsak poskodi — widget stale ukazuje povodny (nespravny) `/V`.
Toto bolo pri vyvoji tohto nastroja realne odhalene adversarial code review a
opravene pridanim widget-detekcie (`page.widgets()`, `_find_overlapping_widget`
v `correct_eic.py`) predtym, nez sa dostalo do produkcie.

## 4. Auto-detekcia CSV schemy

`load_eic_lookup()` v `correct_eic.py` podporuje dva formaty exportu mapovania
interny-id → EIC, oba realne pouzite:

| Schema | Stlpce | Popis |
| :---- | :---- | :---- |
| **wide** (`locations_export.csv`) | `eic_import_id`/`eic_import`, `eic_export_id`/`eic_export` | jeden riadok na lokalitu, parove stlpce pre odber a dodavku |
| **long** (`location_eics.csv`) | `eic_document_id`, `eic_code`, `eic_direction` | jeden riadok na EIC dokument; smer (odber/dodavka) je informativny, do lookupu sa berie oboje |

Ktora schema sa pouzije, sa zisti automaticky z hlavicky CSV — netreba nic
prepinat rucne.

**Coverage caveat:** export je momentalny snapshot, nie zaruceny uplny alebo
aktualny. Ak `--input` obsahuje ludi, ktori v CSV nie su, zobrazia sa ako
`unresolved` — v tom pripade skuste ziskat cerstvejsi/sirsi export, nez
predpokladat, ze je nastroj rozbity.

## 5. Pred prvym behom na novej sablone — Krok 0.5

**Toto urobte raz pre kazdu novu sablonu, predtym nez jej vysledky
doverujete.** Cely-stranovy regex a text path su overene **len** pre "Cestne
vyhlasenie". Rychla kontrola pre novu sablonu:

```bash
python3 - <<'PY'
import fitz, re
doc = fitz.open("NEJAKA-nova-sablona.pdf")
for pno, page in enumerate(doc):
    ws = list(page.widgets() or [])
    print(f"strana {pno}: widgets={len(ws)}")
    for w in ws:
        print("   ", w.field_type_string, repr(w.field_name), repr(w.field_value), w.rect)
    print("   24-hex tokeny na strane:", re.findall(r"\b[0-9a-f]{24}\b", page.get_text(), re.I))
PY
```

Ak niektory EIC sedi vo widgete, vyskusajte widget path na kopii a vizualne
skontrolujte vysledok. Zaroven overte, ze zoznam "24-hex tokenov" obsahuje
**iba** EIC id — regex-scope caveat (ktoryhodnoty by teoreticky mohol zachytit
akykolvek 24-hex token na strane, nielen EIC — Mongo `_id` vytlaceny inde,
hash, referencne cislo) je zatial **overeny len pre "Cestne vyhlasenie"**, kde
kazda strana ma presne 0 alebo 2 take tokeny a oba su EIC. Pre kazdu dalsiu
sablonu (napr. viacstranova Zmluva) toto neplati automaticky.

## 6. Integritna politika — precitajte pred odoslanim opravenej kopie kamkolvek

**Opravena kopia NIE JE nahrada podpisaneho pravneho dokumentu.** Je to
samostatny referencny/doplnkovy subor (napr. na dodanie spravneho EIC do EDC,
alebo na uchovanie popri originali pre audit). Original v DocuSeal sa nikdy
nemodifikuje a tento nastroj nikdy neprepisuje svoj vstup.

- **Nikdy neprezentujte opravenu kopiu ako "podpisanu zmluvu"** bez toho, aby
  bol skutocny original stale zachovany popri nej.
- Postihnuti realni zakaznici dostavaju **oboje** — original aj opraveny
  referencny subor — nikdy tichy nahradny swap prezentovany ako "zmluva".
- Ak opravena kopia pojde niekam oficialne (EDC, vlastny archiv zakaznika),
  zvazte, ci nepotrebuje viditelnu poznamku o oprave (napr. maly footer s
  informaciou co a kedy bolo opravene) namiesto ticheho nahradenia.

## 7. Odporucany postup (dry-run najprv)

```bash
cd "Code/EIC Korekcia"
pip3 install --break-system-packages pymupdf   # jednorazovo, ak este nie je nainstalovane

# 1) DRY RUN najprv — vzdy. Ukaze, co BY sa zmenilo; nic nezapisuje
#    (ziadne opravene PDF, ziadny report). Skontrolujte pocty
#    corrected/unaffected a rozpad text-vs-widget pred ostrym behom.
python3 correct_eic.py \
  --input downloads/                \
  --csv locations_export.csv        \
  --output corrected/               \
  --dry-run

# 2) Ostry beh — ten isty prikaz bez --dry-run.
python3 correct_eic.py \
  --input downloads/                \
  --csv locations_export.csv        \
  --output corrected/

# 3) Nezavisla validacia vysledku pred odovzdanim
python3 validate_eic_correction.py \
  --report reports/eic-correction-report-<timestamp>.json \
  --originals downloads/ \
  --corrected corrected/
```

`--dry-run` sa da nastavit aj cez `DRY_RUN=1` v prostredi — rovnaky konvencny
vzor ako `EDC_bot.spec.ts` a `EDC_agreg.bot.spec.ts` v tomto repozitari.

Opakovanie behu je bezpecne: uz opravene subory sa pri dalsom behu ukazu ako
`unaffected` (uz neobsahuju interny id), takze sa znova nemenia.

### Preco validator potreboval vlastnu opravu — poucny pripad

Kontrola 4 vo `validate_eic_correction.py` porovnava extrahovany text
opravenej kopie s originalom, aby potvrdila, ze sa nezmenilo **nic ine** okrem
nahradenych hodnot. Prvy pokus pouzival **poziciny riadok-po-riadku diff** — a
produkoval falosne pozitivne zlyhania: PyMuPDF `get_text()` zoradi extrahovane
useky textu podla vlastneho vnutorneho poradia, a novo vlozeny text (cez
`insert_text`) moze v tomto poradi skoncit na inej pozicii ako povodny usek —
aj ked sa vykresluje na spravnom vizualnom mieste na strane. To bolo overene
priamo: opravena hodnota bola pritomna, len na posunutom riadku v
extrahovanom texte, pricom spravnost vizualnej/poziciovej strany bola
nezavisle potvrdena vykreslenim stranky do obrazku. Riesenim je porovnanie
**multisetov riadkov** (bag/`Counter` porovnanie namiesto poziciovej rovnosti)
— to falosne pozitiva odstranuje a stale zachyti realnu regresiu (akukolvek
zmenu obsahu, ktoru nevysvetluju nahlasene substitucie).

**Poucenie pre kohokolvek, kto toto bude v buducnosti upravovat:** ak niekedy
pridate dalsiu kontrolu porovnavajucu text pred/po, pouzite multiset/bag
porovnanie, nie pozicny diff — inak narazite na presne tento isty falosny
poplach.

## 8. Vystup — report

Kazdy ostry beh zapise `reports/eic-correction-report-<timestamp>.json` a
`.txt` — rovnaky konvencny format ako `Code/EDC ZPÚ` a `Code/EDC AGREG` uz
pouzivaju (pocty + detail za kazdy subor). Obsahuje:

- `unaffected` / `corrected` / `partially_corrected` / `unresolved` / `error`
  pocty,
- za kazdy opraveny subor: povodny interny id → spravny EIC + ktorym kanalom
  (`text` / `widget`) bol opraveny,
- `unresolved` zoznam pre subory, ktore treba dohladat rucne (chybajuci
  zaznam v CSV exporte).

Ak sa niektory PDF nepodari otvorit alebo nastane chyba pocas opravy, dany
subor sa nahlasi so `status: error` a plnym traceback-om — zvysok davky
pobezi dalej.

## 9. Priklad realneho behu (worked example, s ilustracnymi datami)

*(Cisla nizsie su z realnej validacnej davky spustenej pri vyvoji tohto
nastroja; mena/id v tomto README su nahradene fiktivnymi hodnotami — ziadne
skutocne osobne udaje sa v tomto repozitari nenachadzaju.)*

Prvy validacny beh (30 realnych podpisanych PDF): **17 opravenych**, 13 uz
bolo v poriadku, 0 chyb. Adversarial code review pred nasadenim odhalil dva
skutocne bugy: (a) widget-blindnost popisana v sekcii 3 — naivny redact-only
pristup by tiche poskodil widget-backed hodnoty, a (b) mrtvy (nepouzivany)
vyraz na porovnavanie farby pisma s chybou v poradi operatorov Pythonu (mix
`int`/`float` v bitovom `&`) — oba opravene predtym, nez sa dostali do
produkcie.

Nezavisla krizova kontrola: vysledky nastroja boli porovnane s realnym,
uzivatelom dodanym zoznamom "chybnych EIC" (e-mail + dva nespravne id za
osobu) ako nezavisly sanity-check. Zhodovali sa presne — vratane toho, ktore
subory **NEboli** v skutocnosti postihnute. (Technika hodna zopakovania: ak
mate nezavisly zdroj dat na overenie, pouzite ho — nielen dovera vo vlastny
vystup nastroja.)

Pri tejto kontrole sa odhalil aj druhy realny pripad: dvaja rozni ludia s tym
istym menom (rovnaka osoba, dve rozne fyzicke lokality/EIC dvojice) — naivne
stahovanie podla mena vytvorilo koliziu nazvov suborov a ticho zahodilo jeden
z dvoch dokumentov. **Poucenie:** nepredpokladajte jeden podpisany dokument
na osobu-meno; ak moze nastat kolizia mena, rozliste podla obsahu (skutocne
EIC id alebo nazov lokality z mapovacieho exportu) a subory premenujte tak,
aby lokalita bola v nazve explicitna.

Finalny ostry beh: **37 dokumentov celkovo, 32 opravenych, 5 uz v poriadku, 0
nevyriesenych, 0 chyb**, vsetky nezavisle znovu-validovane cez
`validate_eic_correction.py`.

## 10. Zavislosti

```bash
pip3 install --break-system-packages pymupdf
```

CLI rozhranie oboch skriptov je nezavisle na tomto repozitari — mozu sa
spustit z akehokolvek pracovneho priecinka, pokial dostanu spravne `--input`
/ `--csv` / `--output` / `--report` / `--originals` / `--corrected` cesty.

**Nikdy necommitujte** realne PDF, CSV exporty s realnymi menami/EIC, ani
report JSON/TXT subory z ostrych behov — vid `.gitignore` v koreni tohto
repozitara (uz pokryva `*.csv`, `reports/`, `downloads/`; PDF subory pridajte
do vlastneho gitignore-ovaneho priecinka, ak ich sem umiestnite).
