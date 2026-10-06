# Koranens Budskap

Fristående webbapp som visar Koranen (30 PDF-filer, en per juz) som en fysisk bok
med riktig sidvändning. Sidorna ritas av PDF.js direkt ur PDF-filerna – inget är
omritat eller ersatt med HTML-text.

## Starta

Dubbelklicka på `start.cmd`, eller:

```bash
node serve.mjs 8080
```

Öppna sedan <http://localhost:8080>. Ingen installation, inget byggsteg och ingen
internetanslutning behövs (PDF.js ligger i `vendor/pdfjs`). Appen måste köras via
servern – inte genom att dubbelklicka på `index.html`.

## Publicera (GitHub → Cloudflare Pages)

Sajten är helt statisk: inget byggsteg, utdatamappen är projektets rot. Allt som
behövs ligger i Git-repot, även PDF-filerna (webbkopiorna, se nedan).

## PDF-filerna: original och webbkopior

| Mapp | Innehåll | I Git |
| --- | --- | --- |
| `public/quran/` | Originalen från tryckeriet, 55–115 MB per juz (2,2 GB) | nej |
| `public/quran-web/` | Webbkopiorna som appen visar, 233 MB totalt, största filen 22,5 MB | ja |

Originalen är för stora för webben (Cloudflare Pages tar högst 25 MB per fil,
GitHub högst 100 MB). De är stora av ett enda skäl: InDesign har lagt in hela den
arabiska sidan en gång per textrad, beskuren till raden, så varje ordkontur står
utskriven ungefär femton gånger per sida.

`tools/slim-pdf.mjs` skriver en kopia där varje sådan följd av konturer lagras en
gång och ritas på de ställen där den stod:

```bash
node tools/slim-pdf.mjs --all
```

- Originalen läses bara, de ändras aldrig.
- Inget rastreras, ritas om eller flyttas. Text, typsnitt, färger och allt annat
  kopieras byte för byte; sidorna är fortfarande vektorgrafik och lika skarpa i zoom.
- Kopian är inte bit-exakt: två kopior av samma kontur skiljer sig i sista
  siffran InDesign skrev (0,001 punkt = 0,0004 mm), och webbkopian använder den
  första för alla. Det är mindre än vad webbläsarens egen kantutjämning varierar
  när samma sida ritas en tvåtusendels pixel förskjuten.
- Efter skrivningen läser verktyget tillbaka kopian, skriver ut de lagrade
  konturerna där de används och jämför med originalets sidbeskrivning ord för
  ord. Största skillnaden skrivs ut; en fil som avviker mer än 0,0025 punkt
  eller på något annat sätt underkänns.

För att visa originalen i stället: sätt `pdfBase` i `src/config.js` till
`./public/quran/`.

## Bläddra

Appen startar med boken stängd. Pärmarna är styva skivor, lite större än sidorna
och tydligt tjockare, som svänger kring bokryggen i stället för att böjas.
Omslagsbilden (`public/cover/cover.jpg`) används på båda pärmarna: baksidan
exakt som bilden, framsidan spegelvänd så att ornamentet hamnar vid ryggen, med
titelringen rättvänd. Bild och beskärning ställs in under `cover` i
`src/config.js`, pärmens ljusa färger med `--board-*` i `styles.css`.

| Handling | Resultat |
| --- | --- |
| Klick på den stängda boken (eller dra i pärmens kant) | Pärmen svänger upp och boken öppnas |
| Bläddra förbi första eller sista uppslaget | Boken stängs med fram- respektive baksidan upp |
| Dra i vänster sidkant åt höger | Nästa uppslag (arabisk läsriktning) |
| Dra i höger sidkant åt vänster | Föregående uppslag |
| Släpp efter halva vägen / snabb svepning | Sidan vänds klart |
| Släpp tidigare | Sidan fjädrar tillbaka |
| Klick på en sidkant, `←` / `→`, `PageDown` / `PageUp` | Sidan vänds av sig själv |
| Håll musen över en sidkant | Kanten lyfter lite |
| Knapparna ‹ › längst ned | Nästa / föregående uppslag. Snabba klick köas – varje klick räknas och bladen vänds fortare ju fler som väntar |
| Dubbelklicka / dubbeltryck på en sida | Kameran zoomar in mot sidan till full bredd; scrolla för att läsa |
| Dubbelklick igen, `Esc` eller "Visa uppslag" | Zoomar ut till uppslaget |

