# Quran Book V1

Fristående Quran-webbapp. Original-PDF:en (`public/quran/JUZ1-SWEDEN.pdf`) renderas
oredigerad med PDF.js och presenteras som en fysisk bok med riktig sidvändning.

## Starta

Dubbelklicka på `start.cmd`, eller:

```bash
node serve.mjs 8080
```

Öppna sedan <http://localhost:8080>. Ingen installation, inget byggsteg och ingen
internetanslutning behövs (PDF.js ligger i `vendor/pdfjs`). Appen måste köras via
servern – inte genom att dubbelklicka på `index.html`.

## Publicera (GitHub → Cloudflare Pages)

Sajten är helt statisk: inget byggsteg, utdatamappen är projektets rot.

PDF-filerna ligger **inte** i Git-repot (`.gitignore`). De är 55–115 MB styck;
Cloudflare Pages tar högst 25 MB per fil och GitHub högst 100 MB. Lägg de 30
filerna (`JUZ1-SWEDEN.pdf` … `JUZ30-SWEDEN.pdf`) i en publik lagringsyta, till
exempel Cloudflare R2, som tillåter anrop från sajtens adress (CORS) och
delhämtning (Range), och skriv dess adress i `PDF_HOST` överst i
`src/config.js`. Lokalt (`localhost`) läses filerna alltid från `public/quran/`.

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

De 30 filerna `public/quran/JUZ1-SWEDEN.pdf` … `JUZ30-SWEDEN.pdf` (oredigerade
kopior) visas som en sammanhängande bok: 606 PDF-sidor mellan pärmarna. Listan
finns i `volumes` i `src/config.js`. En fil öppnas först när någon av dess sidor
behövs, bara de delar som sidorna använder hämtas, och högst fyra filer hålls
öppna samtidigt. Under inställningar (⚙) finns "Gå till juz" och "Gå till sida"
(det tryckta sidnumret).

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

## Mobil

På en smal skärm i stående läge (`layout.singlePageBelow`, 760 px) visas en sida
i taget. Svep åt höger för nästa sida och åt vänster för föregående (arabisk
läsriktning); boken går först till uppslagets andra sida och vänder sedan blad.
Helskärmsknappen (⛶) uppe till höger går till helskärm och låser skärmen i
liggande läge, där båda sidorna visas bredvid varandra. På bredare skärmar –
alltid på desktop – visas två sidor.

Sidorna renderas finare än de visas (`render.minPixelRatio`) och skalas ned av
webbläsaren, så att skrift och ornament ser lika rena ut i uppslagsvyn som inzoomat.

## Uppläsning och versmarkering

Spelaren längst ned läser upp en sura i taget. Play startar vid första versen på
uppslaget, ⏮ / ⏭ stegar en vers, och ett klick på en vers (arabisk text eller
översättning) börjar läsa därifrån. Versen som läses får en grå skugga över både
sin arabiska text och sin översättning, och boken bläddrar själv när uppläsningen
går över till nästa uppslag. Bläddrar du bort slutar boken följa med tills du är
tillbaka vid versen som läses.

- **Ljud:** inget ligger i projektet. Varje suras ljudfil hämtas från Tarteels CDN
  (`audio.surahUrl` i `src/config.js`) första gången den spelas – den strömmas
  direkt och en kopia sparas samtidigt i webbläsarens egen lagring (Cache
  Storage). Nästa gång spelas suran från den kopian.
- **Verstider:** hämtas per sura från Quran.com-API:t (`audio.timingsUrl`) och
  sparas på samma sätt. De innehåller även tider per ord, som inte används än.
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
data/page-meta.js       sidmetadata och (ännu tomma) versregioner
src/
  config.js             alla inställningar: sidordning, ljus, böjning, fjädrar
  main.js               startar appen, tangentbord, inställningspanel
  pdf-source.js         PDF.js: laddar PDF:en, renderar sida -> canvas, cache
  book-model.js         vilken PDF-sida som ligger var (uppslag, blad, RTL)
  book-view.js          den vilande boken i DOM: byter canvas i sidorna
  zoom-view.js          läszoom: boken skalas/panoreras mot sidan, som renderas om skarpt av PDF.js
  navigator.js          panelen "Navigera i Koranen" (sura / vers / juz / sida)
  audio-player.js       uppläsning: sura för sura från CDN, sparad i webbläsaren
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

Ljud och sök är inte implementerade.

## Begränsningar

- Sidvändningen kräver WebGL2. Saknas det byts uppslag utan animation.
- Mobil visar fortfarande två sidor (nedskalat). En-sida-läge är inte byggt.
- Bladet har parallella böjlinjer (cylindrisk böjning). Det ger hörnlyft och
  mjuk kurva men inte dubbelkrökta former som ett riktigt papper kan få.
- PDF:en är tung (ca 100 MB). Första uppslaget tar några sekunder; närliggande
  uppslag förrenderas i bakgrunden. Bläddrar man fortare än så går nästa blad inte att
  lyfta förrän dess sidor är klara.
- PDF-sidorna visas helt obeskurna, så PDF:ens skärmärken i hörnen syns.
- Medan bladet är i luften visas det via WebGL och kan vara marginellt mjukare
  än den vilande sidan.
