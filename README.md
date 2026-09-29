# Plagiatsprüfer

Kostenlose, selbst gehostete Plagiatsprüfung im Stil von PlagAware: Text einfügen oder Datei hochladen,
die App sucht passende Quellen im Internet, auf Wikipedia und in wissenschaftlichen Publikationen und
zeigt im Bericht genau an, **welche Stellen** woher stammen könnten.

## Funktionen

- **Eingabe:** Text einfügen oder Datei hochladen (PDF, DOCX, TXT, MD, HTML, RTF) – auch per Drag & Drop.
  Dateien werden im Browser gelesen.
- **Quellensuche:** Aus dem Text werden markante Wortfolgen ausgewählt und gesucht:
  - Internet (Brave, Google/Serper, Google Programmable Search, SearXNG oder – ohne Schlüssel – DuckDuckGo)
  - Wikipedia (de/en, automatisch nach Sprache)
  - Wissenschaftliche Arbeiten (Titel & Abstracts über OpenAlex)
  - Eigene Vergleichsdokumente (z. B. frühere Arbeiten, Arbeiten anderer Schüler/Studierender)
- **Vollständiger Vergleich:** Die gefundenen Seiten (HTML und PDF) werden komplett geladen und mit dem Text
  verglichen. Erkannt werden:
  - **Wörtliche Übernahmen** (n-Gramm-Abgleich mit Verlängerung zur längsten Übereinstimmung)
  - **Leicht veränderte Passagen** (einzelne Wörter ersetzt, eingefügt oder gelöscht)
  - **Paraphrasen** (umformulierte Sätze, über Wortstämme und Wortpaare)
  - **Zitate** in Anführungszeichen werden grau markiert und nicht als Plagiat gewertet (abschaltbar)
- **Bericht:** Gesamtprozentsatz, Anteil pro Quelle, farbige Markierungen im Text (eine Farbe pro Quelle),
  Klick auf eine Markierung zeigt deinen Text und die Quelle nebeneinander mit hervorgehobenen
  Übereinstimmungen, Link zur Quelle, Blättern durch alle Stellen einer Quelle, Druck/PDF-Export.
- **Ignorieren (vor der Prüfung):** Literaturverzeichnis wird automatisch erkannt und nicht geprüft;
  eigene Textstellen/Phrasen (z. B. Aufgabenstellung) können ausgeschlossen werden; Domains ausschließen.
- **Ignorieren (im Bericht):** einzelne Stellen ignorieren oder als Zitat werten, ganze Quellen ignorieren
  oder als „korrekt zitiert“ werten – die Prozentwerte werden sofort neu berechnet, alles ist rückgängig machbar.
- **Synopse:** dein Text und die komplette Quelle nebeneinander, Klick auf eine Markierung springt zur
  Gegenstelle.
- **Verteilungsbalken** zeigt, wo im Dokument die Übereinstimmungen liegen; Filter nach Art der Übereinstimmung.
- **Quellenangabe erkannt:** Wird eine Quelle (Domain, DOI oder Titel) im Text bzw. Literaturverzeichnis genannt,
  wird sie mit „im Text/Literaturverzeichnis genannt“ gekennzeichnet.
- **Verlauf:** die letzten 25 Prüfungen inkl. deiner Anpassungen – nur lokal im Browser gespeichert.
- **Einstellungen:** Prüftiefe (Schnell/Standard/Gründlich) und Empfindlichkeit.
- **Datenschutz:** Keine Datenbank, keine Anmeldung. Der Vergleich läuft im Browser; an den Server gehen nur
  die Suchanfragen (kurze Wortfolgen) und die URLs der zu ladenden Quellen.

## Auf Vercel veröffentlichen (kostenlos)

1. Auf [vercel.com](https://vercel.com) mit GitHub anmelden.
2. **Add New → Project** → dieses Repository importieren. Framework „Next.js“ wird automatisch erkannt.
3. (Empfohlen) Unter **Environment Variables** einen Such-API-Schlüssel eintragen (siehe unten).
4. **Deploy** klicken. Fertig – die Seite läuft unter `https://<projektname>.vercel.app`.

Der kostenlose Hobby-Plan von Vercel reicht aus. Alternativ läuft die App auf jedem Hoster mit Node.js 20+
(z. B. Netlify, Render, Railway oder eigener Server: `npm install && npm run build && npm start`).

## Such-API-Schlüssel (optional, aber empfohlen)

Ohne Schlüssel nutzt die App DuckDuckGo. Das funktioniert, wird aber von Servern aus (auch Vercel) oft
gedrosselt oder blockiert. Wikipedia und OpenAlex funktionieren immer ohne Schlüssel.
Für eine gründliche Websuche **einen** dieser Dienste eintragen (mehrere sind möglich, dann wird der erste
funktionierende genutzt):

| Variable | Dienst | Kostenloses Kontingent |
| --- | --- | --- |
| `BRAVE_API_KEY` | [Brave Search API](https://brave.com/search/api/) | monatliches Gratis-Guthaben |
| `SERPER_API_KEY` | [serper.dev](https://serper.dev) (Google-Ergebnisse) | 2.500 Anfragen einmalig |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | [Google Programmable Search](https://programmablesearchengine.google.com) | 100 Anfragen pro Tag |
| `SEARXNG_URL` | eigene [SearXNG](https://docs.searxng.org)-Instanz (JSON-Format aktivieren) | unbegrenzt |
| `OPENALEX_MAILTO` | E-Mail für den schnelleren „polite pool“ von OpenAlex | – |

Eine Prüfung im Modus „Standard“ braucht ca. 20 Suchanfragen, „Schnell“ 8 und „Gründlich“ 45.
Die Anbieter und Konditionen können sich ändern – bitte auf deren Seiten prüfen.

Lokal: `.env.example` nach `.env.local` kopieren und ausfüllen.

## Lokal entwickeln

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # Tests der Vergleichs-Engine
npm run build
```

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `lib/compare.ts` | Vergleichs-Engine (wörtlich, leicht verändert, Paraphrase) und Berichtserstellung |
| `lib/queries.ts` | Auswahl der Suchanfragen aus dem Text |
| `lib/text.ts` | Tokenisierung, Satztrennung, Stoppwörter, Stemming, Zitaterkennung |
| `lib/client/runCheck.ts` | Ablauf der Prüfung im Browser (Suche → Quellen laden → Vergleich) |
| `lib/search/providers.ts` | Suchanbieter |
| `lib/extract.ts` | Laden von Webseiten/PDFs und Textextraktion (mit Schutz vor Zugriffen auf interne Adressen) |
| `app/api/*` | Serverless-Routen für Suche und Laden der Quellen |
| `components/ReportView.tsx` | Bericht mit Markierungen und Quellenvergleich |

## Grenzen

Kommerzielle Dienste wie Turnitin haben zusätzlich Zugriff auf nicht öffentliche Datenbanken
(eingereichte Hausarbeiten, kostenpflichtige Zeitschriften). Solche Quellen kann diese App nur finden,
wenn sie öffentlich im Netz stehen oder als Vergleichsdokument hochgeladen werden. Texte, die per KI
oder Übersetzung stark umgeschrieben wurden, sind für jede automatische Prüfung schwer zu erkennen.
Das Ergebnis ist immer ein Hinweis, kein Beweis.