## Innehåll: 30 juz som en bok

De 30 filerna `JUZ1-SWEDEN.pdf` … `JUZ30-SWEDEN.pdf` visas som en
sammanhängande bok: 606 PDF-sidor mellan pärmarna. Listan finns i `volumes` i
`src/config.js`. En fil öppnas först när någon av dess sidor behövs, bara de
delar som sidorna använder hämtas, och högst fyra filer hålls öppna samtidigt.
Under inställningar (⚙) finns "Gå till juz" och "Gå till sida" (det tryckta
sidnumret).

## Navigera i Koranen

Knappen "Navigera i Koranen" mitt i toppen öppnar en panel med flikarna Sura,
Vers, Juz och Sida, var och en med sökfält (Enter går till första träffen; i
Vers-fliken går det att skriva t.ex. `2:255`). Panelen finns bara på skärmen
medan den är öppen och stängs med ×, Esc, klick utanför eller när man valt något.

Boken bläddras fram till målet: en ström av blad vänds i snabb följd med flera
i luften samtidigt (fler ju längre bort målet ligger, och så länge målsidorna
ännu renderas), och ett sista blad landar mjukt på rätt uppslag. Hela hoppet
siktar på högst tre sekunder (`jumpMaxMs`): har bläddringen eller renderingen
tagit lång tid vänds sista bladet fortare. Från stängd bok svänger pärmen upp
direkt mot målet. Antal blad och tempo ställs med `riffle*` i `src/config.js`.

Sidor som behövs nu (uppslaget som visas, målet för ett hopp) renderas före
förladdningen av grannuppslag, och förladdningen vilar medan ett blad är i luften.

Vilken vers som står på vilken sida ligger i `data/quran-data.js`. Filen är
framtagen ur PDF:ernas egen text (versnumren i översättningen) och kontrollerad
mot antalet verser per sura: alla 6 236 verser finns med. `src/quran-index.js`
är stället där resten av appen frågar "var står versen?" och "vad står på sidan?".

## Mobil och surfplatta

Samma bok, visad på två sätt (`src/mobile-reader.js` på små skärmar, boken med
uppslag annars). Båda visar samma ställe i boken, samma versmarkeringar och samma
spelare; byter man storlek eller vrider enheten fortsätter man där man var.

**När visas vad** (`layout` i `src/config.js`, efter fönstrets faktiska mått):

| Skärm | Visning |
| --- | --- |
| Stående och smalare än 900 px (telefoner, iPad stående) | en sida i taget |
| Lägre än 600 px (telefon liggande) | en sida i taget, så bred som ryms (högst 640 px), läses uppifrån och ned |
| Smalare än 600 px oavsett läge | en sida i taget |
| Allt annat (desktop, iPad liggande) | boken med två sidor, som tidigare |

**En sida i taget:** sidan är så stor som skärmen tillåter, 10 px från kanterna och
fri från notch, Dynamic Island och hemindikator (`env(safe-area-inset-*)`). Bara
aktuell sida och dess två grannar hålls renderade.

| Gest | Resultat |
| --- | --- |
| Svep åt höger / vänster | nästa / föregående sida (arabisk läsriktning); sidan glider in och landar |
| Nyp | zoom kring fingrarna (upp till 4×); sidan renderas om skarpt när zoomen stannat |
| Dubbeltryck | zooma in där, eller tillbaka ut |
| Dra när sidan är inzoomad | flytta runt på sidan – sidan byts aldrig av misstag |
| Tryck | visa / dölj toppfältet och spelaren (de döljs själva efter ett par sekunder) |
| Håll på en vers | uppläsningen börjar från den versen |

Toppfältet har bara namnet och en navigeringsikon som öppnar "Navigera i
Koranen" som ett ark nedifrån (Sura, Vers, Juz, Sida och "Gå till sida"). Spelaren
är en liten list längst ned som öppnas till hela spelaren (tidslinje, upprepa
versen, hastighet, recitatör) – samma knappar som glider till sina nya platser.

## Uppläsning och versmarkering

Spelaren längst ned läser upp en sura i taget. Play startar vid första versen på
uppslaget, ⏮ / ⏭ stegar en vers, och ett klick på en vers (arabisk text eller
översättning) börjar läsa därifrån. Versen som läses får en grå skugga över både
sin arabiska text och sin översättning, och boken bläddrar själv när uppläsningen
går över till nästa uppslag. Bläddrar du bort slutar boken följa med tills du är
tillbaka vid versen som läses.

- **Recitatörer:** listan, ljudfilerna och verstiderna kommer från Quran.com:s
  ljud-API (`api.qurancdn.com`, `src/reciters.js`) – för varje recitatör och sura
  ger det ljudfilen tillsammans med tider gjorda för just den filen, så
  versmarkeringen följer vem som än läser. API:t har 14; två är bortvalda (en
  "Kids repeat"-version med trasiga tider och en dubblett av Alafasy), 12 kan väljas.
  Mishary al-Afasy spelas som förut från Tarteels CDN. Listan sparas i webbläsaren
  (fungerar utan nät med senast kända lista), liksom valet av recitatör. Byte av
  recitatör behåller sura och vers.
- **Ljud:** inget ligger i projektet. Varje suras ljudfil hämtas första gången den
  spelas – den strömmas direkt och en kopia sparas samtidigt i webbläsarens egen
  lagring (Cache Storage). Nästa gång spelas suran från den kopian.
- **Verstider:** hämtas per sura och recitatör (`audio.timingsUrl`) och sparas på
  samma sätt. De innehåller även tider per ord, som inte används än.
- **Versytor:** `data/regions/juz-N.json`, en fil per juz som laddas när en sida
  i den visas. De räknas fram ur PDF:erna av `tools/build-regions.mjs`
  (`node tools/build-regions.mjs`, cirka tio minuter): arabiskan ur versslutens
  rosetter och radrutnätet, översättningen ur textlagrets versnummer.

## Skärmärken

PDF-sidorna är tryckoriginal med skärmärken i hörnen, utanför den riktiga
sidytan (TrimBox). `printerMarks` i `src/config.js` anger vilka PDF-sidor som
ritas utan dem (`pages: 'all'` = hela boken, eller en lista med sidnummer). PDF-filerna ändras inte
och inget målas över: de åtta linjerna ritas helt enkelt aldrig
(`src/printer-marks.js`). Ta bort `printerMarks` för att visa märkena igen.

## Struktur

```
index.html              sidans DOM: två .page med canvas + lager, plus overlay-canvas
styles.css              skrivbord, bok, pärm, sidbunt, UI
serve.mjs / start.cmd   lokal server (stöd för HTTP Range så PDF.js kan strömma PDF:en)
data/                   vilken vers som står var (quran-data.js) och versytor (regions/)
tools/                  build-regions.mjs (versytor), slim-pdf.mjs (webbkopior av PDF:erna)
src/
  config.js             alla inställningar: sidordning, ljus, böjning, fjädrar
  main.js               startar appen, tangentbord, inställningspanel
  pdf-source.js         PDF.js: laddar PDF:en, renderar sida -> canvas, cache
  book-model.js         vilken PDF-sida som ligger var (uppslag, blad, RTL)
  book-view.js          den vilande boken i DOM: byter canvas i sidorna
  zoom-view.js          läszoom: boken skalas/panoreras mot sidan, som renderas om skarpt av PDF.js
  navigator.js          panelen "Navigera i Koranen" (sura / vers / juz / sida; ark på mobil)
  mobile-reader.js      små skärmar: en sida i taget, svep, nyp-zoom, panorering
  audio-player.js       uppläsning: sura för sura från CDN, sparad i webbläsaren
  player-ui.js          spelarens ikoner, play/paus-morf, mini- och helspelare, tidslinje
  reciters.js           recitatörerna (Quran.com:s ljud-API), sparad lista
  reciter-picker.js     "Välj recitatör"
  verse-regions.js      laddar versytorna (data/regions) för de juz som visas
  printer-marks.js      utelämnar tryckeriets skärmärken när en sida ritas
  quran-index.js        uppslagning surah/ayah <-> PDF-sida <-> regioner
  layers/interaction-layers.js   hotspot- och highlight-lager ovanpå canvasen
  flip/curl-solver.js   bladets form (ren matematik, körbar i Node)
  flip/flip-renderer.js WebGL2: böjt blad, ljus och skuggor
  flip/flip-controller.js   mus/touch/tangentbord -> bladets rörelse
```

## Så fungerar sidvändningen

PDF-sidan ändras aldrig. De canvas-element som PDF.js har renderat laddas upp som
texturer och läggs på ett böjt nät – det är bara presentationen som deformeras.

1. **Greppunkt.** När du tar i en sidkant blir den punkten bladets "handtag".
   Pekaren anger var handtaget ska synas.
2. **Form (`curl-solver.js`).** Bladet är en yta som inte kan töjas. Allt på
   ryggsidan av en rak *viklinje* ligger kvar i boken, resten böjs uppåt.
   Viklinjen trycks alltid så nära ryggen som bindningen tillåter och vrider sig
   runt ryggens övre eller nedre ände när du drar snett – därför lyfter hörnet
   först och resten följer efter. Böjvinkeln växer mjukt från viklinjen tills den
   når en maxvinkel, som löses ut så att handtaget hamnar exakt under pekaren:
   0° = sidan ligger kvar, 90° = sidan står upp, 180° = sidan ligger på andra sidan.
   Kurvan är som mjukast mitt i vändningen och planar ut när bladet landar.
3. **Rendering (`flip-renderer.js`).** Nätet ritas i en genomskinlig WebGL-canvas
   ovanpå boken med en kamera rakt ovanifrån (perspektiv: upplyfta delar kommer
   närmare). Framsidan visar sidan som låg där, baksidan visar sidan som landar på
   andra sidan. Ljuset räknas per pixel från bladets lutning, bladet projiceras
   längs ljuset till en mjuk skugga på sidan under, plus en kontaktskugga rakt under.
4. **Rörelse (`flip-controller.js`).** Under drag följer handtaget pekaren. Vid
   släpp tar en kritiskt dämpad fjäder över med pekarens hastighet. Tangentbord och
   klick följer en tidsstyrd båge.
5. **Byte av sidor.** När bladet lyfter byts DOM-sidan mot sidan som låg under;
   när det landar byts sidan på andra sidan. I vila visas bara DOM-sidorna, 1:1
   mot skärmens pixlar.

Bokryggens skuggning definieras en gång (`pageShade` i `config.js`) och används
både av CSS-lagret på de vilande sidorna och av WebGL-bladet, så sidan ser
likadan ut i ögonblicket den lyfter.

## Sidordning (RTL)

`book.leadingBlanks` i `config.js` styr hur PDF-sidorna läggs på uppslag.
Med `1` ligger PDF-sida 1 ensam till vänster (framsidan av första bladet) och
därefter `2|3`, `4|5` … (höger|vänster) – då hamnar Al-Fatihah och början av
Al-Baqarah mitt emot varandra som i en tryckt mushaf. Sätt `0` för `1|2`, `3|4` …

## Lager ovanpå PDF:en

```html
<article class="page">
  <canvas class="pdf-canvas"></canvas>   <!-- PDF.js-renderingen, orörd -->
  <div class="highlight-layer"></div>    <!-- markeringar (spelas upp, sökträff) -->
  <div class="hotspot-layer"></div>      <!-- osynliga klickytor -->
  <div class="page-shade"></div>         <!-- bokryggens skuggning -->
</article>
```

Versregioner läggs i `VERSE_REGIONS` i `data/page-meta.js` med normaliserade
koordinater (0–1 av PDF-sidan):

```js
{ pdfPage: 5, surah: 2, ayah: 17, areas: [{ x: 0.12, y: 0.18, w: 0.31, h: 0.05 }] }
```

- Klick på en region skickar händelsen `verse:activate` med
  `{ surah, ayah, key, pdfPage }` (lyssnare finns i `main.js`).
- `view.highlighted` (en `Set` med nycklar som `"2:17"`) + `view.refreshLayers()`
  ritar markeringar.
- `QuranIndex` svarar på "vilken sida ligger versen på" och "vad finns på sidan".
  Nyckeln `surah:ayah` är samma som QUL/Tarteel använder, så ljud och sök kan
  kopplas dit utan att röra bok- eller PDF-koden.

## Begränsningar

- Sidvändningen kräver WebGL2. Saknas det byts uppslag utan animation.
- Bladet har parallella böjlinjer (cylindrisk böjning). Det ger hörnlyft och
  mjuk kurva men inte dubbelkrökta former som ett riktigt papper kan få.
- Sidorna är tung vektorgrafik. Första uppslaget tar någon sekund; närliggande
  uppslag förrenderas i bakgrunden. Bläddrar man fortare än så går nästa blad inte att
  lyfta förrän dess sidor är klara.
- Medan bladet är i luften visas det via WebGL och kan vara marginellt mjukare
  än den vilande sidan.
